/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import vscode, { ThemeIcon } from 'vscode';
import { parseSessionLogs, parseToolCallDetails } from '../../common/sessionParsing';
import { Repository } from '../api/api';
import { COPILOT_LOGINS, copilotEventToStatus, CopilotPRStatus, mostRecentCopilotEvent } from '../common/copilot';
import { commands } from '../common/executeCommands';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { GitHubRemote } from '../common/remote';
import { CODING_AGENT, CODING_AGENT_AUTO_COMMIT_AND_PUSH, CODING_AGENT_ENABLED } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { CommentEvent, CopilotFinishedEvent, CopilotStartedEvent, EventType, ReviewEvent, TimelineEvent } from '../common/timelineEvent';
import { toOpenPullRequestWebviewUri } from '../common/uri';
import { OctokitCommon } from './common';
import { ChatSessionWithPR, CopilotApi, getCopilotApi, RemoteAgentJobPayload, SessionInfo, SessionSetupStep } from './copilotApi';
import { CopilotPRWatcher, CopilotStateModel } from './copilotPrWatcher';
import { CredentialStore } from './credentials';
import { FolderRepositoryManager } from './folderRepositoryManager';
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
}

const LEARN_MORE = vscode.l10n.t('Learn about coding agent');
// Without Pending Changes
const CONTINUE = vscode.l10n.t('Continue');
// With Pending Changes
const PUSH_CHANGES = vscode.l10n.t('Include changes');
const CONTINUE_WITHOUT_PUSHING = vscode.l10n.t('Ignore changes');
const COMMIT_YOUR_CHANGES = vscode.l10n.t('Commit your changes to continue coding agent session. Close integrated terminal to cancel.');

