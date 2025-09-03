/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as pathLib from 'path';
import * as marked from 'marked';
import vscode, { ChatPromptReference } from 'vscode';
import { parseSessionLogs, parseToolCallDetails, StrReplaceEditorToolData } from '../../common/sessionParsing';
import { COPILOT_ACCOUNTS } from '../common/comment';
import { CopilotRemoteAgentConfig } from '../common/config';
import { COPILOT_LOGINS, COPILOT_SWE_AGENT, copilotEventToStatus, CopilotPRStatus, mostRecentCopilotEvent } from '../common/copilot';
import { commands } from '../common/executeCommands';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { GitHubRemote } from '../common/remote';
import { CODING_AGENT, CODING_AGENT_AUTO_COMMIT_AND_PUSH } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { toOpenPullRequestWebviewUri } from '../common/uri';
import { copilotEventToSessionStatus, copilotPRStatusToSessionStatus, IAPISessionLogs, ICopilotRemoteAgentCommandArgs, ICopilotRemoteAgentCommandResponse, OctokitCommon, RemoteAgentResult, RepoInfo } from './common';
import { ChatSessionFromSummarizedChat, ChatSessionWithPR, CopilotApi, getCopilotApi, RemoteAgentJobPayload, SessionInfo, SessionSetupStep } from './copilotApi';
import { CodingAgentPRAndStatus, CopilotPRWatcher, CopilotStateModel } from './copilotPrWatcher';
import { ChatSessionContentBuilder } from './copilotRemoteAgent/chatSessionContentBuilder';
import { GitOperationsManager } from './copilotRemoteAgent/gitOperationsManager';
import { CredentialStore } from './credentials';
import { FolderRepositoryManager, ReposManagerState } from './folderRepositoryManager';
import { GitHubRepository } from './githubRepository';
import { GithubItemStateEnum } from './interface';
import { issueMarkdown, PlainTextRenderer } from './markdownUtils';
import { PullRequestModel } from './pullRequestModel';
import { chooseItem } from './quickPicks';
import { RepositoriesManager } from './repositoriesManager';

const LEARN_MORE = vscode.l10n.t('Learn about coding agent');
// Without Pending Changes
const CONTINUE = vscode.l10n.t('Continue');
// With Pending Changes
const PUSH_CHANGES = vscode.l10n.t('Include changes');
const CONTINUE_WITHOUT_PUSHING = vscode.l10n.t('Ignore changes');
const CONTINUE_AND_DO_NOT_ASK_AGAIN = vscode.l10n.t('Continue and don\'t ask again');

const COPILOT = '@copilot';

const body_suffix = vscode.l10n.t('Created from VS Code via the [GitHub Pull Request](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github) extension.');

