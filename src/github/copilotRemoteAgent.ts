/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import vscode from 'vscode';
import { Repository } from '../api/api';
import { AuthProvider } from '../common/authentication';
import { COPILOT_LOGINS } from '../common/copilot';
import { commands } from '../common/executeCommands';
import { Disposable } from '../common/lifecycle';
import { GitHubRemote, Remote } from '../common/remote';
import { CODING_AGENT, CODING_AGENT_AUTO_COMMIT_AND_PUSH, CODING_AGENT_ENABLED } from '../common/settingKeys';
import { toOpenPullRequestWebviewUri } from '../common/uri';
import { CopilotApi, RemoteAgentJobPayload } from './copilotApi';
import { CopilotPRWatcher, CopilotStateModel } from './copilotPrWatcher';
import { CredentialStore } from './credentials';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { RepositoriesManager } from './repositoriesManager';
import { GitHubRepository } from './githubRepository';
import Logger from '../common/logger';

type RemoteAgentSuccessResult = { link: string; state: 'success'; number: number; webviewUri: vscode.Uri; llmDetails: string };
type RemoteAgentErrorResult = { error: string; state: 'error' };
type RemoteAgentResult = RemoteAgentSuccessResult | RemoteAgentErrorResult;

export interface IAPISessionLogs {
	sessionId: string;
	logs: string;
}

export interface ICopilotRemoteAgentCommandArgs {
	userPrompt: string;
	summary?: string;
	source?: string;
}

const LEARN_MORE = vscode.l10n.t('Learn about Coding Agent');
// Without Pending Changes
const CONTINUE = vscode.l10n.t('Continue');
// With Pending Changes
const PUSH_CHANGES = vscode.l10n.t('Include changes');
const CONTINUE_WITHOUT_PUSHING = vscode.l10n.t('Ignore changes');

export class CopilotRemoteAgentManager extends Disposable {
	public static ID = 'CopilotRemoteAgentManager';
	private readonly workflowRunUrlBase = 'https://github.com/microsoft/vscode/actions/runs/';

	private readonly _stateModel: CopilotStateModel;
	private readonly _onDidChangeStates = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeStates = this._onDidChangeStates.event;
	private readonly _onDidChangeNotifications = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeNotifications = this._onDidChangeNotifications.event;
	private readonly _onDidCreatePullRequest = this._register(new vscode.EventEmitter<number>());
	readonly onDidCreatePullRequest = this._onDidCreatePullRequest.event;

