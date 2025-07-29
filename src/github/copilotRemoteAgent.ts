/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import vscode from 'vscode';
import { parseSessionLogs, parseToolCallDetails } from '../../common/sessionParsing';
import { Repository } from '../api/api';
import { COPILOT_ACCOUNTS } from '../common/comment';
import { COPILOT_LOGINS, copilotEventToStatus, CopilotPRStatus, mostRecentCopilotEvent } from '../common/copilot';
import { commands } from '../common/executeCommands';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { GitHubRemote } from '../common/remote';
import { CODING_AGENT, CODING_AGENT_AUTO_COMMIT_AND_PUSH, CODING_AGENT_ENABLED, CODING_AGENT_PROMPT_FOR_CONFIRMATION } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { CommentEvent, CopilotFinishedEvent, CopilotStartedEvent, EventType, ReviewEvent, TimelineEvent } from '../common/timelineEvent';
import { DataUri, toOpenPullRequestWebviewUri } from '../common/uri';
import { getIconForeground, getListErrorForeground, getListWarningForeground, getNotebookStatusSuccessIconForeground } from '../view/theme';
import { OctokitCommon } from './common';
import { ChatSessionWithPR, CopilotApi, getCopilotApi, RemoteAgentJobPayload, SessionInfo, SessionSetupStep } from './copilotApi';
import { CopilotPRWatcher, CopilotStateModel } from './copilotPrWatcher';
import { CredentialStore } from './credentials';
import { FolderRepositoryManager, ReposManagerState } from './folderRepositoryManager';
import { GitHubRepository } from './githubRepository';
import { GithubItemStateEnum } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { RepositoriesManager } from './repositoriesManager';

type RemoteAgentSuccessResult = { link: string; state: 'success'; number: number; webviewUri: vscode.Uri; llmDetails: string };
type RemoteAgentErrorResult = { error: string; state: 'error' };
type RemoteAgentResult = RemoteAgentSuccessResult | RemoteAgentErrorResult;

export interface IAPISessionLogs {
	readonly info: SessionInfo;
	readonly logs: string;
	readonly setupSteps: SessionSetupStep[] | undefined;
}

export interface ICopilotRemoteAgentCommandArgs {
	userPrompt: string;
	summary?: string;
	source?: string;
	followup?: string;
	_version?: number; // TODO(jospicer): Remove once stabilized/engine version enforced
}

export interface ICopilotRemoteAgentCommandResponse {
	uri: string;
	title: string;
	description: string;
	author: string;
	linkTag: string;
}

const LEARN_MORE = vscode.l10n.t('Learn about coding agent');
// Without Pending Changes
const CONTINUE = vscode.l10n.t('Continue');
// With Pending Changes
const PUSH_CHANGES = vscode.l10n.t('Include changes');
const CONTINUE_WITHOUT_PUSHING = vscode.l10n.t('Ignore changes');
const CONTINUE_AND_DO_NOT_ASK_AGAIN = vscode.l10n.t('Continue and don\'t ask again');
const COMMIT_YOUR_CHANGES = vscode.l10n.t('Commit your changes to continue coding agent session. Close integrated terminal to cancel.');

const COPILOT = '@copilot';

const body_suffix = vscode.l10n.t('Created from VS Code via the [GitHub Pull Request](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github) extension.');

export class CopilotRemoteAgentManager extends Disposable {
	public static ID = 'CopilotRemoteAgentManager';

	private readonly _stateModel: CopilotStateModel;
	private readonly _onDidChangeStates = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeStates = this._onDidChangeStates.event;
	private readonly _onDidChangeNotifications = this._register(new vscode.EventEmitter<PullRequestModel[]>());
	readonly onDidChangeNotifications = this._onDidChangeNotifications.event;
	private readonly _onDidCreatePullRequest = this._register(new vscode.EventEmitter<number>());
	readonly onDidCreatePullRequest = this._onDidCreatePullRequest.event;
	private readonly _onDidChangeChatSessions = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeChatSessions = this._onDidChangeChatSessions.event;

	constructor(private credentialStore: CredentialStore, public repositoriesManager: RepositoriesManager, private telemetry: ITelemetry) {
		super();
		this._register(this.credentialStore.onDidChangeSessions((e: vscode.AuthenticationSessionsChangeEvent) => {
			if (e.provider.id === 'github') {
				this._copilotApiPromise = undefined; // Invalidate cached session
			}
		}));

		this._stateModel = new CopilotStateModel();
		this._register(new CopilotPRWatcher(this.repositoriesManager, this._stateModel));
		this._register(this._stateModel.onDidChangeStates(() => this._onDidChangeStates.fire()));
		this._register(this._stateModel.onDidChangeNotifications(items => this._onDidChangeNotifications.fire(items)));

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
		return await getCopilotApi(this.credentialStore, this.telemetry);
	}

	private _repoManagerInitializationPromise: Promise<void> | undefined;
	private async waitRepoManagerInitialization() {
		if (this.repositoriesManager.state === ReposManagerState.RepositoriesLoaded || this.repositoriesManager.state === ReposManagerState.NeedsAuthentication) {
			return;
		}

		if (!this._repoManagerInitializationPromise) {
			this._repoManagerInitializationPromise = new Promise((resolve) => {
				const disposable = this.repositoriesManager.onDidChangeState(() => {
					if (this.repositoriesManager.state === ReposManagerState.RepositoriesLoaded || this.repositoriesManager.state === ReposManagerState.NeedsAuthentication) {
						disposable.dispose();
						resolve();
					}
				});
			});
		}

		return this._repoManagerInitializationPromise;
	}

	enabled(): boolean {
		return vscode.workspace
			.getConfiguration(CODING_AGENT).get(CODING_AGENT_ENABLED, false);
	}

