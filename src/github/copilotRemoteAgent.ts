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
import { CredentialStore } from './credentials';
import { PullRequestModel } from './pullRequestModel';
import { RepositoriesManager } from './repositoriesManager';

type RemoteAgentSuccessResult = { link: string; state: 'success'; number: number; webviewUri: vscode.Uri; llmDetails: string };
type RemoteAgentErrorResult = { error: string; state: 'error' };
type RemoteAgentResult = RemoteAgentSuccessResult | RemoteAgentErrorResult;

const YES_QUICK_PICK = vscode.l10n.t('Push my pending work');
const NO_QUICK_PICK = vscode.l10n.t('Do not push my pending work');

export class CopilotRemoteAgentManager extends Disposable {
	private readonly _onDidChangeEnabled = new vscode.EventEmitter<boolean>();
	public readonly onDidChangeEnabled: vscode.Event<boolean> = this._onDidChangeEnabled.event;
	public static ID = 'CopilotRemoteAgentManager';

	constructor(private credentialStore: CredentialStore, public repositoriesManager: RepositoriesManager) {
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

	statusBarItemImpl(): vscode.StatusBarItem {
		const continueWithCopilot = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		continueWithCopilot.command = 'pr.continueAsyncWithCopilot';
		continueWithCopilot.text = vscode.l10n.t('$(cloud-upload) Finish with coding agent');
		continueWithCopilot.tooltip = vscode.l10n.t('Complete your current work with the Copilot coding agent. Your current changes will be pushed to a branch and your task will be completed in the background.');
		continueWithCopilot.show();
		return continueWithCopilot;
	}

	async commandImpl() {
		const body = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Describe a task for the coding agent'),
			title: vscode.l10n.t('Finish With Coding Agent'),
			placeHolder: vscode.l10n.t('Finish writing my unit tests...'),
			ignoreFocusOut: true,
			validateInput: (value: string) => {
				if (!value || value.trim().length === 0) {
					return vscode.l10n.t('Description cannot be empty');
				}
				return;
			}
		});

		if (!body) {
			return;
		}
		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace to use the coding agent'));
			return;
		}
		const autoPushQuickPick = await vscode.window.showQuickPick(
			[
				{ label: YES_QUICK_PICK, description: vscode.l10n.t('Push pending work to a new branch in {0} where the coding agent will continue your work', `${repoInfo.owner}/${repoInfo.repo}`) },
				{ label: NO_QUICK_PICK, description: vscode.l10n.t('The coding agent will continue from the last commit on {0}', repoInfo.baseRef) }
			],
		);
		if (!autoPushQuickPick) {
			return; // Cancelled
		}
		const autoPushAndCommit = autoPushQuickPick?.label === YES_QUICK_PICK;
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Copilot Coding Agent'),
				cancellable: false
			},
			async (progress) => {
				progress.report({ message: vscode.l10n.t('Initializing coding agent...') });
				const result = await this.invokeRemoteAgent(vscode.l10n.t('Continuing from VS Code'), body, autoPushAndCommit);
				if (result.state === 'error') {
					vscode.window.showErrorMessage(result.error);
					return;
				}
				const { webviewUri, link } = result;
				const openLink = vscode.l10n.t('View');
				vscode.window.showInformationMessage(
					// allow-any-unicode-next-line
					vscode.l10n.t('🚀 Coding agent started! Track progress at {0}', link),
					openLink
				).then(selection => {
					if (selection === openLink) {
						vscode.env.openExternal(webviewUri);
					}
				});
			}
		);
	}

	async invokeRemoteAgent(title: string, body: string, autoPushAndCommit = true): Promise<RemoteAgentResult> {
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

		let headRef: string | undefined;
		const pushLocalChanged = autoPushAndCommit && (repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0);
		if (pushLocalChanged) {
			if (!this.autoCommitAndPushEnabled()) {
				return { error: vscode.l10n.t('Uncommitted changes detected. Please commit or stash your changes before starting the remote agent. Enable \'{0}\' to push your changes automatically.', CODING_AGENT_AUTO_COMMIT_AND_PUSH), state: 'error' };
			}
			headRef = `copilot/vscode-${Date.now()}`;
			try {
				await repository.createBranch(headRef, true);
				await repository.add([]);
				if (repository.state.indexChanges.length > 0) {
					// TODO: there is an issue here if the user has GPG signing enabled.
					await repository.commit('Checkpoint for copilot coding agent async session', { signCommit: false });
				}
				await repository.push(remote, headRef, true);
			} catch (e) {
				return { error: vscode.l10n.t(`Could not auto-commit pending changes. Please disable GPG signing, confirm pre-commit hooks succeed, or manually commit/stash your changes before starting the remote agent. Error: ${e.message}`), state: 'error' };
			}
		}

		let payload: RemoteAgentJobPayload = {
			problem_statement: `${title}: ${body}`,
			pull_request: {
				title,
				body_placeholder: body,
				// base_ref: baseRef,
				base_ref: baseRef,
			}
		};

		if (headRef && payload.pull_request) {
			payload.pull_request.head_ref = headRef;
		}

		const { pull_request } = await capiClient.postRemoteAgentJob(owner, repo, payload);
		const webviewUri = await toOpenPullRequestWebviewUri({ owner, repo, pullRequestNumber: pull_request.number });
		const prLlmString = `The remote agent has begun work. The user can track progress by visiting ${pull_request.html_url} or from the PR extension.`;
		return {
			state: 'success',
			number: pull_request.number,
			link: pull_request.html_url,
			webviewUri,
			llmDetails: pushLocalChanged ? `The local pending changes have been committed and pushed to branch '${headRef}'. The final pull request will target '${baseRef}'. ${prLlmString}` : prLlmString
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