	constructor(private credentialStore: CredentialStore, public repositoriesManager: RepositoriesManager) {
		super();
		this._register(this.credentialStore.onDidChangeSessions((e: vscode.AuthenticationSessionsChangeEvent) => {
			if (e.provider.id === 'github') {
				this._copilotApiPromise = undefined; // Invalidate cached session
			}
		}));

		this._stateModel = new CopilotStateModel();
		this._register(new CopilotPRWatcher(this.repositoriesManager, this._stateModel));
		this._register(this._stateModel.onDidChangeStates(() => this._onDidChangeStates.fire()));
		this._register(this._stateModel.onDidChangeNotifications(() => this._onDidChangeNotifications.fire()));

		this._register(this.repositoriesManager.onDidChangeFolderRepositories((event) => {
			if (event.added) {
				this._register(event.added.onDidChangeAssignableUsers(() => {
					this.updateAssignabilityContext();
				}));
			}
			this.updateAssignabilityContext();
		}));
		this.repositoriesManager.folderManagers.forEach(manager => {
			this._register(manager.onDidChangeAssignableUsers(() => {
				this.updateAssignabilityContext();
			}));
		});
		this._register(vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(CODING_AGENT)) {
				this.updateAssignabilityContext();
			}
		}));

		// Set initial context
		this.updateAssignabilityContext();
	}

	private _copilotApiPromise: Promise<CopilotApi | undefined> | undefined;
	private get copilotApi(): Promise<CopilotApi | undefined> {
		if (!this._copilotApiPromise) {
			this._copilotApiPromise = this.initializeCopilotApi();
		}
		return this._copilotApiPromise;
	}

	private async initializeCopilotApi(): Promise<CopilotApi | undefined> {
		const gh = await this.credentialStore.getHubOrLogin(AuthProvider.github);
		const { token } = await gh?.octokit.api.auth() as { token: string };
		if (!token || !gh?.octokit) {
			return;
		}
		return new CopilotApi(gh.octokit, token);
	}

	enabled(): boolean {
		return vscode.workspace
			.getConfiguration(CODING_AGENT).get(CODING_AGENT_ENABLED, false);
	}

	async isAssignable(): Promise<boolean> {
		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			return false;
		}

		const { fm } = repoInfo;

		try {
			// Ensure assignable users are loaded
			await fm.getAssignableUsers();
			const allAssignableUsers = fm.getAllAssignableUsers();

			if (!allAssignableUsers) {
				return false;
			}

			// Check if any of the copilot logins are in the assignable users
			return allAssignableUsers.some(user => COPILOT_LOGINS.includes(user.login));
		} catch (error) {
			// If there's an error fetching assignable users, assume not assignable
			return false;
		}
	}

	async isAvailable(): Promise<boolean> {
		// Check if the manager is enabled, copilot API is available, and it's assignable
		if (!this.enabled()) {
			return false;
		}

		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			return false;
		}

		const copilotApi = await this.copilotApi;
		if (!copilotApi) {
			return false;
		}

		return await this.isAssignable();
	}

	private async updateAssignabilityContext(): Promise<void> {
		try {
			const available = await this.isAvailable();
			commands.setContext('copilotCodingAgentAssignable', available);
		} catch (error) {
			// Presume false
			commands.setContext('copilotCodingAgentAssignable', false);
		}
	}

	autoCommitAndPushEnabled(): boolean {
		return vscode.workspace
			.getConfiguration(CODING_AGENT).get(CODING_AGENT_AUTO_COMMIT_AND_PUSH, false);
	}

	async repoInfo(): Promise<{ owner: string; repo: string; baseRef: string; remote: GitHubRemote; repository: Repository; ghRepository: GitHubRepository; fm: FolderRepositoryManager } | undefined> {
		if (!this.repositoriesManager.folderManagers.length) {
			return;
		}
		const fm = this.repositoriesManager.folderManagers[0];
		const repository = fm?.repository;
		const ghRepository = fm?.gitHubRepositories.find(repo => repo.remote instanceof GitHubRemote) as GitHubRepository | undefined;
		if (!repository || !ghRepository) {
			return;
		}

		const baseRef = repository.state.HEAD?.name; // TODO: Consider edge cases
		const ghRemotes = await fm.getGitHubRemotes();
		if (!ghRemotes || ghRemotes.length === 0) {
			return;
		}

		const remote =
			ghRemotes.find(remote => remote.remoteName === 'origin')
			|| ghRemotes[0]; // Fallback to the first remote

		// Extract repo data from target remote
		const { owner, repositoryName: repo } = remote;
		if (!owner || !repo || !baseRef || !repository) {
			return;
		}
		return { owner, repo, baseRef, remote, repository, ghRepository, fm };
	}

	async commandImpl(args?: ICopilotRemoteAgentCommandArgs): Promise<string | undefined> {
		if (!args) {
			return;
		}

		const { userPrompt, summary, source } = args;
		if (!userPrompt || userPrompt.trim().length === 0) {
			return;
		}

		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			return;
		}
		const { repository, owner, repo } = repoInfo;
		const repoName = `${owner}/${repo}`;
		const hasChanges = repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0;
		const learnMoreCb = async () => {
			vscode.env.openExternal(vscode.Uri.parse('https://docs.github.com/copilot/using-github-copilot/coding-agent'));
		};

		let autoPushAndCommit = false;
		const message = vscode.l10n.t('GitHub Coding Agent will continue your work in \'{0}\'', repoName);
		if (source !== 'prompt' && hasChanges && this.autoCommitAndPushEnabled()) {
			const modalResult = await vscode.window.showInformationMessage(
				message,
				{
					modal: true,
					detail: vscode.l10n.t('Local changes detected'),
				},
				PUSH_CHANGES,
				CONTINUE_WITHOUT_PUSHING,
				LEARN_MORE,
			);

			if (!modalResult) {
				return;
			}

			if (modalResult === LEARN_MORE) {
				learnMoreCb();
				return;
			}

			if (modalResult === PUSH_CHANGES) {
				autoPushAndCommit = true;
			}
		} else {
			const modalResult = await vscode.window.showInformationMessage(
				(source !== 'prompt' ? message : vscode.l10n.t('GitHub Coding Agent will implement the specification outlined in this prompt file')),
				{
					modal: true,
				},
				CONTINUE,
				LEARN_MORE,
			);
			if (!modalResult) {
				return;
			}

			if (modalResult === LEARN_MORE) {
				learnMoreCb();
				return;
			}
		}

		const result = await this.invokeRemoteAgent(
			userPrompt,
			summary || userPrompt,
			autoPushAndCommit,
		);

		if (result.state !== 'success') {
			vscode.window.showErrorMessage(result.error);
			return;
		}

		const { webviewUri, link, number } = result;

		if (source === 'prompt') {
			const VIEW = vscode.l10n.t('View');
			const finished = vscode.l10n.t('Coding agent has begun work on your prompt in #{0}', number);
			vscode.window.showInformationMessage(finished, VIEW).then((value) => {
				if (value === VIEW) {
					vscode.commands.executeCommand('vscode.open', webviewUri);
				}
			});
		}

		// allow-any-unicode-next-line
		return vscode.l10n.t('🚀 Coding agent will continue work in [#{0}]({1}).  Track progress [here]({2}).', number, link, webviewUri.toString());
	}

	async invokeRemoteAgent(prompt: string, problemContext: string, autoPushAndCommit = true): Promise<RemoteAgentResult> {
		const capiClient = await this.copilotApi;
		if (!capiClient) {
			return { error: vscode.l10n.t('Failed to initialize Copilot API'), state: 'error' };
		}

		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			return { error: vscode.l10n.t('No repository information found. Please open a workspace with a GitHub repository.'), state: 'error' };
		}
		const { owner, repo, remote, repository, ghRepository, baseRef } = repoInfo;

		// NOTE: This is as unobtrusive as possible with the current high-level APIs.
		// We only create a new branch and commit if there are staged or working changes.
		// This could be improved if we add lower-level APIs to our git extension (e.g. in-memory temp git index).

		let ref = baseRef;
		const hasChanges = autoPushAndCommit && (repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0);
		if (hasChanges) {
			if (!this.autoCommitAndPushEnabled()) {
				return { error: vscode.l10n.t('Uncommitted changes detected. Please commit or stash your changes before starting the remote agent. Enable \'{0}\' to push your changes automatically.', CODING_AGENT_AUTO_COMMIT_AND_PUSH), state: 'error' };
			}
			const asyncBranch = `copilot/vscode${Date.now()}`;
			try {
				await repository.createBranch(asyncBranch, true);
				await repository.add([]);
				if (repository.state.indexChanges.length > 0) {
					try {
						await repository.commit('Checkpoint for Copilot Agent async session');
					} catch (e) {
						// https://github.com/microsoft/vscode/pull/252263
						return { error: vscode.l10n.t('Could not \'git commit\' pending changes. If GPG signing or git hooks are enabled, please first commit or stash your changes and try again. ({0})', e.message), state: 'error' };
					}
				}
				await repository.push(remote.remoteName, asyncBranch, true);
				ref = asyncBranch;
			} catch (e) {
				return { error: vscode.l10n.t('Could not auto-push pending changes. Manually commit or stash your changes and try again. ({0})', e.message), state: 'error' };
			} finally {
				// Swap back to the original branch without your pending changes
				// TODO: Better if we show a confirmation dialog in chat
				if (repository.state.HEAD?.name !== baseRef) {
					// show notification asking the user if they want to switch back to the original branch
					const SWAP_BACK_TO_ORIGINAL_BRANCH = vscode.l10n.t(`Swap back to '{0}'`, baseRef);
					vscode.window.showInformationMessage(
						vscode.l10n.t(`Pending changes pushed to remote branch '{0}'.`, ref),
						SWAP_BACK_TO_ORIGINAL_BRANCH,
					).then(async (selection) => {
						if (selection === SWAP_BACK_TO_ORIGINAL_BRANCH) {
							await repository.checkout(baseRef);
						}
					});
				}
			}
		}

		const base_ref = hasChanges ? baseRef : ref;
		try {
			if (!(await ghRepository.hasBranch(base_ref))) {
				if (!this.autoCommitAndPushEnabled()) {
					// We won't auto-push a branch if the user has disabled the setting
					return { error: vscode.l10n.t('The branch \'{0}\' does not exist on the remote repository \'{1}/{2}\'. Please create the remote branch first.', base_ref, owner, repo), state: 'error' };
				}
				// Push the branch
				Logger.appendLine(`Base ref needs to exist on remote.  Auto pushing base_ref '${base_ref}' to remote repository '${owner}/${repo}'`, CopilotRemoteAgentManager.ID);
				await repository.push(remote.remoteName, base_ref, true);
			}
		} catch (error) {
			return { error: vscode.l10n.t('Failed to configure base branch \'{0}\' does not exist on the remote repository \'{1}/{2}\'. Please create the remote branch first.', base_ref, owner, repo), state: 'error' };
		}

		let title = prompt;
		const titleMatch = problemContext.match(/TITLE: \s*(.*)/i);
		if (titleMatch && titleMatch[1]) {
			title = titleMatch[1].trim();
		}

		const problemStatement: string = `${prompt} ${problemContext ? `: ${problemContext}` : ''}`;
		const payload: RemoteAgentJobPayload = {
			problem_statement: problemStatement,
			pull_request: {
				title,
				body_placeholder: problemContext,
				base_ref,
				...(hasChanges && { head_ref: ref })
			}
		};

		try {
			const { pull_request } = await capiClient.postRemoteAgentJob(owner, repo, payload);
			const webviewUri = await toOpenPullRequestWebviewUri({ owner, repo, pullRequestNumber: pull_request.number });
			const prLlmString = `The remote agent has begun work. The user can track progress by visiting ${pull_request.html_url} or from the PR extension. Format this VS Code webview link so the user can click it to also track progress: ${webviewUri.toString()}`;
			return {
				state: 'success',
				number: pull_request.number,
				link: pull_request.html_url,
				webviewUri,
				llmDetails: hasChanges ? `The pending changes have been pushed to branch '${ref}'. ${prLlmString}` : prLlmString
			};
		} catch (error) {
			return { error: error.message, state: 'error' };
		}
	}

	async getSessionLogsFromAction(remote: Remote, pullRequestId: number) {
		const capi = await this.copilotApi;
		if (!capi) {
			return [];
		}
		const runs = await capi.getWorkflowRunsFromAction(remote);
		const padawanRuns = runs
			.filter(run => run.path && run.path.startsWith('dynamic/copilot-swe-agent'))
			.filter(run => run.pull_requests?.some(pr => pr.id === pullRequestId));

		const lastRun = this.getLatestRun(padawanRuns);

		if (!lastRun) {
			return [];
		}

		return await capi.getLogsFromZipUrl(lastRun.logs_url);
	}

	async getSessionLogFromPullRequest(pullRequestId: number, sessionIndex = 0, completedOnly = true): Promise<IAPISessionLogs | undefined> {
		const capi = await this.copilotApi;
		if (!capi) {
			return undefined;
		}

		const sessions = await capi.getAllSessions(pullRequestId);
		const session = sessions.filter(s => !completedOnly || s.state === 'completed').at(sessionIndex);
		if (!session) {
			return undefined;
		}

		const logs = await capi.getLogsFromSession(session.id);
		return { sessionId: session.id, logs };
	}

	async getSessionUrlFromPullRequest(pullRequestId: number, sessionIndex = 0, completedOnly = true): Promise<string | undefined> {
		const capi = await this.copilotApi;
		if (!capi) {
			return undefined;
		}

		const sessions = await capi.getAllSessions(pullRequestId);
		const session = sessions.filter(s => !completedOnly || s.state === 'completed').at(sessionIndex);
		if (!session) {
			return undefined;
		}
		return `${this.workflowRunUrlBase}${session.workflow_run_id}`;
	}

	async getSessionLogsFromSessionId(sessionId: string): Promise<IAPISessionLogs> {
		const capi = await this.copilotApi;
		if (!capi) {
			return { sessionId: '', logs: '' };
		}

		const logs = await capi.getLogsFromSession(sessionId);
		return { sessionId, logs };
	}

	private getLatestRun<T extends { last_updated_at?: string; updated_at?: string }>(runs: T[]): T {
		return runs
			.slice()
			.sort((a, b) => {
				const dateA = new Date(a.last_updated_at ?? a.updated_at ?? 0).getTime();
				const dateB = new Date(b.last_updated_at ?? b.updated_at ?? 0).getTime();
				return dateB - dateA;
			})[0];
	}

	clearNotifications() {
		this._stateModel.clearNotifications();
	}

	get notifications(): ReadonlySet<string> {
		return this._stateModel.notifications;
	}
}