	promptForConfirmation(): boolean {
		return vscode.workspace
			.getConfiguration(CODING_AGENT).get(CODING_AGENT_PROMPT_FOR_CONFIRMATION, true);
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

	async addFollowUpToExistingPR(pullRequestNumber: number, userPrompt: string, summary?: string): Promise<string | undefined> {
		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			return;
		}
		try {
			const ghRepo = repoInfo.ghRepository;
			const pr = await ghRepo.getPullRequest(pullRequestNumber);
			if (!pr) {
				Logger.error(`Could not find pull request #${pullRequestNumber}`, CopilotRemoteAgentManager.ID);
				return;
			}
			// Add a comment tagging @copilot with the user's prompt
			const commentBody = `${COPILOT} ${userPrompt} \n\n --- \n\n ${summary ?? ''}`;
			const commentResult = await pr.createIssueComment(commentBody);
			if (!commentResult) {
				Logger.error(`Failed to add comment to PR #${pullRequestNumber}`, CopilotRemoteAgentManager.ID);
				return;
			}
			Logger.appendLine(`Added comment ${commentResult.htmlUrl}`, CopilotRemoteAgentManager.ID);
			// allow-any-unicode-next-line
			return vscode.l10n.t('🚀 Follow-up comment added to [#{0}]({1})', pullRequestNumber, commentResult.htmlUrl);
		} catch (err) {
			Logger.error(`Failed to add follow-up comment to PR #${pullRequestNumber}: ${err}`, CopilotRemoteAgentManager.ID);
			return;
		}
	}

	async commandImpl(args?: ICopilotRemoteAgentCommandArgs): Promise<string | ICopilotRemoteAgentCommandResponse | undefined> {
		if (!args) {
			return;
		}
		const { userPrompt, summary, source, followup, _version } = args;

		/* __GDPR__
			"remoteAgent.command.args" : {
				"source" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"isFollowup" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"userPromptLength" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"summaryLength" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"version" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetry.sendTelemetryEvent('remoteAgent.command.args', {
			source: source?.toString() || 'unknown',
			isFollowup: !!followup ? 'true' : 'false',
			userPromptLength: userPrompt.length.toString(),
			summaryLength: summary ? summary.length.toString() : '0',
			version: _version?.toString() || 'unknown'
		});

		if (!userPrompt || userPrompt.trim().length === 0) {
			return;
		}

		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			/* __GDPR__
				"remoteAgent.command.result" : {
					"reason" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			this.telemetry.sendTelemetryErrorEvent('remoteAgent.command.result', { reason: 'noRepositoryInfo' });
			return;
		}
		const { repository, owner, repo } = repoInfo;

		const repoName = `${owner}/${repo}`;
		const hasChanges = repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0;
		const learnMoreCb = async () => {
			/* __GDPR__
				"remoteAgent.command.result" : {
					"reason" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			this.telemetry.sendTelemetryErrorEvent('remoteAgent.command.result', { reason: 'learnMore' });
			vscode.env.openExternal(vscode.Uri.parse('https://docs.github.com/copilot/using-github-copilot/coding-agent'));
		};

		let autoPushAndCommit = false;
		const message = vscode.l10n.t('Copilot coding agent will continue your work in \'{0}\'.', repoName);
		const detail = vscode.l10n.t('Your chat context will be used to continue work in a new pull request.');
		if (source !== 'prompt' && hasChanges && this.autoCommitAndPushEnabled()) {
			// Pending changes modal
			const modalResult = await vscode.window.showInformationMessage(
				message,
				{
					modal: true,
					detail,
				},
				PUSH_CHANGES,
				CONTINUE_WITHOUT_PUSHING,
				LEARN_MORE,
			);

			if (!modalResult) {
				/* __GDPR__
					"remoteAgent.command.result" : {
						"reason" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
					}
				*/
				this.telemetry.sendTelemetryErrorEvent('remoteAgent.command.result', { reason: 'cancel' });
				return;
			}

			if (modalResult === LEARN_MORE) {
				learnMoreCb();
				return;
			}

