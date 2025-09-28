/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as pathLib from 'path';
import * as vscode from 'vscode';
import type { Change } from '../../api/api';
import { Status } from '../../api/api1';
import Logger from '../../common/logger';
import { ITelemetry } from '../../common/telemetry';
import { toReviewUri } from '../../common/uri';
import { getNonce, IRequestMessage, WebviewBase } from '../../common/webview';
import { CreatePullRequestDataModel } from '../../view/createPullRequestDataModel';
import { ReviewManager } from '../../view/reviewManager';
import { ReviewsManager } from '../../view/reviewsManager';
import { FolderRepositoryManager, ReposManagerState } from '../folderRepositoryManager';
import { IssueOverviewPanel } from '../issueOverview';
import { PullRequestModel } from '../pullRequestModel';
import { PullRequestOverviewPanel } from '../pullRequestOverview';
import { RepositoriesManager } from '../repositoriesManager';
import { TaskChatHandler } from './taskChatHandler';
import { IssueData, TaskData, TaskManager, TaskPr } from './taskManager';

export interface DashboardLoading {
	readonly state: 'loading';
	readonly issueQuery: string;
}

export interface DashboardReady {
	readonly state: 'ready';
	readonly issueQuery: string;
	readonly activeSessions: TaskData[];
	readonly milestoneIssues: IssueData[];
	readonly repository?: {
		readonly owner: string;
		readonly name: string;
	};
	readonly currentBranch?: string;
}


export class TaskDashboardWebview extends WebviewBase {
	private static readonly ID = 'DashboardWebviewProvider';

	private readonly _chatHandler: TaskChatHandler;

	private _branchChangeTimeout: NodeJS.Timeout | undefined;