const FOLLOW_UP_REGEX = /open-pull-request-webview.*((%7B.*?%7D)|(\{.*?\}))/;
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

	private parseFollowup(followup: string | undefined, repoInfo: { owner: string; repo: string }): number | undefined {
		if (!followup) {
			return;
		}
		const match = followup.match(FOLLOW_UP_REGEX);
		if (!match || match.length < 2) {
			Logger.error(`Ignoring. Invalid followup format: ${followup}`, CopilotRemoteAgentManager.ID);
			return;
		}

		try {
			const followUpData = JSON.parse(decodeURIComponent(match[1]));
			if (!followUpData || !followUpData.owner || !followUpData.repo || !followUpData.pullRequestNumber) {
				Logger.error(`Ignoring. Invalid followup data: ${followUpData}`, CopilotRemoteAgentManager.ID);
				return;
			}

			if (repoInfo.owner !== followUpData.owner || repoInfo.repo !== followUpData.repo) {
				Logger.error(`Ignoring. Follow up data does not match current repository: ${JSON.stringify(followUpData)}`, CopilotRemoteAgentManager.ID);
				return;
			}
			return followUpData.pullRequestNumber;
		} catch (error) {
			Logger.error(`Ignoring. Error while parsing follow up data: ${followup}`, CopilotRemoteAgentManager.ID);
		}
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

	async commandImpl(args?: ICopilotRemoteAgentCommandArgs): Promise<string | undefined> {
		if (!args) {
			return;
		}
		const { userPrompt, summary, source, followup } = args;

		/* __GDPR__
			"remoteAgent.command.args" : {
				"source" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"isFollowup" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"userPromptLength" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"summaryLength" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetry.sendTelemetryEvent('remoteAgent.command.args', {
			source: source?.toString() || 'unknown',
			isFollowup: !!followup ? 'true' : 'false',
			userPromptLength: userPrompt.length.toString(),
			summaryLength: summary ? summary.length.toString() : '0'
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
		const detail = vscode.l10n.t('Your current chat session will end, and its context will be used to continue your work in a new pull request.');
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
		} else {
			// No pending changes modal
			const modalResult = await vscode.window.showInformationMessage(
				source !== 'prompt' ? message : vscode.l10n.t('Copilot coding agent will implement the specification outlined in this prompt file'),
				{
					modal: true,
					detail: source !== 'prompt' ? detail : undefined
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
		if (vscode.workspace.getConfiguration('chat').get('agentSessionsViewLocation') === 'disabled') {
			vscode.commands.executeCommand('vscode.open', webviewUri);
		} else {
			await this.provideChatSessions(new vscode.CancellationTokenSource().token);

			const capi = await this.copilotApi;
			if (!capi) {
				return;
			}

			const sessions = await capi.getAllCodingAgentPRs(this.repositoriesManager);
			const pr = sessions.find(session => session.number === number);

			if (pr) {
				vscode.window.showChatSession('copilot-swe-agent', `${pr.id}`, {});
			}
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
			const prLlmString = `The remote agent has begun work. The user can track progress on GitHub.com by visiting ${pull_request.html_url} and within VS Code by visiting ${webviewUri.toString()}. Format all links as markdown (eg: [link text](url)).`;
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

	clearNotifications() {
		this._stateModel.clearNotifications();
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

			const sessions = await capi.getAllCodingAgentPRs(this.repositoriesManager);
			return await Promise.all(sessions.map(async session => {
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
					id: `${session.id}`,
					label: session.title || `Session ${session.id}`,
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

		// Return the full body, including @copilot mention
		return body.trim();
	}

	public async provideChatSessionContent(id: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		try {
			const capi = await this.copilotApi;
			if (!capi || token.isCancellationRequested) {
				return this.createEmptySession();
			}

			const pullRequestId = parseInt(id);
			if (isNaN(pullRequestId)) {
				Logger.error(`Invalid pull request ID: ${id}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			// Find the pull request model
			const pullRequest = this.findPullRequestById(pullRequestId);
			if (!pullRequest) {
				Logger.error(`Pull request not found: ${pullRequestId}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			// Get all sessions for this PR
			const sessions = await capi.getAllSessions(pullRequest.id);
			if (!sessions || sessions.length === 0) {
				Logger.warn(`No sessions found for pull request ${pullRequestId}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			// Ensure sessions is an array
			if (!Array.isArray(sessions)) {
				Logger.error(`getAllSessions returned non-array: ${typeof sessions}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			// Sort sessions by created_at to ensure chronological order
			const sortedSessions = sessions.slice().sort((a, b) =>
				new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
			);

			// Parse all sessions into chat history
			const history: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2> = [];
			let activeResponseCallback: ((stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => Thenable<void>) | undefined;

			// Get timeline events to match sessions with comments
			let timelineEvents: readonly TimelineEvent[] = await pullRequest.getTimelineEvents(pullRequest);


			const copilotComments = timelineEvents
				.filter((event): event is CommentEvent => event.event === EventType.Commented)
				.filter(comment => comment.body.includes('@copilot') || comment.body.includes(COPILOT))
				.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

			Logger.appendLine(`Found ${copilotComments.length} copilot comments in timeline`, CopilotRemoteAgentManager.ID);

			for (const [sessionIndex, session] of sortedSessions.entries()) {
				// Get logs for this session
				const logs = await capi.getLogsFromSession(session.id);

				// Try to find a matching comment for this session
				let sessionPrompt = session.name || `Session ${sessionIndex + 1} (ID: ${session.id})`;

				// For the first session, try to get the problem statement from the Jobs API
				if (sessionIndex === 0) {
					try {
						const jobInfo = await capi.getJobBySessionId(pullRequest.base.repositoryCloneUrl.owner, pullRequest.base.repositoryCloneUrl.repositoryName, session.id);
						if (jobInfo && jobInfo.problem_statement) {
							sessionPrompt = jobInfo.problem_statement;
							const titleMatch = jobInfo.problem_statement.match(/TITLE: \s*(.*)/i);
							if (titleMatch && titleMatch[1]) {
								sessionPrompt = titleMatch[1].trim();
							}
							Logger.appendLine(`Session ${sessionIndex}: Found problem_statement from Jobs API: ${sessionPrompt}`, CopilotRemoteAgentManager.ID);
						}
					} catch (error) {
						Logger.warn(`Failed to get job info for session ${session.id}: ${error}`, CopilotRemoteAgentManager.ID);
					}
				}

				// Find all CopilotStarted and CopilotFinished events
				const copilotStartedEvents = timelineEvents
					.filter((event): event is CopilotStartedEvent => event.event === EventType.CopilotStarted)
					.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

				const copilotFinishedEvents = timelineEvents
					.filter((event): event is CopilotFinishedEvent => event.event === EventType.CopilotFinished)
					.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

				Logger.appendLine(`Session ${sessionIndex}: Found ${copilotStartedEvents.length} CopilotStarted events and ${copilotFinishedEvents.length} CopilotFinished events`, CopilotRemoteAgentManager.ID);

				// For secondary sessions, try to match with timeline events
				if (sessionIndex > 0) {
					const copilotStartedEvent = copilotStartedEvents[sessionIndex];
					if (copilotStartedEvent) {

						// Find the time boundaries for this session
						const currentSessionStartTime = new Date(copilotStartedEvent.createdAt).getTime();

						// Find the end time of the previous session (if any)
						let previousSessionEndTime = 0;
						if (sessionIndex > 0 && copilotFinishedEvents[sessionIndex - 1]) {
							previousSessionEndTime = new Date(copilotFinishedEvents[sessionIndex - 1].createdAt).getTime();
						}

						// Find comments/reviews that are:
						// 1. After the previous session ended
						// 2. Before the current session started
						// 3. Contain @copilot mention
						const relevantEvents = timelineEvents
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


						const matchingEvent = relevantEvents[0];
						if (matchingEvent) {
							sessionPrompt = this.extractPromptFromEvent(matchingEvent);
							Logger.appendLine(`Session ${sessionIndex}: Found matching event - ${matchingEvent.event}`, CopilotRemoteAgentManager.ID);
						} else {
							Logger.appendLine(`Session ${sessionIndex}: No matching event found between times ${previousSessionEndTime} and ${currentSessionStartTime}`, CopilotRemoteAgentManager.ID);
							Logger.appendLine(`Session ${sessionIndex}: Relevant events found: ${relevantEvents.length}`, CopilotRemoteAgentManager.ID);
						}
					} else {
						Logger.appendLine(`Session ${sessionIndex}: No CopilotStarted event found at index ${sessionIndex}`, CopilotRemoteAgentManager.ID);
					}
				}


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

				// Parse session logs into response turn
				if (logs.trim().length > 0) {
					const sessionHistory = await this.parseSessionLogsIntoResponseTurn(logs, session);
					if (sessionHistory) {
						history.push(sessionHistory);
					}
				} else if (session.state === 'in_progress') {
					// For in-progress sessions without logs, create a placeholder response
					const placeholderParts = [new vscode.ChatResponseMarkdownPart('Session is initializing...')];
					const responseResult: vscode.ChatResult = {};
					history.push(new vscode.ChatResponseTurn2(placeholderParts, responseResult, 'copilot-swe-agent'));
				} else {
					// For completed sessions without logs, add an empty response to maintain pairing
					const emptyParts = [new vscode.ChatResponseMarkdownPart('_No logs available for this session_')];
					const responseResult: vscode.ChatResult = {};
					history.push(new vscode.ChatResponseTurn2(emptyParts, responseResult, 'copilot-swe-agent'));
				}

				// Only the latest in-progress session gets activeResponseCallback
				if (session.state === 'in_progress' && !activeResponseCallback) {
					activeResponseCallback = this.createActiveResponseCallback(pullRequest, session.id);
				}
			}

			// Create request handler if PR is open and allows follow-ups
			const requestHandler = (pullRequest.state === GithubItemStateEnum.Open)
				? this.createRequestHandler(pullRequest)
				: undefined;

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

	private async streamNewLogContent(stream: vscode.ChatResponseStream, newLogContent: string): Promise<boolean> {
		try {
			if (!newLogContent.trim()) {
				return false;
			}

			// Parse the new log content
			const logChunks = parseSessionLogs(newLogContent);
			let hasStreamedContent = false;

			for (const chunk of logChunks) {
				for (const choice of chunk.choices) {
					const delta = choice.delta;

					if (delta.role === 'assistant') {
						// Stream assistant content
						if (delta.content) {
							if (!delta.content.startsWith('<pr_title>')) {
								stream.markdown(delta.content);
								hasStreamedContent = true;
							}
						}

						// Handle tool calls
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

					// Handle finish reasons
					if (choice.finish_reason && choice.finish_reason !== 'null') {
						Logger.appendLine(`Streaming finish_reason: ${choice.finish_reason}`, CopilotRemoteAgentManager.ID);
					}
				}
			}

			if (hasStreamedContent) {
				Logger.appendLine(`Streamed content (markdown or tool parts), progress should be cleared`, CopilotRemoteAgentManager.ID);
			} else {
				Logger.appendLine(`No actual content streamed, progress may still be showing`, CopilotRemoteAgentManager.ID);
			}
			return hasStreamedContent;
		} catch (error) {
			Logger.error(`Error streaming new log content: ${error}`, CopilotRemoteAgentManager.ID);
			return false;
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
			const complete = () => {
				stream.push(new vscode.ChatResponseCommandButtonPart({
					title: vscode.l10n.t('Open Changes'),
					command: 'pr.openChanges',
					arguments: [pullRequest]
				}));

				resolve();
			};
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
						// Session completed, parse any remaining logs and stream final content
						if (logs.length > lastProcessedLength) {
							const newLogContent = logs.slice(lastProcessedLength);
							const didStreamContent = await this.streamNewLogContent(stream, newLogContent);
							if (didStreamContent) {
								hasActiveProgress = false;
							}
						}
						// Progress will be cleared by any final content streamed above
						hasActiveProgress = false;
						complete(); // Resolve the promise when session is complete
						return;
					}

					// Stream new content if logs have grown
					if (logs.length > lastLogLength) {
						Logger.appendLine(`New logs detected, attempting to stream content`, CopilotRemoteAgentManager.ID);
						const newLogContent = logs.slice(lastProcessedLength);
						const didStreamContent = await this.streamNewLogContent(stream, newLogContent);
						lastProcessedLength = logs.length;

						// Only reset progress state if we actually streamed content
						if (didStreamContent) {
							Logger.appendLine(`Content was streamed, resetting hasActiveProgress to false`, CopilotRemoteAgentManager.ID);
							hasActiveProgress = false;
						} else {
							Logger.appendLine(`No content was streamed, keeping hasActiveProgress as ${hasActiveProgress}`, CopilotRemoteAgentManager.ID);
						}
					}

					lastLogLength = logs.length;

					// Schedule next poll if still in progress and not cancelled
					if (!token.isCancellationRequested && sessionInfo.state === 'in_progress') {
						// Show progress indicator only if we don't already have one
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
					// Continue polling despite errors
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

	private findPullRequestById(id: number): PullRequestModel | undefined {
		for (const folderManager of this.repositoriesManager.folderManagers) {
			for (const githubRepo of folderManager.gitHubRepositories) {
				const pullRequest = githubRepo.pullRequestModels.find(pr => pr.id === id);
				if (pullRequest) {
					return pullRequest;
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

	private async parseSessionLogsIntoResponseTurn(logs: string, _session: SessionInfo): Promise<vscode.ChatResponseTurn2 | undefined> {
		try {
			const logChunks = parseSessionLogs(logs);
			const responseParts: Array<vscode.ChatResponseMarkdownPart | vscode.ChatToolInvocationPart> = [];
			let currentResponseContent = '';

			for (const chunk of logChunks) {
				for (const choice of chunk.choices) {
					const delta = choice.delta;

					if (delta.role === 'assistant') {
						if (delta.content) {
							if (!delta.content.startsWith('<pr_title>')) {
								currentResponseContent += delta.content;
							}
						}

						// Handle tool calls
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

			// Add any remaining content
			if (currentResponseContent.trim()) {
				responseParts.push(new vscode.ChatResponseMarkdownPart(currentResponseContent.trim()));
			}

			// Only create response turn if we have content
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

				// Get the current number of sessions
				const capi = await this.copilotApi;
				if (!capi) {
					stream.markdown(vscode.l10n.t('Failed to connect to Copilot API.'));
					return {};
				}

				const initialSessions = await capi.getAllSessions(pullRequest.id);
				const initialSessionCount = initialSessions.length;

				// Poll for a new session to start
				const maxWaitTime = 5 * 60 * 1000; // 5 minutes
				const pollInterval = 3000; // 3 seconds
				const startTime = Date.now();
				let newSession: SessionInfo | undefined;

				while (Date.now() - startTime < maxWaitTime && !token.isCancellationRequested) {
					const currentSessions = await capi.getAllSessions(pullRequest.id);

					// Check if a new session has started
					if (currentSessions.length > initialSessionCount) {
						// Find the new session (should be the last one)
						newSession = currentSessions
							.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
						break;
					}

					// Wait before polling again
					await new Promise(resolve => setTimeout(resolve, pollInterval));
				}

				if (!newSession) {
					// Progress will be cleared by the markdown message
					stream.markdown(vscode.l10n.t('Timed out waiting for the coding agent to respond. The agent may still be processing your request.'));
					return {};
				}

				// Stream the new session logs
				stream.markdown(vscode.l10n.t('Coding agent is now working on your request...'));
				stream.markdown('\n\n');

				// Use the same streaming logic as for in-progress sessions
				await this.streamSessionLogs(stream, pullRequest, newSession.id, token);

				return {};
			} catch (error) {
				Logger.error(`Error in request handler: ${error}`, CopilotRemoteAgentManager.ID);
				stream.markdown(vscode.l10n.t('An error occurred while processing your request.'));
				return { errorDetails: { message: error.message } };
			}
		};
	}

	private getIconForSession(status: CopilotPRStatus): ThemeIcon {
		switch (status) {
			case CopilotPRStatus.Completed:
				return new ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
			case CopilotPRStatus.Failed:
				return new ThemeIcon('close', new vscode.ThemeColor('testing.iconFailed'));
			default:
				return new ThemeIcon('circle-filled', new vscode.ThemeColor('list.warningForeground'));
		}
	}
}
