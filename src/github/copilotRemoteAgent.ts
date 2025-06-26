/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import vscode from 'vscode';
import { Repository } from '../api/api';
import { AuthProvider } from '../common/authentication';
import { Disposable } from '../common/lifecycle';
import { CODING_AGENT, CODING_AGENT_AUTO_COMMIT_AND_PUSH, CODING_AGENT_ENABLED } from '../common/settingKeys';
import { toOpenPullRequestWebviewUri } from '../common/uri';
import { CopilotApi, RemoteAgentJobPayload } from './copilotApi';
import { CopilotPRWatcher, CopilotStateModel } from './copilotPrWatcher';
import { CredentialStore } from './credentials';
import { PullRequestModel } from './pullRequestModel';
import { RepositoriesManager } from './repositoriesManager';

type RemoteAgentSuccessResult = { link: string; state: 'success'; number: number; webviewUri: vscode.Uri; llmDetails: string };
type RemoteAgentErrorResult = { error: string; state: 'error' };
type RemoteAgentResult = RemoteAgentSuccessResult | RemoteAgentErrorResult;

export class CopilotRemoteAgentManager extends Disposable {
	private readonly _onDidChangeEnabled = new vscode.EventEmitter<boolean>();
	public readonly onDidChangeEnabled: vscode.Event<boolean> = this._onDidChangeEnabled.event;
	public static ID = 'CopilotRemoteAgentManager';