	private _issueQuery: string;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _taskManager: TaskManager,
		private readonly _reviewsManager: ReviewsManager,
		private readonly _telemetry: ITelemetry,
		private readonly _extensionUri: vscode.Uri,
		panel: vscode.WebviewPanel,
		issueQuery: string,
	) {
		super();

		this._webview = panel.webview;
		this._issueQuery = issueQuery;
		this._chatHandler = new TaskChatHandler(this._taskManager, this._repositoriesManager, issueQuery, this);

		this.registerBranchChangeListeners();
		this.registerRepositoryLoadListeners();

		super.initialize();

		this._webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};

		this._webview.html = this.getHtmlForWebview();

		// Initial data will be sent when webview sends 'ready' message
	}

	public override dispose() {
		super.dispose();

		if (this._branchChangeTimeout) {
			clearTimeout(this._branchChangeTimeout);
		}
		this._branchChangeTimeout = undefined;
	}

	public async updateConfiguration(issueQuery: string): Promise<void> {
		this._issueQuery = issueQuery;
		await this.updateDashboard();
	}

	private async updateDashboard(): Promise<void> {
		try {
			// Wait for repositories to be loaded before fetching data
			await this.waitForRepositoriesReady();

			// Check if we actually have folder managers available before proceeding
			if (!this._repositoriesManager.folderManagers || this._repositoriesManager.folderManagers.length === 0) {
				// Don't send ready state if we don't have folder managers yet
				return;
			}

			const [activeSessions, milestoneIssues] = await Promise.all([
				this.getActiveSessions(),
				this.getMilestoneIssues()
			]);

			// Get current repository info and branch
			let repository: { owner: string; name: string } | undefined;
			let currentBranch: string | undefined;
			const targetRepos = this.getTargetRepositories();
			if (targetRepos.length > 0) {
				const [owner, name] = targetRepos[0].split('/');
				if (owner && name) {
					repository = { owner, name };
				}
			}

			// Get current branch name
			if (this._repositoriesManager.folderManagers.length > 0) {
				const folderManager = this._repositoriesManager.folderManagers[0];
				currentBranch = folderManager.repository.state.HEAD?.name;
			}

			const readyData: DashboardReady = {
				state: 'ready',
				issueQuery: this._issueQuery,
				activeSessions: activeSessions,
				milestoneIssues: milestoneIssues,
				repository,
				currentBranch
			};
			this._postMessage({
				command: 'update-dashboard',
				data: readyData
			});
		} catch (error) {
			Logger.error(`Failed to update dashboard: ${error}`, TaskDashboardWebview.ID);
		}
	}

	private async waitForRepositoriesReady(): Promise<void> {
		// If repositories are already loaded, return immediately
		if (this._repositoriesManager.state === ReposManagerState.RepositoriesLoaded) {
			return;
		}

		// If we need authentication, we can't load repositories
		if (this._repositoriesManager.state === ReposManagerState.NeedsAuthentication) {

			return;
		}

		// Wait for repositories to be loaded
		return new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {

				resolve();
			}, 10000); // 10 second timeout

			const disposable = this._repositoriesManager.onDidChangeState(() => {
				if (this._repositoriesManager.state === ReposManagerState.RepositoriesLoaded ||
					this._repositoriesManager.state === ReposManagerState.NeedsAuthentication) {
					clearTimeout(timeout);
					disposable.dispose();
					resolve();
				}
			});
		});
	}


	private async getActiveSessions(): Promise<TaskData[]> {
		const targetRepos = this.getTargetRepositories();
		return await this._taskManager.getActiveSessions(targetRepos);
	}

	public async switchToLocalTask(branchName: string, pullRequestInfo?: TaskPr): Promise<void> {

		if (pullRequestInfo) {
			const pullRequestModel = await this.toPrModelAndFolderManager(pullRequestInfo);
			if (pullRequestModel) {
				await this.checkoutPullRequestBranch(pullRequestModel.prModel);
			}
		} else {
			// Switch to the branch first
			await this._taskManager.switchToLocalTask(branchName);

			// Open the combined diff view for all changes in the branch
			await this.openBranchDiffView(branchName);
		}

		// Update dashboard to reflect current branch change
		setTimeout(() => {
			this.updateDashboard();
		}, 500);
	}

	private async openBranchDiffView(branchName: string): Promise<void> {
		try {
			// Find the folder manager that has this branch
			const folderManager = this._repositoriesManager.folderManagers.find(fm =>
				fm.gitHubRepositories.length > 0
			);

			if (!folderManager) {
				vscode.window.showErrorMessage('No GitHub repository found in the current workspace.');
				return;
			}

			const baseBranch = await this.getDefaultBranch(folderManager) || 'main';
			const changes = await this.getBranchChanges(folderManager, branchName, baseBranch);

			if (changes.length === 0) {
				vscode.window.showInformationMessage(`No changes found in branch ${branchName}`);
				return;
			}

			// Get commit SHAs for both branches
			const repository = folderManager.repository;
			const baseCommit = await repository.getCommit('refs/heads/' + baseBranch);
			// const branchCommit = await repository.getCommit('refs/heads/' + branchName);

			// Create URI pairs for the multi diff editor
			const changeArgs: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
			for (const change of changes) {
				const fileUri = change.uri;

				// Create review URIs for base and branch versions
				const baseUri = toReviewUri(
					fileUri,
					pathLib.basename(fileUri.fsPath),
					undefined,
					baseCommit.hash,
					false,
					{ base: true },
					folderManager.repository.rootUri
				);

				// Handle different change types
				if (change.status === Status.INDEX_ADDED || change.status === Status.UNTRACKED) {
					// Added files - show against empty
					changeArgs.push([fileUri, undefined, fileUri]);
				} else if (change.status === Status.INDEX_DELETED || change.status === Status.DELETED) {
					// Deleted files - show old version against empty
					changeArgs.push([fileUri, baseUri, undefined]);
				} else {
					// Modified, renamed, or other changes
					changeArgs.push([fileUri, baseUri, fileUri]);
				}
			}

			return vscode.commands.executeCommand('vscode.changes', vscode.l10n.t('Changes in branch {0}', branchName), changeArgs);
		} catch (error) {
			Logger.error(`Failed to open branch diff view: ${error}`, TaskDashboardWebview.ID);
			vscode.window.showErrorMessage(`Failed to open diff view for branch ${branchName}: ${error}`);
		}
	}

	private async getDefaultBranch(folderManager: FolderRepositoryManager): Promise<string | undefined> {
		const defaults = await folderManager.getPullRequestDefaults();
		return defaults.base;
	}

	private async getBranchChanges(folderManager: FolderRepositoryManager, branchName: string, baseBranch: string): Promise<Change[]> {
		try {
			// Use the repository's git interface to get changed files
			const repository = folderManager.repository;

			// Get the diff between base and target branch
			const diff = await repository.diffBetween('refs/heads/' + baseBranch, 'refs/heads/' + branchName);
			return diff;
		} catch (error) {
			Logger.debug(`Failed to get changed files via API: ${error}`, TaskDashboardWebview.ID);
		}

		// Fallback: try to get changes using git status if on the branch
		try {
			const repository = folderManager.repository;
			const changes = repository.state.workingTreeChanges.concat(repository.state.indexChanges);
			return changes;
		} catch (fallbackError) {
			Logger.debug(`Fallback failed: ${fallbackError}`, TaskDashboardWebview.ID);
			return [];
		}
	}
	private async getMilestoneIssues(): Promise<IssueData[]> {
		try {
			const issuesMap = new Map<string, IssueData>();

			// Check if we have any folder managers available
			if (!this._repositoriesManager.folderManagers || this._repositoriesManager.folderManagers.length === 0) {

				return [];
			}

			// Get target repositories (either explicitly configured or current workspace repos)
			const targetRepos = this.getTargetRepositories();

			// Process each target repository exactly once to avoid duplicates
			for (const repoIdentifier of targetRepos) {
				const [owner, repo] = repoIdentifier.split('/');

				const folderManager = this._repositoriesManager.getManagerForRepository(owner, repo);
				if (folderManager) {
					const queryIssues = await this.getIssuesForQuery(folderManager, this._issueQuery);

					// Deduplicate issues by their unique identifier (repo + issue number)
					for (const issue of queryIssues) {
						const issueKey = `${owner}/${repo}#${issue.number}`;
						if (!issuesMap.has(issueKey)) {
							issuesMap.set(issueKey, issue);
						}
					}
				}
			}

			return Array.from(issuesMap.values());
		} catch (error) {
			Logger.error(`Failed to get milestone issues: ${error}`, TaskDashboardWebview.ID);
			return [];
		}
	}

	private getCurrentWorkspaceRepositories(): string[] {
		if (!vscode.workspace.workspaceFolders) {
			return [];
		}

		// Get the primary repository from the first folder manager that has GitHub repositories
		for (const folderManager of this._repositoriesManager.folderManagers) {
			if (folderManager.gitHubRepositories.length > 0) {
				// Return only the first repository to focus on current workspace
				const repository = folderManager.gitHubRepositories[0];
				const repoIdentifier = `${repository.remote.owner}/${repository.remote.repositoryName}`;
				return [repoIdentifier];
			}
		}

		return [];
	}

	private getTargetRepositories(): string[] {
		return this.getCurrentWorkspaceRepositories();
	}

	private async getIssuesForQuery(folderManager: FolderRepositoryManager, query: string): Promise<IssueData[]> {
		return this._taskManager.getIssuesForQuery(folderManager, query);
	}

	private async switchToMainBranch(): Promise<void> {
		try {
			// Find the first available folder manager with a repository
			const folderManager = this._repositoriesManager.folderManagers.find(fm =>
				fm.gitHubRepositories.length > 0
			);
			if (!folderManager) {
				vscode.window.showErrorMessage('No GitHub repository found in the current workspace.');
				return;
			}

			const defaultBranch = await this.getDefaultBranch(folderManager) || 'main';
			await folderManager?.checkoutDefaultBranch(defaultBranch);

			// Update dashboard to reflect the branch change
			setTimeout(() => {
				this.updateDashboard();
			}, 500);
		} catch (error) {
			Logger.error(`Failed to switch to main branch: ${error}`, TaskDashboardWebview.ID);
			vscode.window.showErrorMessage(`Failed to switch to main branch: ${error}`);
		}
	}

	private async createPullRequest(): Promise<void> {
		try {
			// Find the first available folder manager with a repository
			const folderManager = this._repositoriesManager.folderManagers.find(fm =>
				fm.gitHubRepositories.length > 0
			);

			if (!folderManager) {
				vscode.window.showErrorMessage('No GitHub repository found in the current workspace.');
				return;
			}

			const repository = folderManager.repository;
			const currentBranch = repository.state.HEAD?.name;

			if (!currentBranch) {
				vscode.window.showErrorMessage('No current branch found.');
				return;
			}

			// Check if there are any commits on this branch that aren't on main
			const hasCommits = await this.hasCommitsOnBranch(repository, currentBranch);

			if (!hasCommits) {
				// No commits yet, stage files, generate commit message, and open SCM view
				try {
					// Stage all changed files
					const workingTreeChanges = repository.state.workingTreeChanges;
					if (workingTreeChanges.length > 0) {
						await repository.add(workingTreeChanges.map(change => change.uri.fsPath));
						Logger.debug(`Staged ${workingTreeChanges.length} files`, TaskDashboardWebview.ID);
					}

					// Open SCM view first
					await vscode.commands.executeCommand('workbench.view.scm');

					// Generate commit message using Copilot
					try {
						await vscode.commands.executeCommand('github.copilot.git.generateCommitMessage');
					} catch (commitMsgError) {
						Logger.debug(`Failed to generate commit message: ${commitMsgError}`, TaskDashboardWebview.ID);
						// Don't fail the whole operation if commit message generation fails
					}

					vscode.window.showInformationMessage('Files staged and commit message generated. Make your first commit before creating a pull request.');
				} catch (stagingError) {
					Logger.error(`Failed to stage files: ${stagingError}`, TaskDashboardWebview.ID);
					// Fall back to just opening SCM view
					await vscode.commands.executeCommand('workbench.view.scm');
					vscode.window.showInformationMessage('Make your first commit before creating a pull request.');
				}
			} else {
				// Has commits, proceed with create pull request flow
				const reviewManager = ReviewManager.getReviewManagerForFolderManager(
					this._reviewsManager.reviewManagers,
					folderManager,
				);
				return reviewManager?.createPullRequest();
			}
		} catch (error) {
			Logger.error(`Failed to create pull request: ${error}`, TaskDashboardWebview.ID);
			vscode.window.showErrorMessage(`Failed to create pull request: ${error}`);
		}
	}

	private async hasCommitsOnBranch(repository: any, branchName: string): Promise<boolean> {
		try {
			// Find the folder manager that contains this repository
			const folderManager = this._repositoriesManager.folderManagers.find(fm =>
				fm.repository === repository
			);

			if (!folderManager) {
				Logger.debug(`Could not find folder manager for repository`, TaskDashboardWebview.ID);
				return true;
			}

			// Get the default branch (usually main or master)
			const defaultBranch = await this.getDefaultBranch(folderManager) || 'main';

			// Get the GitHub repository for this folder manager
			const githubRepo = folderManager.gitHubRepositories[0];
			if (!githubRepo) {
				Logger.debug(`No GitHub repository found in folder manager`, TaskDashboardWebview.ID);
				return true;
			}

			// Create a CreatePullRequestDataModel to check for changes
			const dataModel = new CreatePullRequestDataModel(
				folderManager,
				githubRepo.remote.owner,
				defaultBranch,
				githubRepo.remote.owner,
				branchName,
				githubRepo.remote.repositoryName
			);

			// Check if there are any changes between the branch and the base
			const commits = await dataModel.gitCommits();
			dataModel.dispose();

			return commits.length > 0;
		} catch (error) {
			// If we can't determine commit status, assume there are commits and proceed
			Logger.debug(`Could not check branch commits: ${error}`, TaskDashboardWebview.ID);
			return true;
		}
	}

	protected override async _onDidReceiveMessage(message: IRequestMessage<any>): Promise<void> {
		switch (message.command) {
			case 'ready': {
				this._onIsReady.fire();

				// Send immediate initialize message with loading state
				const loadingData: DashboardLoading = {
					state: 'loading',
					issueQuery: this._issueQuery
				};

				this._postMessage({
					command: 'initialize',
					data: loadingData
				});
				// Then update with full data
				await this.updateDashboard();
				break;
			}
			case 'refresh-dashboard':
				return this.updateDashboard();
			case 'submit-chat': {
				// Send loading state to webview
				this._postMessage({
					command: 'chat-submission-started'
				});

				try {
					await this._chatHandler.handleChatSubmission(message.args?.query);
				} finally {
					// Send completion state to webview
					this._postMessage({
						command: 'chat-submission-completed'
					});
				}
				return;
			}
			case 'open-session':
				return this.openSession(message.args?.sessionId);
			case 'open-issue':
				return this.openIssue(message.args?.repoOwner, message.args?.repoName, message.args?.issueNumber);
			case 'open-pull-request':
				return this.openPullRequest(message.args?.pullRequest);
			case 'switch-to-local-task':
				return this.switchToLocalTask(message.args?.branchName);
			case 'switch-to-remote-task':
				return this.switchToRemoteTask(message.args?.sessionId, message.args?.pullRequest);
			case 'open-external-url':
				await vscode.env.openExternal(vscode.Uri.parse(message.args.url));
				return;
			case 'switch-to-main':
				return this.switchToMainBranch();
			case 'create-pull-request':
				return this.createPullRequest();
			default:
				return super._onDidReceiveMessage(message);
		}
	}

	private async checkoutPullRequestBranch(pullRequest: PullRequestModel): Promise<void> {
		const folderManager = this._repositoriesManager.getManagerForIssueModel(pullRequest);
		if (folderManager && !pullRequest.equals(folderManager?.activePullRequest)) {
			const reviewManager = ReviewManager.getReviewManagerForFolderManager(this._reviewsManager.reviewManagers, folderManager);
			return reviewManager?.switch(pullRequest);
		}
	}

	public async switchToRemoteTask(sessionId: string, pullRequestInfo?: TaskPr): Promise<void> {
		try {
			if (pullRequestInfo) {
				// Show progress notification for the full review mode setup
				await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: `Entering review mode for PR #${pullRequestInfo.number}`,
					cancellable: false
				}, async (progress) => {
					const pullRequestModel = await this.toPrModelAndFolderManager(pullRequestInfo);
					if (pullRequestModel) {
						progress.report({ message: 'Setting up workspace...', increment: 10 });

						// First, find and checkout the PR branch to enter review mode
						progress.report({ message: 'Switching to PR branch...', increment: 30 });
						await this.checkoutPullRequestBranch(pullRequestModel.prModel);

						// Small delay to ensure branch checkout and review mode activation completes
						progress.report({ message: 'Activating review mode...', increment: 50 });
						await new Promise(resolve => setTimeout(resolve, 500));

						// // Then open the pull request description (this is the "review mode" interface)
						// progress.report({ message: 'Opening pull request...', increment: 75 });
						// await this.openPullRequest(pullRequest);

						// Finally open the chat session beside the PR description
						progress.report({ message: 'Opening chat session...', increment: 90 });
						await vscode.window.showChatSession('copilot-swe-agent', sessionId, {
							viewColumn: vscode.ViewColumn.Beside
						});

						progress.report({ message: 'Review mode ready!', increment: 100 });
					}
				});

				// Show success message
				vscode.window.showInformationMessage(
					`Review mode activated for PR #${pullRequestInfo.number}. You can now review changes and continue the chat session.`
				);
			} else {
				// No PR associated, just open the chat session
				await vscode.window.showChatSession('copilot-swe-agent', sessionId, {});
			}
		} catch (error) {
			Logger.error(`Failed to open session with PR: ${error} `, TaskDashboardWebview.ID);
			vscode.window.showErrorMessage(`Failed to enter review mode for pull request: ${error}`);
		}
	}

	private async openSession(sessionId: string): Promise<void> {
		try {
			// Open the chat session
			await vscode.window.showChatSession('copilot-swe-agent', sessionId, {});
		} catch (error) {
			Logger.error(`Failed to open session: ${error} `, TaskDashboardWebview.ID);
			vscode.window.showErrorMessage('Failed to open session.');
		}
	}

	private async openIssue(repoOwner: string, repoName: string, issueNumber: number): Promise<void> {
		try {
			// Try to find the issue in the current repositories
			for (const folderManager of this._repositoriesManager.folderManagers) {
				const issueModel = await folderManager.resolveIssue(repoOwner, repoName, issueNumber);
				if (issueModel) {
					return IssueOverviewPanel.createOrShow(this._telemetry, this._extensionUri, folderManager, issueModel);
				}
			}

			// Fallback to opening externally if we can't find the issue locally
			const issueUrl = `https://github.com/${repoOwner}/${repoName}/issues/${issueNumber}`;
			await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
		} catch (error) {
			Logger.error(`Failed to open issue: ${error} `, TaskDashboardWebview.ID);
			// Fallback to opening externally
			try {
				const issueUrl = `https://github.com/${repoOwner}/${repoName}/issues/${issueNumber}`;
				await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
			} catch (fallbackError) {
				vscode.window.showErrorMessage('Failed to open issue.');
			}
		}
	}

	private async toPrModelAndFolderManager(pullRequest: TaskPr): Promise<{ prModel: PullRequestModel; folderManager: FolderRepositoryManager } | undefined> {
		// Try to find the pull request in the current repositories
		for (const folderManager of this._repositoriesManager.folderManagers) {
			// Parse the URL to get owner and repo
			const urlMatch = pullRequest.url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
			if (urlMatch) {
				const [, owner, repo] = urlMatch;
				const prModel = await folderManager.resolvePullRequest(owner, repo, pullRequest.number);
				if (prModel) {
					return { prModel, folderManager };
				}
			}
		}
		return undefined;
	}

	private async openPullRequest(pullRequestInfo: TaskPr): Promise<void> {
		const models = await this.toPrModelAndFolderManager(pullRequestInfo);
		if (models) {
			return PullRequestOverviewPanel.createOrShow(this._telemetry, this._extensionUri, models.folderManager, models.prModel);
		}

		// Fallback to opening externally if we can't find the PR locally
		await vscode.env.openExternal(vscode.Uri.parse(pullRequestInfo.url));
	}

	private registerBranchChangeListeners(): void {
		// Listen for branch changes across all repositories
		this._register(this._repositoriesManager.onDidChangeFolderRepositories((event) => {
			if (event.added) {
				this.registerFolderManagerBranchListeners(event.added);
			}
		}));

		// Register listeners for existing folder managers
		for (const folderManager of this._repositoriesManager.folderManagers) {
			this.registerFolderManagerBranchListeners(folderManager);
		}
	}

	private registerRepositoryLoadListeners(): void {
		// Listen for repository state changes to update dashboard when repositories become available
		this._register(this._repositoriesManager.onDidChangeState(() => {
			// When repositories state changes, try to update the dashboard
			if (this._repositoriesManager.state === ReposManagerState.RepositoriesLoaded) {
				this.updateDashboard();
			}
		}));

		// Listen for folder repository changes (when repositories are added to folder managers)
		this._register(this._repositoriesManager.onDidChangeFolderRepositories((event) => {
			if (event.added) {
				// When new folder managers are added, they might have repositories we can use
				this.updateDashboard();
				// Also register repository load listeners for the new folder manager
				this._register(event.added.onDidLoadRepositories(() => {
					this.updateDashboard();
				}));
			}
		}));

		// Also listen for when repositories are loaded within existing folder managers
		for (const folderManager of this._repositoriesManager.folderManagers) {
			this._register(folderManager.onDidLoadRepositories(() => {
				this.updateDashboard();
			}));
		}
	}

	private registerFolderManagerBranchListeners(folderManager: FolderRepositoryManager): void {
		// Listen for repository HEAD changes (branch changes)
		this._register(folderManager.repository.state.onDidChange(() => {
			// Debounce the update to avoid too frequent refreshes
			if (this._branchChangeTimeout) {
				clearTimeout(this._branchChangeTimeout);
			}
			this._branchChangeTimeout = setTimeout(() => {
				this.updateDashboard();
			}, 300); // 300ms debounce
		}));
	}

	private getHtmlForWebview(): string {
		const nonce = getNonce();
		const uri = vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'webview-dashboard.js');
		const codiconsUri = this._webview!.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https: data:; script-src 'nonce-${nonce}' 'unsafe-eval' vscode-resource:; style-src vscode-resource: 'unsafe-inline' http: https: data:; font-src vscode-resource: data: 'self' https://*.vscode-cdn.net; worker-src 'self' blob: data:; connect-src 'self' https:;">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<link href="${codiconsUri}" rel="stylesheet" />
		<title>GitHub Dashboard</title>
	</head>
	<body>
		<div id="app"></div>
		<script nonce="${nonce}" src="${this._webview!.asWebviewUri(uri).toString()}"></script>
	</body>
</html>`;
	}
}