const PREFERRED_GITHUB_CODING_AGENT_REMOTE_WORKSPACE_KEY = 'PREFERRED_GITHUB_CODING_AGENT_REMOTE';

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

	private readonly gitOperationsManager: GitOperationsManager;
	private readonly ephemeralChatSessions: Map<string, ChatSessionFromSummarizedChat> = new Map();

	private codingAgentPRsPromise: Promise<{
		item: PullRequestModel;
		status: CopilotPRStatus;
	}[]> | undefined;

	constructor(private credentialStore: CredentialStore, public repositoriesManager: RepositoriesManager, private telemetry: ITelemetry, private context: vscode.ExtensionContext) {
		super();
		this.gitOperationsManager = new GitOperationsManager(CopilotRemoteAgentManager.ID);
		this._register(this.credentialStore.onDidChangeSessions((e: vscode.AuthenticationSessionsChangeEvent) => {
			if (e.provider.id === 'github') {
				this._copilotApiPromise = undefined; // Invalidate cached session
			}
		}));

		this._stateModel = new CopilotStateModel();
		this._register(new CopilotPRWatcher(this.repositoriesManager, this._stateModel));
		this._register(this._stateModel.onDidChangeStates(() => {
			this._onDidChangeStates.fire();
			this._onDidChangeChatSessions.fire();
		}));
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

	public get enabled(): boolean {
		return CopilotRemoteAgentConfig.getEnabled();
	}

	public get autoCommitAndPushEnabled(): boolean {
		return CopilotRemoteAgentConfig.getAutoCommitAndPushEnabled();
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
		if (!CopilotRemoteAgentConfig.getEnabled()) {
			return false;
		}

		if (!this.credentialStore.isAnyAuthenticated()) {
			// If not signed in, then we optimistically say it's available.
			return true;
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

	private firstFolderManager(): FolderRepositoryManager | undefined {
		if (!this.repositoriesManager.folderManagers.length) {
			return;
		}
		return this.repositoriesManager.folderManagers[0];
	}

	private chooseFolderManager(): Promise<FolderRepositoryManager | undefined> {
		return chooseItem<FolderRepositoryManager>(
			this.repositoriesManager.folderManagers,
			itemValue => pathLib.basename(itemValue.repository.rootUri.fsPath),
		);
	}

	public async resetCodingAgentPreferences() {
		await this.context.workspaceState.update(PREFERRED_GITHUB_CODING_AGENT_REMOTE_WORKSPACE_KEY, undefined);
	}

	public async promptAndUpdatePreferredGitHubRemote(skipIfValueAlreadyCached = false): Promise<void> {
		if (skipIfValueAlreadyCached) {
			const cachedValue = await this.context.workspaceState.get(PREFERRED_GITHUB_CODING_AGENT_REMOTE_WORKSPACE_KEY);
			if (cachedValue) {
				return;
			}
		}

		const fm = this.firstFolderManager();
		if (!fm) {
			return;
		}

		const ghRemotes = await fm.getAllGitHubRemotes();
		Logger.trace(`There are ${ghRemotes.length} GitHub remotes available to select from`, CopilotRemoteAgentManager.ID);
		if (!ghRemotes || ghRemotes.length <= 1) {
			Logger.trace('No need to select a coding agent GitHub remote, skipping prompt', CopilotRemoteAgentManager.ID);
			return;
		}

		const result = await chooseItem<GitHubRemote>(
			ghRemotes,
			itemValue => `${itemValue.remoteName} (${itemValue.owner}/${itemValue.repositoryName})`,
			{
				title: vscode.l10n.t('Set the GitHub remote to target when creating a coding agent session'),
			}
		);

		if (!result) {
			Logger.warn('No coding agent GitHub remote selected. Clearing preferences.', CopilotRemoteAgentManager.ID);
			return;
		}

		Logger.appendLine(`Updated '${result.remoteName}' as preferred coding agent remote`, CopilotRemoteAgentManager.ID);
		await this.context.workspaceState.update(PREFERRED_GITHUB_CODING_AGENT_REMOTE_WORKSPACE_KEY, result.remoteName);
	}

	async repoInfo(fm?: FolderRepositoryManager): Promise<RepoInfo | undefined> {
		fm = fm || this.firstFolderManager();
		const repository = fm?.repository;
		const ghRepository = fm?.gitHubRepositories.find(repo => repo.remote instanceof GitHubRemote) as GitHubRepository | undefined;
		if (!fm || !repository || !ghRepository) {
			return;
		}
		const baseRef = repository.state.HEAD?.name; // TODO: Consider edge cases
		const preferredRemoteName = this.context.workspaceState.get(PREFERRED_GITHUB_CODING_AGENT_REMOTE_WORKSPACE_KEY);
		const ghRemotes = await fm.getGitHubRemotes();
		if (!ghRemotes || ghRemotes.length === 0) {
			return;
		}

		const remote =
			preferredRemoteName
				? ghRemotes.find(remote => remote.remoteName === preferredRemoteName) // Cached preferred value
				: (ghRemotes.find(remote => remote.remoteName === 'origin') || ghRemotes[0]); // Fallback to the first remote

		if (!remote) {
			Logger.error(`no valid remotes for coding agent`, CopilotRemoteAgentManager.ID);
			// Clear preference, something is wrong
			this.context.workspaceState.update(PREFERRED_GITHUB_CODING_AGENT_REMOTE_WORKSPACE_KEY, undefined);
			return;
		}

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

	async tryPromptForAuthAndRepo(): Promise<FolderRepositoryManager | undefined> {
		const authResult = await this.credentialStore.tryPromptForCopilotAuth();
		if (!authResult) {
			return undefined;
		}
		// Wait for repos to update
		const fm = await this.chooseFolderManager();
		await fm?.updateRepositories();
		return fm;
	}

	async commandImpl(args?: ICopilotRemoteAgentCommandArgs): Promise<string | ICopilotRemoteAgentCommandResponse | undefined> {
		if (!args) {
			return;
		}
		const { userPrompt, summary, source, followup, _version } = args;
		const fm = await this.tryPromptForAuthAndRepo();
		if (!fm) {
			return;
		}

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

		const repoInfo = await this.repoInfo(fm);
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
			vscode.env.openExternal(vscode.Uri.parse('https://aka.ms/coding-agent-docs'));
		};

		let autoPushAndCommit = false;
		const message = vscode.l10n.t('Copilot coding agent will continue your work in \'{0}\'.', repoName);
		const detail = vscode.l10n.t('Your chat context will be used to continue work in a new pull request.');
		if (source !== 'prompt' && hasChanges && CopilotRemoteAgentConfig.getAutoCommitAndPushEnabled()) {
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
		} else if (CopilotRemoteAgentConfig.getPromptForConfirmation()) {
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
				await CopilotRemoteAgentConfig.disablePromptForConfirmation();
			}

			if (modalResult === LEARN_MORE) {
				learnMoreCb();
				return;
			}
		}

		const result = await this.invokeRemoteAgent(
			userPrompt,
			summary,
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

		/* __GDPR__
			"remoteAgent.command.success" : {
				"source" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"hasFollowup" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"outcome" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetry.sendTelemetryEvent('remoteAgent.command.success', {
			source: source || 'unknown',
			hasFollowup: (!!followup).toString(),
			outcome: 'success'
		});

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
				vscode.window.showChatSession(COPILOT_SWE_AGENT, `${pr.number}`, {});
			}
		}

		if (pr && (_version && _version === 2)) { /* version 2 means caller knows how to render this */
			const plaintextBody = marked.parse(pr.body, { renderer: new PlainTextRenderer(), }).trim();

			return {
				uri: webviewUri.toString(),
				title: pr.title,
				description: plaintextBody,
				author: COPILOT_ACCOUNTS[pr.author.login].name,
				linkTag: `#${pr.number}`
			};
		}

		// allow-any-unicode-next-line
		return vscode.l10n.t('🚀 Coding agent will continue work in [#{0}]({1}).  Track progress [here]({2}).', number, link, webviewUri.toString());
	}

	async invokeRemoteAgent(prompt: string, problemContext?: string, autoPushAndCommit = true): Promise<RemoteAgentResult> {
		const capiClient = await this.copilotApi;
		if (!capiClient) {
			return { error: vscode.l10n.t('Failed to initialize Copilot API'), state: 'error' };
		}

		await this.promptAndUpdatePreferredGitHubRemote(true);

		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			return { error: vscode.l10n.t('No repository information found. Please open a workspace with a GitHub repository.'), state: 'error' };
		}
		const { owner, repo, remote, repository, ghRepository, baseRef } = repoInfo;

		// NOTE: This is as unobtrusive as possible with the current high-level APIs.
		// We only create a new branch and commit if there are staged or working changes.
		// This could be improved if we add lower-level APIs to our git extension (e.g. in-memory temp git index).

		const base_ref = baseRef; // This is the ref the PR will merge into
		let head_ref: string | undefined; // This is the ref coding agent starts work from (omitted unless we push local changes)
		const hasChanges = autoPushAndCommit && (repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0);
		if (hasChanges) {
			if (!CopilotRemoteAgentConfig.getAutoCommitAndPushEnabled()) {
				return { error: vscode.l10n.t('Uncommitted changes detected. Please commit or stash your changes before starting the remote agent. Enable \'{0}\' to push your changes automatically.', CODING_AGENT_AUTO_COMMIT_AND_PUSH), state: 'error' };
			}
			try {
				head_ref = await this.gitOperationsManager.commitAndPushChanges(repoInfo);
			} catch (error) {
				return { error: error.message, state: 'error' };
			}
		}

		try {
			if (!(await ghRepository.hasBranch(base_ref))) {
				if (!CopilotRemoteAgentConfig.getAutoCommitAndPushEnabled()) {
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
		const titleMatch = problemContext?.match(/TITLE: \s*(.*)/i);
		if (titleMatch && titleMatch[1]) {
			title = titleMatch[1].trim();
		}

		const formatBodyPlaceholder = (problemContext: string): string => {
			const header = vscode.l10n.t('Coding agent has begun work on **{0}** and will replace this description as work progresses.', title);
			const collapsedContext = `<details><summary>${vscode.l10n.t('See problem context')}</summary>\n\n${problemContext}\n\n</details>`;
			return `${header}\n\n${collapsedContext}`;
		};

		const problemStatement: string = `${prompt}\n${problemContext ?? ''}`;
		const payload: RemoteAgentJobPayload = {
			problem_statement: problemStatement,
			event_type: 'visual_studio_code_remote_agent_tool_invoked',
			pull_request: {
				title,
				body_placeholder: formatBodyPlaceholder(problemContext || prompt),
				base_ref,
				body_suffix,
				...(head_ref && { head_ref })
			}
		};

		try {
			const { pull_request, session_id } = await capiClient.postRemoteAgentJob(owner, repo, payload);
			this._onDidCreatePullRequest.fire(pull_request.number);
			const webviewUri = await toOpenPullRequestWebviewUri({ owner, repo, pullRequestNumber: pull_request.number });
			const prLlmString = `The remote agent has begun work and has created a pull request. Details about the pull request are being shown to the user. If the user wants to track progress or iterate on the agent's work, they should use the pull request.`;
			return {
				state: 'success',
				number: pull_request.number,
				link: pull_request.html_url,
				webviewUri,
				llmDetails: head_ref ? `Local pending changes have been pushed to branch '${head_ref}'. ${prLlmString}` : prLlmString,
				sessionId: session_id
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
			.filter(run => run.path && run.path.startsWith(`dynamic/${COPILOT_SWE_AGENT}`))
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

	async extractHistory(history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>): Promise<string | undefined> {
		if (!history) {
			return;
		}
		const parts: string[] = [];
		for (const turn of history) {
			if (turn instanceof vscode.ChatRequestTurn) {
				parts.push(`User: ${turn.prompt}`);
			} else if (turn instanceof vscode.ChatResponseTurn) {
				const textParts = turn.response
					.filter(part => part instanceof vscode.ChatResponseMarkdownPart)
					.map(part => part.value);
				if (textParts.length > 0) {
					parts.push(`Copilot: ${textParts.join('\n')}`);
				}
			}
		}
		const fullText = parts.join('\n'); // TODO: Summarization if too long
		return fullText;
	}

	extractFileReferences(references: readonly ChatPromptReference[] | undefined): string | undefined {
		if (!references || references.length === 0) {
			return;
		}
		// 'file:///Users/jospicer/dev/joshbot/.github/workflows/build-vsix.yml'  -> '.github/workflows/build-vsix.yml'
		const parts: string[] = [];
		for (const ref of references) {
			if (ref.value instanceof vscode.Uri && ref.value.scheme === 'file') { // TODO: Add support for more kinds of references
				const workspaceFolder = vscode.workspace.getWorkspaceFolder(ref.value);
				if (workspaceFolder) {
					const relativePath = pathLib.relative(workspaceFolder.uri.fsPath, ref.value.fsPath);
					parts.push(` - ${relativePath}`);
				}
			}
		}

		if (!parts.length) {
			return;
		}

		parts.unshift('The user has attached the following files as relevant context:');
		return parts.join('\n');
	}

	cleanPrompt(prompt: string): string {
		// Remove #file:xxxx from the prompt
		return prompt.replace(/#file:\S+/g, '').trim();
	}

	public async provideNewChatSessionItem(options: { request: vscode.ChatRequest; prompt?: string; history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>; metadata?: any; }, token: vscode.CancellationToken): Promise<ChatSessionWithPR | ChatSessionFromSummarizedChat> {
		const { request, history } = options;
		if (!options.prompt) {
			throw new Error(`Prompt is expected to provide a new chat session item`);
		}

		const prompt = this.cleanPrompt(options.prompt);
		const { source, summary } = options.metadata || {};

		// Ephemeral session for new session creation flow
		if (source === 'chatExecuteActions') {
			const id = `new-${Date.now()}`;
			const val = {
				id,
				label: vscode.l10n.t('New coding agent session'),
				iconPath: new vscode.ThemeIcon('plus'),
				prompt,
				summary,
			};
			this.ephemeralChatSessions.set(id, val);
			return val;
		}

		const result = await this.invokeRemoteAgent(
			prompt,
			[
				this.extractFileReferences(request.references),
				await this.extractHistory(history)
			].join('\n\n').trim(),
			false,
		);
		if (result.state !== 'success') {
			Logger.error(`Failed to provide new chat session item: ${result.error}`, CopilotRemoteAgentManager.ID);
			throw new Error(`Failed to provide new chat session item: ${result.error}`);
		}

		const { number, sessionId } = result;

		const pullRequest = await this.findPullRequestById(number, true);
		if (!pullRequest) {
			throw new Error(`Failed to find session for pull request: ${number}`);
		}

		await this.waitForQueuedToInProgress(sessionId, token);

		const timeline = await pullRequest.getCopilotTimelineEvents(pullRequest);
		const status = copilotEventToSessionStatus(mostRecentCopilotEvent(timeline));
		const tooltip = await issueMarkdown(pullRequest, this.context, this.repositoriesManager);
		const timestampNumber = new Date(pullRequest.createdAt).getTime();
		const defaultBranch = await pullRequest.githubRepository.getDefaultBranch();
		const description = pullRequest.base.ref === defaultBranch ? `pull request #${pullRequest.number}` : `pull request #${pullRequest.number} → ${pullRequest.base.ref}`;
		return {
			id: `${pullRequest.number}`,
			label: pullRequest.title || `Session ${pullRequest.number}`,
			iconPath: this.getIconForSession(status),
			pullRequest: pullRequest,
			description: description,
			tooltip,
			status,
			timing: {
				startTime: timestampNumber
			}
		};
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

			let codingAgentPRs: CodingAgentPRAndStatus[] = [];
			if (this._stateModel.isInitialized) {
				codingAgentPRs = this._stateModel.all;
			} else {
				this.codingAgentPRsPromise = this.codingAgentPRsPromise ?? new Promise<CodingAgentPRAndStatus[]>(async (resolve) => {
					try {
						const sessions = await capi.getAllCodingAgentPRs(this.repositoriesManager);
						const prAndStatus = await Promise.all(sessions.map(async pr => {
							const timeline = await pr.getCopilotTimelineEvents(pr);
							const status = copilotEventToStatus(mostRecentCopilotEvent(timeline));
							return { item: pr, status };
						}));

						resolve(prAndStatus);
					} catch (error) {
						Logger.error(`Failed to fetch coding agent PRs: ${error}`, CopilotRemoteAgentManager.ID);
						resolve([]);
					}
				});
				codingAgentPRs = await this.codingAgentPRsPromise;
			}
			return await Promise.all(codingAgentPRs.map(async prAndStatus => {
				const timestampNumber = new Date(prAndStatus.item.createdAt).getTime();
				const status = copilotPRStatusToSessionStatus(prAndStatus.status);
				const pullRequest = prAndStatus.item;
				const tooltip = await issueMarkdown(pullRequest, this.context, this.repositoriesManager);

				const uri = await toOpenPullRequestWebviewUri({ owner: pullRequest.remote.owner, repo: pullRequest.remote.repositoryName, pullRequestNumber: pullRequest.number });
				const description = new vscode.MarkdownString(`[#${pullRequest.number}](${uri.toString()})`); //  pullRequest.base.ref === defaultBranch ? `PR #${pullRequest.number}`: `PR #${pullRequest.number} → ${pullRequest.base.ref}`;
				return {
					id: `${pullRequest.number}`,
					label: pullRequest.title || `Session ${pullRequest.number}`,
					iconPath: this.getIconForSession(status),
					pullRequest: pullRequest,
					description: description,
					tooltip,
					status,
					timing: {
						startTime: timestampNumber
					},
					statistics: pullRequest.item.additions !== undefined && pullRequest.item.deletions !== undefined && (pullRequest.item.additions > 0 || pullRequest.item.deletions > 0) ? {
						insertions: pullRequest.item.additions,
						deletions: pullRequest.item.deletions
					} : undefined
				};
			}));
		} catch (error) {
			Logger.error(`Failed to provide coding agents information: ${error}`, CopilotRemoteAgentManager.ID);
		}
		return [];
	}

	private async newSessionFlowFromPrompt(id: string): Promise<vscode.ChatSession> {
		const chatSession = this.ephemeralChatSessions.get(id);
		if (!chatSession) {
			return this.createEmptySession();
		}

		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			return this.createEmptySession(); // TODO: Explain how to enroll repo in coding agent, etc..?
		}
		const { repo, owner } = repoInfo;
		const { prompt, summary } = chatSession;
		const sessionRequest = new vscode.ChatRequestTurn2(
			prompt,
			undefined,
			[],
			COPILOT_SWE_AGENT,
			[],
			[]
		);

		const placeholderParts = [
			new vscode.ChatResponseProgressPart(vscode.l10n.t('Starting coding agent session...')),
			new vscode.ChatResponseConfirmationPart(
				vscode.l10n.t('Copilot coding agent will continue your work in \'{0}\'.', `${owner}/${repo}`),
				vscode.l10n.t('Your chat context will be used to continue work in a new pull request.'),
				'invoke', // Next state
				['Continue', 'Cancel']
			)
		];

		const placeholderTurn = new vscode.ChatResponseTurn2(placeholderParts, {}, COPILOT_SWE_AGENT);
		return {
			history: [sessionRequest, placeholderTurn],
			requestHandler: async (request: vscode.ChatRequest, _context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> => {
				if (token.isCancellationRequested) {
					return {};
				}
				if (request.acceptedConfirmationData) {
					if (!Array.isArray(request.acceptedConfirmationData)) {
						Logger.error(`Invalid confirmation data: ${request.acceptedConfirmationData}`, CopilotRemoteAgentManager.ID);
						return {};
					}
					const states = request.acceptedConfirmationData as string[];
					while (states.length) {
						const state = states.shift();
						if (!state) {
							continue;
						}
						switch (state) {
							case 'invoke':
								// TODO: Refactor of invokeRemoteAgent needed to extract all user prompts
								//       Move any user action to a state in this state machine.
								stream.progress('Delegating to coding agent');
								const result = await this.invokeRemoteAgent(
									prompt,
									summary || prompt,
									false,
								);
								this.ephemeralChatSessions.delete(id); // TODO: Better state management
								if (result.state !== 'success') {
									stream.warning(`Could not create coding agent session: ${result.error}`);
									return {};
								}
								const pullRequest = await this.findPullRequestById(result.number, true);
								chatSession.pullRequest = pullRequest; // Cache for later
								if (!pullRequest) {
									stream.warning(`Could not find coding agent session.`);
									return {};
								}
								const capi = await this.copilotApi;
								if (!capi) {
									stream.warning(vscode.l10n.t('Could not initialize Copilot API.'));
									return {};
								}
								stream.markdown(vscode.l10n.t('Coding agent is now working on your request...'));
								stream.markdown('\n\n');
								await this.streamSessionLogs(stream, pullRequest, result.sessionId, token);
								return {};
							default:
								Logger.error(`Unknown confirmation state: ${state}`, CopilotRemoteAgentManager.ID);
								stream.markdown('error!');
								return {};
						}
					}
				}
				if (request.rejectedConfirmationData) {
					stream.push(new vscode.ChatResponseProgressPart(vscode.l10n.t('Cancelled starting coding agent session.')));
					return {};
				}
				return {};
			},
			activeResponseCallback: undefined,
		};
	}

	public async provideChatSessionContent(id: string, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		try {
			const capi = await this.copilotApi;
			if (!capi || token.isCancellationRequested) {
				return this.createEmptySession();
			}

			await this.waitRepoManagerInitialization();

			if (id.startsWith('new')) {
				return await this.newSessionFlowFromPrompt(id);
			}

			const pullRequestNumber = parseInt(id);
			if (isNaN(pullRequestNumber)) {
				Logger.error(`Invalid pull request number: ${id}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			const pullRequest = await this.findPullRequestById(pullRequestNumber, true);
			if (!pullRequest) {
				Logger.error(`Pull request not found: ${pullRequestNumber}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			// Parallelize independent operations
			const timelineEvents = pullRequest.getTimelineEvents();
			const changeModels = this.getChangeModels(pullRequest);
			const sessions = await capi.getAllSessions(pullRequest.id);

			if (!sessions || sessions.length === 0) {
				Logger.warn(`No sessions found for pull request ${pullRequestNumber}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			if (!Array.isArray(sessions)) {
				Logger.error(`getAllSessions returned non-array: ${typeof sessions}`, CopilotRemoteAgentManager.ID);
				return this.createEmptySession();
			}

			// Create content builder with pre-fetched change models
			const contentBuilder = new ChatSessionContentBuilder(CopilotRemoteAgentManager.ID, COPILOT, changeModels);

			// Parallelize operations that don't depend on each other
			const history = await contentBuilder.buildSessionHistory(sessions, pullRequest, capi, timelineEvents);
			return {
				history,
				activeResponseCallback: this.findActiveResponseCallback(sessions, pullRequest),
				requestHandler: this.createRequestHandlerIfNeeded(pullRequest)
			};
		} catch (error) {
			Logger.error(`Failed to provide chat session content: ${error}`, CopilotRemoteAgentManager.ID);
			return this.createEmptySession();
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

	private async streamNewLogContent(pullRequest: PullRequestModel, stream: vscode.ChatResponseStream, newLogContent: string): Promise<{ hasStreamedContent: boolean; hasSetupStepProgress: boolean }> {
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
						// Handle special case for run_custom_setup_step/run_setup
						if (choice.finish_reason === 'tool_calls' && delta.tool_calls?.length && (delta.tool_calls[0].function.name === 'run_custom_setup_step' || delta.tool_calls[0].function.name === 'run_setup')) {
							const toolCall = delta.tool_calls[0];
							let args: any = {};
							try {
								args = JSON.parse(toolCall.function.arguments);
							} catch {
								// fallback to empty args
							}

							if (delta.content && delta.content.trim()) {
								// Finished setup step - create/update tool part
								const toolPart = this.createToolInvocationPart(pullRequest, toolCall, args.name || delta.content);
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
									const toolPart = this.createToolInvocationPart(pullRequest, toolCall, delta.content || '');
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

				await pullRequest.getFileChangesInfo();
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
							const streamResult = await this.streamNewLogContent(pullRequest, stream, newLogContent);
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
						const streamResult = await this.streamNewLogContent(pullRequest, stream, newLogContent);
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

	private async getChangeModels(pullRequest: PullRequestModel) {
		try {
			const repoInfo = await this.repoInfo();
			if (!repoInfo) {
				return [];
			}

			const { fm: folderManager } = repoInfo;
			return await PullRequestModel.getChangeModels(folderManager, pullRequest);
		} catch (error) {
			Logger.error(`Failed to get change models: ${error}`, CopilotRemoteAgentManager.ID);
			return [];
		}
	}

	private async getFileChangesMultiDiffPart(pullRequest: PullRequestModel): Promise<vscode.ChatResponseMultiDiffPart | undefined> {
		try {
			const changeModels = await this.getChangeModels(pullRequest);
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

	private createToolInvocationPart(pullRequest: PullRequestModel, toolCall: any, deltaContent: string = ''): vscode.ChatToolInvocationPart | vscode.ChatResponseThinkingProgressPart | undefined {
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

			if (toolCall.toolName === 'think') {
				return new vscode.ChatResponseThinkingProgressPart(toolCall.invocationMessage);
			}

			if (toolCall.function.name === 'bash') {
				toolPart.invocationMessage = new vscode.MarkdownString(`\`\`\`bash\n${toolDetails.invocationMessage}\n\`\`\``);
			} else {
				toolPart.invocationMessage = new vscode.MarkdownString(toolDetails.invocationMessage);
			}

			if (toolDetails.pastTenseMessage) {
				toolPart.pastTenseMessage = new vscode.MarkdownString(toolDetails.pastTenseMessage);
			}
			if (toolDetails.originMessage) {
				toolPart.originMessage = new vscode.MarkdownString(toolDetails.originMessage);
			}
			if (toolDetails.toolSpecificData) {
				if (StrReplaceEditorToolData.is(toolDetails.toolSpecificData)) {
					if ((toolDetails.toolSpecificData.command === 'view' || toolDetails.toolSpecificData.command === 'edit') && toolDetails.toolSpecificData.fileLabel) {
						const uri = vscode.Uri.file(pathLib.join(pullRequest.githubRepository.rootUri.fsPath, toolDetails.toolSpecificData.fileLabel));
						toolPart.invocationMessage = new vscode.MarkdownString(`${toolPart.toolName} [](${uri.toString()})`);
						toolPart.invocationMessage.supportHtml = true;
						toolPart.pastTenseMessage = new vscode.MarkdownString(`${toolPart.toolName} [](${uri.toString()})`);
					}
				} else {
					toolPart.toolSpecificData = toolDetails.toolSpecificData;
				}
			}
		} catch (error) {
			toolPart.toolName = toolCall.function.name || 'unknown';
			toolPart.invocationMessage = new vscode.MarkdownString(`Tool: ${toolCall.function.name}`);
			toolPart.isError = true;
		}

		return toolPart;
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

	private async waitForQueuedToInProgress(
		sessionId: string,
		token: vscode.CancellationToken
	): Promise<SessionInfo | undefined> {
		const capi = await this.copilotApi;
		if (!capi) {
			return undefined;
		}

		const maxWaitTime = 2 * 60 * 1_000; // 2 minutes
		const pollInterval = 3_000; // 3 seconds
		const startTime = Date.now();

		const sessionInfo = await capi.getSessionInfo(sessionId);
		if (!sessionInfo || sessionInfo.state !== 'queued') {
			return;
		}

		Logger.appendLine(`Session ${sessionInfo.id} is queued, waiting to start...`, CopilotRemoteAgentManager.ID);
		while (Date.now() - startTime < maxWaitTime && !token.isCancellationRequested) {
			const sessionInfo = await capi.getSessionInfo(sessionId);
			if (sessionInfo?.state === 'in_progress') {
				Logger.appendLine(`Session ${sessionInfo.id} now in progress.`, CopilotRemoteAgentManager.ID);
				return sessionInfo;
			}
			await new Promise(resolve => setTimeout(resolve, pollInterval));
		}
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

	private getIconForSession(status: vscode.ChatSessionStatus): vscode.Uri | vscode.ThemeIcon {
		// Fallback to theme icons if no theme data available
		switch (status) {
			case vscode.ChatSessionStatus.Completed:
				return new vscode.ThemeIcon('issues', new vscode.ThemeColor('testing.iconPassed'));
			case vscode.ChatSessionStatus.Failed:
				return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
			default:
				return new vscode.ThemeIcon('issue-reopened', new vscode.ThemeColor('editorLink.activeForeground'));
		}
	}

	public refreshChatSessions(): void {
		this._stateModel.clear();
	}

	public async cancelMostRecentChatSession(pullRequest: PullRequestModel): Promise<void> {
		const capi = await this.copilotApi;
		if (!capi) {
			Logger.warn(`No Copilot API instance found`);
			return;
		}

		const folderManager = this.repositoriesManager.getManagerForIssueModel(pullRequest) ?? this.repositoriesManager.folderManagers[0];
		if (!folderManager) {
			Logger.warn(`No folder manager found for pull request`);
			return;
		}

		const sessions = await capi.getAllSessions(pullRequest.id);
		if (sessions.length > 0) {
			const mostRecentSession = sessions[sessions.length - 1];
			const folder = folderManager.gitHubRepositories.find(repo => repo.remote.remoteName === pullRequest.remote.remoteName);
			folder?.cancelWorkflow(mostRecentSession.workflow_run_id);
		} else {
			Logger.warn(`No active chat session found for pull request ${pullRequest.id}`);
		}
	}
}