			if (modalResult === PUSH_CHANGES) {
				autoPushAndCommit = true;
			}
		} else if (this.promptForConfirmation()) {
			// No pending changes modal
			const modalResult = await vscode.window.showInformationMessage(
				source !== 'prompt' ? message : vscode.l10n.t('Copilot coding agent will implement the specification outlined in this prompt file'),
				{
					modal: true,
					detail: source !== 'prompt' ? detail : undefined
				},
				CONTINUE,
				CONTINUE_AND_DO_NOT_ASK_AGAIN,
				LEARN_MORE,
			);
			if (!modalResult) {
				return;
			}

			if (modalResult === CONTINUE_AND_DO_NOT_ASK_AGAIN) {
				await vscode.workspace.getConfiguration(CODING_AGENT).update(CODING_AGENT_PROMPT_FOR_CONFIRMATION, false, vscode.ConfigurationTarget.Global);
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
			/* __GDPR__
				"remoteAgent.command.result" : {
					"reason" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			this.telemetry.sendTelemetryErrorEvent('remoteAgent.command.result', { reason: 'invocationFailure' });
			vscode.window.showErrorMessage(result.error);
			return;
		}

		const { webviewUri, link, number } = result;

		this.telemetry.sendTelemetryEvent('remoteAgent.command', {
			source: source || 'unknown',
			hasFollowup: (!!followup).toString(),
			outcome: 'success'
		});

		this._onDidChangeChatSessions.fire();
		const viewLocationSetting = vscode.workspace.getConfiguration('chat').get('agentSessionsViewLocation');
		const pr = await (async () => {
			const capi = await this.copilotApi;
			if (!capi) {
				return;
			}
			const sessions = await capi.getAllCodingAgentPRs(this.repositoriesManager);
			return sessions.find(session => session.number === number);
		})();

		if (!viewLocationSetting || viewLocationSetting === 'disabled') {
			vscode.commands.executeCommand('vscode.open', webviewUri);
		} else {
			await this.provideChatSessions(new vscode.CancellationTokenSource().token);
			if (pr) {
				vscode.window.showChatSession('copilot-swe-agent', `${pr.number}`, {});
			}
		}

		if (pr && (_version && _version === 2)) { /* version 2 means caller knows how to render this */
			return {
				uri: webviewUri.toString(),
				title: pr.title,
				description: pr.body,
				author: COPILOT_ACCOUNTS[pr.author.login].name,
				linkTag: `#${pr.number}`
			};
		}

		// allow-any-unicode-next-line
		return vscode.l10n.t('🚀 Coding agent will continue work in [#{0}]({1}).  Track progress [here]({2}).', number, link, webviewUri.toString());
	}

	/**
	 * Opens a terminal and waits for user to successfully commit
	 * This is a fallback for when the commit cannot be done automatically (eg: GPG signing password needed)
	 */
	private async handleInteractiveCommit(repository: Repository, cancellationToken?: vscode.CancellationToken): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const startingCommit = repository.state.HEAD?.commit;

			// Create terminal with git commit command
			const terminal = vscode.window.createTerminal({
				name: 'GitHub Coding Agent',
				cwd: repository.rootUri.fsPath,
				message: `\x1b[1m${vscode.l10n.t(COMMIT_YOUR_CHANGES)}\x1b[0m`
			});

			// Show terminal and send commit command
			terminal.show();
			let disposed = false;
			let timeoutId: NodeJS.Timeout;
			let stateListener: vscode.Disposable | undefined;
			let disposalListener: vscode.Disposable | undefined;
			let cancellationListener: vscode.Disposable | undefined;

			const cleanup = () => {
				if (disposed) return;
				disposed = true;
				clearTimeout(timeoutId);
				stateListener?.dispose();
				disposalListener?.dispose();
				cancellationListener?.dispose();
				terminal.dispose();
			};

			// Listen for cancellation if token is provided
			if (cancellationToken) {
				cancellationListener = cancellationToken.onCancellationRequested(() => {
					cleanup();
					resolve(false);
				});
			}

			// Listen for repository state changes
			stateListener = repository.state.onDidChange(() => {
				// Check if commit was successful (HEAD changed and no more staged changes)
				if (repository.state.HEAD?.commit !== startingCommit) {
					cleanup();
					resolve(true);
				}
			});

			// Set a timeout to avoid waiting forever
			timeoutId = setTimeout(() => {
				cleanup();
				resolve(false);
			}, 5 * 60 * 1000); // 5 minutes timeout

			// Listen for terminal disposal (user closed it)
			disposalListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
				if (closedTerminal === terminal) {
					setTimeout(() => {
						if (!disposed) {
							cleanup();
							// Check one more time if commit happened just before terminal was closed
							resolve(repository.state.HEAD?.commit !== startingCommit);
						}
					}, 1000);
				}
			});
		});
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
				const commitMessage = 'Checkpoint from VS Code for coding agent session';
				try {
					await repository.commit(commitMessage, { all: true });
					if (repository.state.HEAD?.name !== asyncBranch || repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0) {
						throw new Error(vscode.l10n.t('Uncommitted changes still detected.'));
					}
				} catch (e) {
					// Instead of immediately failing, open terminal for interactive commit
					const commitSuccessful = await vscode.window.withProgress({
						title: COMMIT_YOUR_CHANGES,
						cancellable: true,
						location: vscode.ProgressLocation.Notification
					}, async (progress, token) => {
						const commitPromise = this.handleInteractiveCommit(repository, token);
						return await commitPromise;
					});
					if (!commitSuccessful) {
						return { error: vscode.l10n.t('Exclude your uncommitted changes and try again.'), state: 'error' };
					}
				}
				await repository.push(remote.remoteName, asyncBranch, true);
				ref = asyncBranch;
				if (repository.state.HEAD?.name !== baseRef) {
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
			} catch (e) {
				if (repository.state.HEAD?.name !== baseRef) {
					try {
						await repository.checkout(baseRef);
					} catch (checkoutError) {
						Logger.error(`Failed to checkout back to original branch '${baseRef}': ${checkoutError}`, CopilotRemoteAgentManager.ID);
					}
				}
				Logger.error(`Failed to auto-commit and push pending changes: ${e}`, CopilotRemoteAgentManager.ID);
				return { error: vscode.l10n.t('Could not auto-push pending changes. Manually commit or stash your changes and try again. ({0})', e.message), state: 'error' };
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

		const formatBodyPlaceholder = (problemContext: string): string => {
			const header = vscode.l10n.t('Coding agent has begun work on **{0}** and will replace this description as work progresses.', title);
			const collapsedContext = `<details><summary>${vscode.l10n.t('See problem context')}</summary>\n\n${problemContext}\n\n</details>`;
			return `${header}\n\n${collapsedContext}`;
		};

		const problemStatement: string = `${prompt} ${problemContext ? `: ${problemContext}` : ''}`;
		const payload: RemoteAgentJobPayload = {
			problem_statement: problemStatement,
			pull_request: {
				title,
				body_placeholder: formatBodyPlaceholder(problemContext),
				base_ref,
				body_suffix,
				...(hasChanges && { head_ref: ref })
			}
		};

		try {
			const { pull_request } = await capiClient.postRemoteAgentJob(owner, repo, payload);
			this._onDidCreatePullRequest.fire(pull_request.number);
			const webviewUri = await toOpenPullRequestWebviewUri({ owner, repo, pullRequestNumber: pull_request.number });
			const prLlmString = `The remote agent has begun work and has created a pull request. Details about the pull request are being shown to the user. If the user wants to track progress or iterate on the agent's work, they should use the pull request.`;
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

	async getSessionLogsFromAction(pullRequest: PullRequestModel) {
		const capi = await this.copilotApi;
		if (!capi) {
			return [];
		}
		const lastRun = await this.getLatestCodingAgentFromAction(pullRequest);
		if (!lastRun) {
			return [];
		}

		return await capi.getLogsFromZipUrl(lastRun.logs_url);
	}

	async getWorkflowStepsFromAction(pullRequest: PullRequestModel): Promise<SessionSetupStep[]> {
		const lastRun = await this.getLatestCodingAgentFromAction(pullRequest, 0, false);
		if (!lastRun) {
			return [];
		}

		try {
			const jobs = await pullRequest.githubRepository.getWorkflowJobs(lastRun.id);
			const steps: SessionSetupStep[] = [];

			for (const job of jobs) {
				if (job.steps) {
					for (const step of job.steps) {
						steps.push({ name: step.name, status: step.status });
					}
				}
			}

			return steps;
		} catch (error) {
			Logger.error(`Failed to get workflow steps: ${error}`, CopilotRemoteAgentManager.ID);
			return [];
		}
	}

	async getLatestCodingAgentFromAction(pullRequest: PullRequestModel, sessionIndex = 0, completedOnly = true): Promise<OctokitCommon.WorkflowRun | undefined> {
		const capi = await this.copilotApi;
		if (!capi) {
			return;
		}
		const runs = await pullRequest.githubRepository.getWorkflowRunsFromAction(pullRequest.createdAt);
		const workflowRuns = runs.flatMap(run => run.workflow_runs);
		const padawanRuns = workflowRuns
			.filter(run => run.path && run.path.startsWith('dynamic/copilot-swe-agent'))
			.filter(run => run.pull_requests?.some(pr => pr.id === pullRequest.id));

		const session = padawanRuns.filter(s => !completedOnly || s.status === 'completed').at(sessionIndex);
		if (!session) {
			return;
		}

		return this.getLatestRun(padawanRuns);
	}

	async getSessionLogFromPullRequest(pullRequest: PullRequestModel, sessionIndex = 0, completedOnly = true): Promise<IAPISessionLogs | undefined> {
		const capi = await this.copilotApi;
		if (!capi) {
			return undefined;
		}

		const sessions = await capi.getAllSessions(pullRequest.id);
		const session = sessions.filter(s => !completedOnly || s.state === 'completed').at(sessionIndex);
		if (!session) {
			return undefined;
		}

		const logs = await capi.getLogsFromSession(session.id);

		// If session is in progress, try to fetch workflow steps to show setup progress
		let setupSteps: SessionSetupStep[] | undefined;
		if (session.state === 'in_progress' || logs.trim().length === 0) {
			try {
				// Get workflow steps instead of logs
				setupSteps = await this.getWorkflowStepsFromAction(pullRequest);
			} catch (error) {
				// If we can't fetch workflow steps, don't fail the entire request
				Logger.warn(`Failed to fetch workflow steps for session ${session.id}: ${error}`, CopilotRemoteAgentManager.ID);
			}
		}

		return { info: session, logs, setupSteps };
	}

	async getSessionUrlFromPullRequest(pullRequest: PullRequestModel): Promise<string | undefined> {
		const capi = await this.copilotApi;
		if (!capi) {
			return;
		}

		const sessions = await this.getLatestCodingAgentFromAction(pullRequest);
		if (!sessions) {
			return;
		}
		return sessions.html_url;
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

	get notificationsCount(): number {
		return this._stateModel.notifications.size;
	}

	hasNotification(owner: string, repo: string, pullRequestNumber: number): boolean {
		const key = this._stateModel.makeKey(owner, repo, pullRequestNumber);
		return this._stateModel.notifications.has(key);
	}

	getStateForPR(owner: string, repo: string, prNumber: number): CopilotPRStatus {
		return this._stateModel.get(owner, repo, prNumber);
	}

	getCounts(): { total: number; inProgress: number; error: number } {
		return this._stateModel.getCounts();
	}

	public async provideChatSessions(token: vscode.CancellationToken): Promise<ChatSessionWithPR[]> {
		try {
			const capi = await this.copilotApi;
			if (!capi) {
				return [];
			}

			// Check if the token is already cancelled
			if (token.isCancellationRequested) {
				return [];
			}

			await this.waitRepoManagerInitialization();

			const codingAgentPRs = await capi.getAllCodingAgentPRs(this.repositoriesManager);
			return await Promise.all(codingAgentPRs.map(async session => {
				const timeline = await session.getTimelineEvents(session);
				const status = copilotEventToStatus(mostRecentCopilotEvent(timeline));
				if (status !== CopilotPRStatus.Completed && status !== CopilotPRStatus.Failed) {
					const disposable = session.onDidChange(() => {
						this._onDidChangeChatSessions.fire();
						disposable.dispose(); // Clean up listener after firing
					});
					this._register(disposable);
				}
				return {
					id: `${session.number}`,
					label: session.title || `Session ${session.number}`,
					iconPath: this.getIconForSession(status),
					pullRequest: session
				};
			}));
		} catch (error) {
			Logger.error(`Failed to provide coding agents information: ${error}`, CopilotRemoteAgentManager.ID);
		}
		return [];
	}

	private extractPromptFromEvent(event: TimelineEvent): string {
		let body = '';
		if (event.event === EventType.Commented) {
			body = (event as CommentEvent).body;
		} else if (event.event === EventType.Reviewed) {
			body = (event as ReviewEvent).body;
		}

		// Extract the prompt before any separator pattern (used in addFollowUpToExistingPR)
		// but keep the @copilot mention
		const separatorMatch = body.match(/^(.*?)\s*\n\n\s*---\s*\n\n/s);
		if (separatorMatch) {
			return separatorMatch[1].trim();
		}

		return body.trim();
	}

	public async provideChatSessionContent(id: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		try {
			const capi = await this.copilotApi;
			if (!capi || token.isCancellationRequested) {
				return this.createEmptySession();
			}

			const pullRequestNumber = parseInt(id);
			if (isNaN(pullRequestNumber)) {
				Logger.error(`Invalid pull request number: ${id}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			await this.waitRepoManagerInitialization();

			const pullRequest = await this.findPullRequestById(pullRequestNumber, true);
			if (!pullRequest) {
				Logger.error(`Pull request not found: ${pullRequestNumber}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			const sessions = await capi.getAllSessions(pullRequest.id);
			if (!sessions || sessions.length === 0) {
				Logger.warn(`No sessions found for pull request ${pullRequestNumber}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			if (!Array.isArray(sessions)) {
				Logger.error(`getAllSessions returned non-array: ${typeof sessions}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			const history = await this.buildSessionHistory(sessions, pullRequest, capi);
			const activeResponseCallback = this.findActiveResponseCallback(sessions, pullRequest);
			const requestHandler = this.createRequestHandlerIfNeeded(pullRequest);

			return {
				history,
				activeResponseCallback,
				requestHandler
			};
		} catch (error) {
			Logger.error(`Failed to provide chat session content: ${error}`, CopilotRemoteAgentManager.ID);
			return this.createEmptySession();
		}
	}

	private async buildSessionHistory(
		sessions: SessionInfo[],
		pullRequest: PullRequestModel,
		capi: CopilotApi
	): Promise<Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2>> {
		const sortedSessions = sessions.slice().sort((a, b) =>
			new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
		);

		const history: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2> = [];
		const timelineEvents = await pullRequest.getTimelineEvents(pullRequest);

		Logger.appendLine(`Found ${timelineEvents.length} timeline events`, CopilotRemoteAgentManager.ID);

		for (const [sessionIndex, session] of sortedSessions.entries()) {
			const logs = await capi.getLogsFromSession(session.id);
			const sessionPrompt = await this.determineSessionPrompt(session, sessionIndex, pullRequest, timelineEvents, capi);

			// Create request turn for this session
			const sessionRequest = new vscode.ChatRequestTurn2(
				sessionPrompt,
				undefined, // command
				[], // references
				'copilot-swe-agent',
				[], // toolReferences
				[]
			);
			history.push(sessionRequest);

			// Create response turn
			const responseHistory = await this.createResponseTurn(pullRequest, logs, session);
			if (responseHistory) {
				history.push(responseHistory);
			}
		}

		return history;
	}

	private async determineSessionPrompt(
		session: SessionInfo,
		sessionIndex: number,
		pullRequest: PullRequestModel,
		timelineEvents: readonly TimelineEvent[],
		capi: CopilotApi
	): Promise<string> {
		let sessionPrompt = session.name || `Session ${sessionIndex + 1} (ID: ${session.id})`;

		if (sessionIndex === 0) {
			sessionPrompt = await this.getInitialSessionPrompt(session, pullRequest, capi, sessionPrompt);
		} else {
			sessionPrompt = await this.getFollowUpSessionPrompt(sessionIndex, timelineEvents, sessionPrompt);
		}

		// TODO: @rebornix, remove @copilot prefix from session prompt for now
		sessionPrompt = sessionPrompt.replace(/@copilot\s*/gi, '').trim();
		return sessionPrompt;
	}

	private async getInitialSessionPrompt(
		session: SessionInfo,
		pullRequest: PullRequestModel,
		capi: CopilotApi,
		defaultPrompt: string
	): Promise<string> {
		try {
			const jobInfo = await capi.getJobBySessionId(
				pullRequest.base.repositoryCloneUrl.owner,
				pullRequest.base.repositoryCloneUrl.repositoryName,
				session.id
			);
			if (jobInfo && jobInfo.problem_statement) {
				let prompt = jobInfo.problem_statement;
				const titleMatch = jobInfo.problem_statement.match(/TITLE: \s*(.*)/i);
				if (titleMatch && titleMatch[1]) {
					prompt = titleMatch[1].trim();
				}
				Logger.appendLine(`Session 0: Found problem_statement from Jobs API: ${prompt}`, CopilotRemoteAgentManager.ID);
				return prompt;
			}
		} catch (error) {
			Logger.warn(`Failed to get job info for session ${session.id}: ${error}`, CopilotRemoteAgentManager.ID);
		}
		return defaultPrompt;
	}

	private async getFollowUpSessionPrompt(
		sessionIndex: number,
		timelineEvents: readonly TimelineEvent[],
		defaultPrompt: string
	): Promise<string> {
		const copilotStartedEvents = timelineEvents
			.filter((event): event is CopilotStartedEvent => event.event === EventType.CopilotStarted)
			.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

		const copilotFinishedEvents = timelineEvents
			.filter((event): event is CopilotFinishedEvent => event.event === EventType.CopilotFinished)
			.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

		Logger.appendLine(`Session ${sessionIndex}: Found ${copilotStartedEvents.length} CopilotStarted events and ${copilotFinishedEvents.length} CopilotFinished events`, CopilotRemoteAgentManager.ID);

		const copilotStartedEvent = copilotStartedEvents[sessionIndex];
		if (!copilotStartedEvent) {
			Logger.appendLine(`Session ${sessionIndex}: No CopilotStarted event found at index ${sessionIndex}`, CopilotRemoteAgentManager.ID);
			return defaultPrompt;
		}

		const currentSessionStartTime = new Date(copilotStartedEvent.createdAt).getTime();
		const previousSessionEndTime = this.getPreviousSessionEndTime(sessionIndex, copilotFinishedEvents);

		const relevantEvents = this.findRelevantTimelineEvents(timelineEvents, previousSessionEndTime, currentSessionStartTime);

		const matchingEvent = relevantEvents[0];
		if (matchingEvent) {
			const prompt = this.extractPromptFromEvent(matchingEvent);
			Logger.appendLine(`Session ${sessionIndex}: Found matching event - ${matchingEvent.event}`, CopilotRemoteAgentManager.ID);
			return prompt;
		} else {
			Logger.appendLine(`Session ${sessionIndex}: No matching event found between times ${previousSessionEndTime} and ${currentSessionStartTime}`, CopilotRemoteAgentManager.ID);
			Logger.appendLine(`Session ${sessionIndex}: Relevant events found: ${relevantEvents.length}`, CopilotRemoteAgentManager.ID);
			return defaultPrompt;
		}
	}

	private getPreviousSessionEndTime(sessionIndex: number, copilotFinishedEvents: CopilotFinishedEvent[]): number {
		if (sessionIndex > 0 && copilotFinishedEvents[sessionIndex - 1]) {
			return new Date(copilotFinishedEvents[sessionIndex - 1].createdAt).getTime();
		}
		return 0;
	}

	private findRelevantTimelineEvents(
		timelineEvents: readonly TimelineEvent[],
		previousSessionEndTime: number,
		currentSessionStartTime: number
	): TimelineEvent[] {
		return timelineEvents
			.filter(event => {
				if (event.event !== EventType.Commented && event.event !== EventType.Reviewed) {
					return false;
				}

				const eventTime = new Date(
					event.event === EventType.Commented ? (event as CommentEvent).createdAt :
						event.event === EventType.Reviewed ? (event as ReviewEvent).submittedAt : ''
				).getTime();

				// Must be after previous session and before current session
				return eventTime > previousSessionEndTime && eventTime < currentSessionStartTime;
			})
			.filter(event => {
				if (event.event === EventType.Commented) {
					const comment = event as CommentEvent;
					return comment.body.includes('@copilot') || comment.body.includes(COPILOT);
				} else if (event.event === EventType.Reviewed) {
					const review = event as ReviewEvent;
					return review.body.includes('@copilot') || review.body.includes(COPILOT);
				}
				return false;
			})
			.sort((a, b) => {
				const timeA = new Date(
					a.event === EventType.Commented ? (a as CommentEvent).createdAt :
						a.event === EventType.Reviewed ? (a as ReviewEvent).submittedAt : ''
				).getTime();
				const timeB = new Date(
					b.event === EventType.Commented ? (b as CommentEvent).createdAt :
						b.event === EventType.Reviewed ? (b as ReviewEvent).submittedAt : ''
				).getTime();
				return timeB - timeA; // Most recent first (closest to session start)
			});
	}

	private async createResponseTurn(pullRequest: PullRequestModel, logs: string, session: SessionInfo): Promise<vscode.ChatResponseTurn2 | undefined> {
		if (logs.trim().length > 0) {
			return await this.parseSessionLogsIntoResponseTurn(pullRequest, logs, session);
		} else if (session.state === 'in_progress') {
			// For in-progress sessions without logs, create a placeholder response
			const placeholderParts = [new vscode.ChatResponseProgressPart('Session is initializing...')];
			const responseResult: vscode.ChatResult = {};
			return new vscode.ChatResponseTurn2(placeholderParts, responseResult, 'copilot-swe-agent');
		} else {
			// For completed sessions without logs, add an empty response to maintain pairing
			const emptyParts = [new vscode.ChatResponseMarkdownPart('_No logs available for this session_')];
			const responseResult: vscode.ChatResult = {};
			return new vscode.ChatResponseTurn2(emptyParts, responseResult, 'copilot-swe-agent');
		}
	}

	private findActiveResponseCallback(
		sessions: SessionInfo[],
		pullRequest: PullRequestModel
	): ((stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => Thenable<void>) | undefined {
		// Only the latest in-progress session gets activeResponseCallback
		const inProgressSession = sessions
			.slice()
			.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
			.find(session => session.state === 'in_progress');

		if (inProgressSession) {
			return this.createActiveResponseCallback(pullRequest, inProgressSession.id);
		}
		return undefined;
	}

	private createRequestHandlerIfNeeded(pullRequest: PullRequestModel): vscode.ChatRequestHandler | undefined {
		return (pullRequest.state === GithubItemStateEnum.Open)
			? this.createRequestHandler(pullRequest)
			: undefined;
	}

	private createEmptySession(): vscode.ChatSession {
		return {
			history: [],
			requestHandler: undefined
		};
	}

	private createActiveResponseCallback(pullRequest: PullRequestModel, sessionId: string): (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => Thenable<void> {
		return async (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
			// Use the shared streaming logic
			return this.streamSessionLogs(stream, pullRequest, sessionId, token);
		};
	}

	private async streamNewLogContent(stream: vscode.ChatResponseStream, newLogContent: string): Promise<{ hasStreamedContent: boolean; hasSetupStepProgress: boolean }> {
		try {
			if (!newLogContent.trim()) {
				return { hasStreamedContent: false, hasSetupStepProgress: false };
			}

			// Parse the new log content
			const logChunks = parseSessionLogs(newLogContent);
			let hasStreamedContent = false;
			let hasSetupStepProgress = false;

			for (const chunk of logChunks) {
				for (const choice of chunk.choices) {
					const delta = choice.delta;

					if (delta.role === 'assistant') {
						// Handle special case for run_custom_setup_step
						if (choice.finish_reason === 'tool_calls' && delta.tool_calls?.length && delta.tool_calls[0].function.name === 'run_custom_setup_step') {
							const toolCall = delta.tool_calls[0];
							let args: any = {};
							try {
								args = JSON.parse(toolCall.function.arguments);
							} catch {
								// fallback to empty args
							}

							if (delta.content && delta.content.trim()) {
								// Finished setup step - create/update tool part
								const toolPart = this.createToolInvocationPart(toolCall, args.name || delta.content);
								if (toolPart) {
									stream.push(toolPart);
									hasStreamedContent = true;
								}
							} else {
								// Running setup step - just track progress
								hasSetupStepProgress = true;
								Logger.appendLine(`Setup step in progress: ${args.name || 'Unknown step'}`, CopilotRemoteAgentManager.ID);
							}
						} else {
							if (delta.content) {
								if (!delta.content.startsWith('<pr_title>')) {
									stream.markdown(delta.content);
									hasStreamedContent = true;
								}
							}

							if (delta.tool_calls) {
								for (const toolCall of delta.tool_calls) {
									const toolPart = this.createToolInvocationPart(toolCall, delta.content || '');
									if (toolPart) {
										stream.push(toolPart);
										hasStreamedContent = true;
									}
								}
							}
						}
					}

					// Handle finish reasons
					if (choice.finish_reason && choice.finish_reason !== 'null') {
						Logger.appendLine(`Streaming finish_reason: ${choice.finish_reason}`, CopilotRemoteAgentManager.ID);
					}
				}
			}

			if (hasStreamedContent) {
				Logger.appendLine(`Streamed content (markdown or tool parts), progress should be cleared`, CopilotRemoteAgentManager.ID);
			} else if (hasSetupStepProgress) {
				Logger.appendLine(`Setup step progress detected, keeping progress indicator`, CopilotRemoteAgentManager.ID);
			} else {
				Logger.appendLine(`No actual content streamed, progress may still be showing`, CopilotRemoteAgentManager.ID);
			}
			return { hasStreamedContent, hasSetupStepProgress };
		} catch (error) {
			Logger.error(`Error streaming new log content: ${error}`, CopilotRemoteAgentManager.ID);
			return { hasStreamedContent: false, hasSetupStepProgress: false };
		}
	}

	private async streamSessionLogs(stream: vscode.ChatResponseStream, pullRequest: PullRequestModel, sessionId: string, token: vscode.CancellationToken): Promise<void> {
		const capi = await this.copilotApi;
		if (!capi || token.isCancellationRequested) {
			return;
		}

		let lastLogLength = 0;
		let lastProcessedLength = 0;
		let hasActiveProgress = false;
		const pollingInterval = 3000; // 3 seconds

		return new Promise<void>((resolve, reject) => {
			let cancellationListener: vscode.Disposable | undefined;
			let isCompleted = false;

			const complete = async () => {
				if (isCompleted) {
					return;
				}
				isCompleted = true;
				cancellationListener?.dispose();

				const multiDiffPart = await this.getFileChangesMultiDiffPart(pullRequest);
				if (multiDiffPart) {
					stream.push(multiDiffPart);
				}

				resolve();
			};

			cancellationListener = token.onCancellationRequested(async () => {
				if (isCompleted) {
					return;
				}

				try {
					const sessionInfo = await capi.getSessionInfo(sessionId);
					if (sessionInfo && sessionInfo.state !== 'completed' && sessionInfo.workflow_run_id) {
						await pullRequest.githubRepository.cancelWorkflow(sessionInfo.workflow_run_id);
						stream.markdown(vscode.l10n.t('Session has been cancelled.'));
						complete();
					}
				} catch (error) {
					Logger.error(`Error while trying to cancel session ${sessionId} workflow: ${error}`, CopilotRemoteAgentManager.ID);
				}
			});

			const pollForUpdates = async (): Promise<void> => {
				try {
					if (token.isCancellationRequested) {
						complete();
						return;
					}

					// Get the specific session info
					const sessionInfo = await capi.getSessionInfo(sessionId);
					if (!sessionInfo || token.isCancellationRequested) {
						complete();
						return;
					}

					// Get session logs
					const logs = await capi.getLogsFromSession(sessionId);

					// Check if session is still in progress
					if (sessionInfo.state !== 'in_progress') {
						if (logs.length > lastProcessedLength) {
							const newLogContent = logs.slice(lastProcessedLength);
							const streamResult = await this.streamNewLogContent(stream, newLogContent);
							if (streamResult.hasStreamedContent) {
								hasActiveProgress = false;
							}
						}
						hasActiveProgress = false;
						complete();
						return;
					}

					if (logs.length > lastLogLength) {
						Logger.appendLine(`New logs detected, attempting to stream content`, CopilotRemoteAgentManager.ID);
						const newLogContent = logs.slice(lastProcessedLength);
						const streamResult = await this.streamNewLogContent(stream, newLogContent);
						lastProcessedLength = logs.length;

						if (streamResult.hasStreamedContent) {
							Logger.appendLine(`Content was streamed, resetting hasActiveProgress to false`, CopilotRemoteAgentManager.ID);
							hasActiveProgress = false;
						} else if (streamResult.hasSetupStepProgress) {
							Logger.appendLine(`Setup step progress detected, keeping progress active`, CopilotRemoteAgentManager.ID);
							// Keep hasActiveProgress as is, don't reset it
						} else {
							Logger.appendLine(`No content was streamed, keeping hasActiveProgress as ${hasActiveProgress}`, CopilotRemoteAgentManager.ID);
						}
					}

					lastLogLength = logs.length;

					if (!token.isCancellationRequested && sessionInfo.state === 'in_progress') {
						if (!hasActiveProgress) {
							Logger.appendLine(`Showing progress indicator (hasActiveProgress was false)`, CopilotRemoteAgentManager.ID);
							stream.progress('Working...');
							hasActiveProgress = true;
						} else {
							Logger.appendLine(`NOT showing progress indicator (hasActiveProgress was true)`, CopilotRemoteAgentManager.ID);
						}
						setTimeout(pollForUpdates, pollingInterval);
					} else {
						complete();
					}
				} catch (error) {
					Logger.error(`Error polling for session updates: ${error}`, CopilotRemoteAgentManager.ID);
					if (!token.isCancellationRequested) {
						setTimeout(pollForUpdates, pollingInterval);
					} else {
						reject(error);
					}
				}
			};

			// Start polling
			setTimeout(pollForUpdates, pollingInterval);
		});
	}

	private async getFileChangesMultiDiffPart(pullRequest: PullRequestModel): Promise<vscode.ChatResponseMultiDiffPart | undefined> {
		try {
			const repoInfo = await this.repoInfo();
			if (!repoInfo) {
				return undefined;
			}

			const { fm: folderManager } = repoInfo;
			const changeModels = await PullRequestModel.getChangeModels(folderManager, pullRequest);

			if (changeModels.length === 0) {
				return undefined;
			}

			const diffEntries: vscode.ChatResponseDiffEntry[] = [];
			for (const changeModel of changeModels) {
				diffEntries.push({
					originalUri: changeModel.parentFilePath,
					modifiedUri: changeModel.filePath,
					goToFileUri: changeModel.filePath
				});
			}

			const title = `Changes in Pull Request #${pullRequest.number}`;
			return new vscode.ChatResponseMultiDiffPart(diffEntries, title);
		} catch (error) {
			Logger.error(`Failed to get file changes multi diff part: ${error}`, CopilotRemoteAgentManager.ID);
			return undefined;
		}
	}

	private async findPullRequestById(number: number, fetch: boolean): Promise<PullRequestModel | undefined> {
		for (const folderManager of this.repositoriesManager.folderManagers) {
			for (const githubRepo of folderManager.gitHubRepositories) {
				const pullRequest = githubRepo.pullRequestModels.find(pr => pr.number === number);
				if (pullRequest) {
					return pullRequest;
				}

				if (fetch) {
					try {
						const pullRequest = await githubRepo.getPullRequest(number, false);
						if (pullRequest) {
							return pullRequest;
						}
					} catch (error) {
						// Continue to next repository if this one doesn't have the PR
						Logger.debug(`PR ${number} not found in ${githubRepo.remote.owner}/${githubRepo.remote.repositoryName}: ${error}`, CopilotRemoteAgentManager.ID);
					}
				}
			}
		}
		return undefined;
	}

	private createToolInvocationPart(toolCall: any, deltaContent: string = ''): vscode.ChatToolInvocationPart | undefined {
		if (!toolCall.function?.name || !toolCall.id) {
			return undefined;
		}

		// Hide reply_to_comment tool
		if (toolCall.function.name === 'reply_to_comment') {
			return undefined;
		}

		const toolPart = new vscode.ChatToolInvocationPart(toolCall.function.name, toolCall.id);
		toolPart.isComplete = true;
		toolPart.isError = false;
		toolPart.isConfirmed = true;

		try {
			const toolDetails = parseToolCallDetails(toolCall, deltaContent);
			toolPart.toolName = toolDetails.toolName;

			if (toolCall.function.name === 'bash') {
				toolPart.invocationMessage = new vscode.MarkdownString(`\`\`\`bash\n${toolDetails.invocationMessage}\n\`\`\``);
			} else {
				toolPart.invocationMessage = toolDetails.invocationMessage;
			}

			if (toolDetails.pastTenseMessage) {
				toolPart.pastTenseMessage = toolDetails.pastTenseMessage;
			}
			if (toolDetails.originMessage) {
				toolPart.originMessage = toolDetails.originMessage;
			}
			if (toolDetails.toolSpecificData) {
				toolPart.toolSpecificData = toolDetails.toolSpecificData;
			}
		} catch (error) {
			toolPart.toolName = toolCall.function.name || 'unknown';
			toolPart.invocationMessage = new vscode.MarkdownString(`Tool: ${toolCall.function.name}`);
			toolPart.isError = true;
		}

		return toolPart;
	}

	private async parseSessionLogsIntoResponseTurn(pullRequest: PullRequestModel, logs: string, session: SessionInfo): Promise<vscode.ChatResponseTurn2 | undefined> {
		try {
			const logChunks = parseSessionLogs(logs);
			const responseParts: Array<vscode.ChatResponseMarkdownPart | vscode.ChatToolInvocationPart | vscode.ChatResponseMultiDiffPart> = [];
			let currentResponseContent = '';

			for (const chunk of logChunks) {
				for (const choice of chunk.choices) {
					const delta = choice.delta;

					if (delta.role === 'assistant') {
						// Handle special case for run_custom_setup_step
						if (choice.finish_reason === 'tool_calls' && delta.tool_calls?.length && delta.tool_calls[0].function.name === 'run_custom_setup_step') {
							const toolCall = delta.tool_calls[0];
							let args: any = {};
							try {
								args = JSON.parse(toolCall.function.arguments);
							} catch {
								// fallback to empty args
							}

							// Ignore if delta.content is empty/undefined (running state)
							if (delta.content && delta.content.trim()) {
								// Add any accumulated content as markdown first
								if (currentResponseContent.trim()) {
									responseParts.push(new vscode.ChatResponseMarkdownPart(currentResponseContent.trim()));
									currentResponseContent = '';
								}

								const toolPart = this.createToolInvocationPart(toolCall, args.name || delta.content);
								if (toolPart) {
									responseParts.push(toolPart);
								}
							}
							// Skip if content is empty (running state)
						} else {
							if (delta.content) {
								if (!delta.content.startsWith('<pr_title>')) {
									currentResponseContent += delta.content;
								}
							}

							if (delta.tool_calls) {
								// Add any accumulated content as markdown first
								if (currentResponseContent.trim()) {
									responseParts.push(new vscode.ChatResponseMarkdownPart(currentResponseContent.trim()));
									currentResponseContent = '';
								}

								for (const toolCall of delta.tool_calls) {
									const toolPart = this.createToolInvocationPart(toolCall, delta.content || '');
									if (toolPart) {
										responseParts.push(toolPart);
									}
								}
							}
						}
					}
				}
			}

			if (currentResponseContent.trim()) {
				responseParts.push(new vscode.ChatResponseMarkdownPart(currentResponseContent.trim()));
			}

			if (session.state === 'completed' || session.state === 'failed' /** session can fail with proposed changes */) {
				const fileChangesPart = await this.getFileChangesMultiDiffPart(pullRequest);
				if (fileChangesPart) {
					responseParts.push(fileChangesPart);
				}
			}

			if (responseParts.length > 0) {
				const responseResult: vscode.ChatResult = {};
				return new vscode.ChatResponseTurn2(responseParts, responseResult, 'copilot-swe-agent');
			}

			return undefined;
		} catch (error) {
			Logger.error(`Failed to parse session logs into response turn: ${error}`, CopilotRemoteAgentManager.ID);
			return undefined;
		}
	}

	private createRequestHandler(pullRequest: PullRequestModel): vscode.ChatRequestHandler {
		return async (request: vscode.ChatRequest, _context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> => {
			try {
				if (token.isCancellationRequested) {
					return {};
				}

				// Validate user input
				const userPrompt = request.prompt;
				if (!userPrompt || userPrompt.trim().length === 0) {
					stream.markdown(vscode.l10n.t('Please provide a message for the coding agent.'));
					return {};
				}

				stream.progress('Working on your request...');

				// Add follow-up comment to the PR
				const result = await this.addFollowUpToExistingPR(pullRequest.number, userPrompt);
				if (!result) {
					stream.markdown(vscode.l10n.t('Failed to add follow-up comment to the pull request.'));
					return {};
				}

				// Show initial success message
				stream.markdown(result);
				stream.markdown('\n\n');

				// Wait for new session and stream its progress
				const newSession = await this.waitForNewSession(pullRequest, stream, token);
				if (!newSession) {
					return {};
				}

				// Stream the new session logs
				stream.markdown(vscode.l10n.t('Coding agent is now working on your request...'));
				stream.markdown('\n\n');

				await this.streamSessionLogs(stream, pullRequest, newSession.id, token);

				return {};
			} catch (error) {
				Logger.error(`Error in request handler: ${error}`, CopilotRemoteAgentManager.ID);
				stream.markdown(vscode.l10n.t('An error occurred while processing your request.'));
				return { errorDetails: { message: error.message } };
			}
		};
	}

	private async waitForNewSession(
		pullRequest: PullRequestModel,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<SessionInfo | undefined> {
		// Get the current number of sessions
		const capi = await this.copilotApi;
		if (!capi) {
			stream.markdown(vscode.l10n.t('Failed to connect to Copilot API.'));
			return undefined;
		}

		const initialSessions = await capi.getAllSessions(pullRequest.id);
		const initialSessionCount = initialSessions.length;

		// Poll for a new session to start
		const maxWaitTime = 5 * 60 * 1000; // 5 minutes
		const pollInterval = 3000; // 3 seconds
		const startTime = Date.now();

		while (Date.now() - startTime < maxWaitTime && !token.isCancellationRequested) {
			const currentSessions = await capi.getAllSessions(pullRequest.id);

			// Check if a new session has started
			if (currentSessions.length > initialSessionCount) {
				return currentSessions
					.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
			}

			await new Promise(resolve => setTimeout(resolve, pollInterval));
		}

		stream.markdown(vscode.l10n.t('Timed out waiting for the coding agent to respond. The agent may still be processing your request.'));
		return undefined;
	}

	private getIconForSession(status: CopilotPRStatus): vscode.Uri | vscode.ThemeIcon {
		// Use the same icons as webview components for consistency
		const themeData = this.repositoriesManager.folderManagers[0]?.themeWatcher?.themeData;
		if (!themeData) {
			// Fallback to theme icons if no theme data available
			switch (status) {
				case CopilotPRStatus.Completed:
					return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
				case CopilotPRStatus.Failed:
					return new vscode.ThemeIcon('close', new vscode.ThemeColor('testing.iconFailed'));
				default:
					return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('list.warningForeground'));
			}
		}

		// Use the same SVG icons as webview components with theme-appropriate colors
		const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
			vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
		const themeKind = isDark ? 'dark' : 'light';

		switch (status) {
			case CopilotPRStatus.Completed:
				return DataUri.copilotSuccessAsImageDataURI(
					getIconForeground(themeData, themeKind),
					getNotebookStatusSuccessIconForeground(themeData, themeKind)
				);
			case CopilotPRStatus.Failed:
				return DataUri.copilotErrorAsImageDataURI(
					getIconForeground(themeData, themeKind),
					getListErrorForeground(themeData, themeKind)
				);
			default:
				return DataUri.copilotInProgressAsImageDataURI(
					getIconForeground(themeData, themeKind),
					getListWarningForeground(themeData, themeKind)
				);
		}
	}

	public refreshChatSessions(): void {
		this._onDidChangeChatSessions.fire();
	}
}