	constructor(private credentialStore: CredentialStore, public repositoriesManager: RepositoriesManager, stateModel: CopilotStateModel) {
		super();
		this._register(this.credentialStore.onDidChangeSessions((e: vscode.AuthenticationSessionsChangeEvent) => {
			if (e.provider.id === 'github') {
				this._copilotApiPromise = undefined; // Invalidate cached session
			}
		}));
		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${CODING_AGENT}.${CODING_AGENT_ENABLED}`)) {
				this._onDidChangeEnabled.fire(this.enabled());
			}
		}));
		this._register(new CopilotPRWatcher(this.repositoriesManager, stateModel));

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

	autoCommitAndPushEnabled(): boolean {
		return vscode.workspace
			.getConfiguration(CODING_AGENT).get(CODING_AGENT_AUTO_COMMIT_AND_PUSH, false);
	}

	private getFolderManagerForRepo(owner?: string, repo?: string) {
		let folderManager = (owner && repo)
			? this.repositoriesManager.getManagerForRepository(owner, repo)
			: undefined;
		if (!folderManager && this.repositoriesManager.folderManagers.length > 0) {
			folderManager = this.repositoriesManager.folderManagers[0];
		}
		if (!folderManager) {
			throw new Error('No folder manager found for the repository. Open a workspace with a Git repository.');
		}
		return folderManager;
	}

	async repoInfo(): Promise<{ owner: string; repo: string; remote: string; baseRef: string; repository: Repository } | undefined> {
		const fm = this.getFolderManagerForRepo();
		const repository = fm?.repository;
		if (!fm || !repository) {
			return;
		}
		const { owner, repo } = await fm.getPullRequestDefaults();
		const remotes = repository.state.remotes;
		const baseRef = repository.state.HEAD?.name; // TODO: Consider edge cases
		const remote = remotes.find(r => r.name === 'origin')?.name || remotes.find(r => r.pushUrl)?.name;
		if (!owner || !repo || !remote || !baseRef || !repository) {
			return;
		}
		return { owner, repo, remote, baseRef, repository };
	}

	async commandImpl(args?: any) {
		// https://github.com/microsoft/vscode-copilot/issues/18918
		const userPrompt: string | undefined = args.userPrompt;
		const summary: string | undefined = args.summary;

		if (!userPrompt || userPrompt.trim().length === 0) {
			return;
		}

		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			return;
		}
		const { repository } = repoInfo;

		const hasChanges = repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0;
		const PUSH_CHANGES = vscode.l10n.t('Include uncommitted changes');
		const CONTINUE_WITHOUT_PUSHING = vscode.l10n.t('Start from \'{0}\'', `${repoInfo.remote}/${repoInfo.baseRef}`);

		let autoPushAndCommit = false;
		if (hasChanges && this.autoCommitAndPushEnabled()) {
			const modalResult = await vscode.window.showInformationMessage(
				vscode.l10n.t('Coding Agent'),
				{
					modal: true,
					detail: vscode.l10n.t('Coding agent will continue your work in \'{0}\' targetting \'{1}\'.', `${repoInfo.owner}/${repoInfo.repo}`, `${repoInfo.remote}/${repoInfo.baseRef}`),
				},
				PUSH_CHANGES,
				CONTINUE_WITHOUT_PUSHING,
			);

			if (!modalResult) {
				return;
			}

			if (modalResult === PUSH_CHANGES) {
				autoPushAndCommit = true;
			}
		}


		const result = await this.invokeRemoteAgent(
			userPrompt,
			summary || '',
			autoPushAndCommit
		);
		if (result.state !== 'success') {
			vscode.window.showErrorMessage(result.error);
			return;
		}

		const { webviewUri, link } = result;
		const openLink = vscode.l10n.t('View');
		vscode.window.showInformationMessage(
			// allow-any-unicode-next-line
			vscode.l10n.t('🚀 Coding agent started! Track progress at {0}', link)
			, openLink
		).then(selection => {
			if (selection === openLink) {
				vscode.env.openExternal(webviewUri);
			}
		});
	}

	async invokeRemoteAgent(prompt: string, problemContext: string, autoPushAndCommit = true): Promise<RemoteAgentResult> {
		// TODO: Check that the user has a valid copilot subscription
		const capiClient = await this.copilotApi;
		if (!capiClient) {
			return { error: vscode.l10n.t('Failed to initialize Copilot API'), state: 'error' };
		}

		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			return { error: vscode.l10n.t('No repository information found. Please open a workspace with a Git repository.'), state: 'error' };
		}
		const { owner, repo, remote, repository, baseRef } = repoInfo;

		// NOTE: This is as unobtrusive as possible with the current high-level APIs.
		// We only create a new branch and commit if there are staged or working changes.
		// This could be improved if we add lower-level APIs to our git extension (e.g. in-memory temp git index).

		let ref = baseRef;
		const hasChanges = repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0;
		if (hasChanges && autoPushAndCommit) {
			if (!this.autoCommitAndPushEnabled()) {
				return { error: vscode.l10n.t('Uncommitted changes detected. Please commit or stash your changes before starting the remote agent. Enable \'{0}\' to push your changes automatically.', CODING_AGENT_AUTO_COMMIT_AND_PUSH), state: 'error' };
			}
			const asyncBranch = `continue-from-${Date.now()}`;
			try {
				await repository.createBranch(asyncBranch, true);
				await repository.add([]);
				if (repository.state.indexChanges.length > 0) {
					// TODO: there is an issue here if the user has GPG signing enabled.
					//       https://github.com/microsoft/vscode/pull/252263
					await repository.commit('Checkpoint for Copilot Agent async session', { signCommit: false });
				}
				await repository.push(remote, asyncBranch, true);
				ref = asyncBranch;
			} catch (e) {
				return { error: vscode.l10n.t(`Could not auto-commit pending changes. Please disable GPG signing, or manually commit/stash your changes before starting the remote agent. Error: ${e.message}`), state: 'error' };
			} finally {
				// Swap back to the original branch without your pending changes
				// TODO: Better if we show a confirmation dialog in chat
				if (repository.state.HEAD?.name !== baseRef) {
					// show notification asking the user if they want to switch back to the original branch
					const SWAP_BACK_TO_ORIGINAL_BRANCH = vscode.l10n.t(`Swap back to '{0}'`, baseRef);
					vscode.window.showInformationMessage(
						vscode.l10n.t(`Your pending changes have been pushed to remote branch '{0}.`, ref),
						SWAP_BACK_TO_ORIGINAL_BRANCH,
					).then(async (selection) => {
						if (selection === SWAP_BACK_TO_ORIGINAL_BRANCH) {
							await repository.checkout(baseRef);
						}
					});
				}
			}
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
				base_ref: ref,
			}
		};
		const { pull_request } = await capiClient.postRemoteAgentJob(owner, repo, payload);
		const webviewUri = await toOpenPullRequestWebviewUri({ owner, repo, pullRequestNumber: pull_request.number });
		const prLlmString = `The remote agent has begun work. The user can track progress by visiting ${pull_request.html_url} or from the PR extension.`;
		return {
			state: 'success',
			number: pull_request.number,
			link: pull_request.html_url,
			webviewUri,
			llmDetails: hasChanges ? `The pending changes have been pushed to branch '${ref}'. ${prLlmString}` : prLlmString
		};
	}

	async getSessionLogsFromAction(pullRequest: PullRequestModel) {
		const capi = await this.copilotApi;
		if (!capi) {
			return [];
		}
		const runs = await capi.getWorkflowRunsFromAction(pullRequest);
		const padawanRuns = runs
			.filter(run => run.path && run.path.startsWith('dynamic/copilot-swe-agent'))
			.filter(run => run.pull_requests?.some(pr => pr.id === pullRequest.id));

		const lastRun = this.getLatestRun(padawanRuns);

		if (!lastRun) {
			return [];
		}

		return await capi.getLogsFromZipUrl(lastRun.logs_url);
	}

	async getSessionLogsFromAPI(pullRequest: PullRequestModel): Promise<string> {
		const capi = await this.copilotApi;
		if (!capi) {
			return '';
		}

		const logs = await capi.getAllSessions(pullRequest);
		const completedSessions = logs.filter(s => s.state === 'completed');
		if (completedSessions.length === 0) {
			return '';
		}
		const mostRecentSession = this.getLatestRun(completedSessions);
		return await capi.getLogsFromSession(mostRecentSession.id);
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
}