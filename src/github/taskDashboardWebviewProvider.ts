/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { CreatePullRequestDataModel } from '../view/createPullRequestDataModel';
import { CopilotRemoteAgentManager } from './copilotRemoteAgent';
import { FolderRepositoryManager, ReposManagerState } from './folderRepositoryManager';
import { IssueModel } from './issueModel';
import { RepositoriesManager } from './repositoriesManager';
import { IssueReference, SessionData, TaskManager } from './taskManager';

// Dashboard state discriminated union
export type DashboardState = DashboardLoading | DashboardReady;

export interface DashboardLoading {
	state: 'loading';
	issueQuery: string;
}

export interface DashboardReady {
	state: 'ready';
	issueQuery: string;
	activeSessions: SessionData[];
	milestoneIssues: IssueData[];
	repository?: {
		owner: string;
		name: string;
	};
	currentBranch?: string;
}

// Legacy interface for backward compatibility
export interface DashboardData {
	activeSessions: SessionData[];
	milestoneIssues: IssueData[];
	issueQuery: string;
}

export interface IssueData {
	number: number;
	title: string;
	assignee?: string;
	milestone?: string;
	state: string;
	url: string;
	createdAt: string;
	updatedAt: string;
	localTaskBranch?: string; // Name of the local task branch if it exists
	pullRequest?: {
		number: number;
		title: string;
		url: string;
	};
}

export class DashboardWebviewProvider extends WebviewBase {
	public static readonly viewType = 'github.dashboard';
	private static readonly ID = 'DashboardWebviewProvider';

	protected readonly _panel: vscode.WebviewPanel;

	private _issueQuery: string;
	private _repos?: string[];
	private _taskManager: TaskManager;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _copilotRemoteAgentManager: CopilotRemoteAgentManager,
		private readonly _telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		panel: vscode.WebviewPanel,
		issueQuery: string,
		repos: string[] | undefined
	) {
		super();
		this._panel = panel;
		this._webview = panel.webview;
		this._issueQuery = issueQuery || 'is:open assignee:@me milestone:"September 2025"';
		this._repos = repos;
		this._taskManager = new TaskManager(this._repositoriesManager, this._copilotRemoteAgentManager);
		super.initialize();

		// Set webview options
		this._webview.options = {
			enableScripts: true,
			localResourceRoots: [extensionUri]
		};

		// Set webview HTML
		this._webview.html = this.getHtmlForWebview();

		// Listen for panel disposal
		this._register(this._panel.onDidDispose(() => {
			// Panel is disposed, cleanup will be handled by base class
		}));

		// Listen for branch changes to update current branch session marking
		this.registerBranchChangeListeners();

		// Listen for repository changes to update dashboard when repositories become available
		this.registerRepositoryLoadListeners();

		// Register cleanup for timeout
		this._register({
			dispose: () => {
				if (this._branchChangeTimeout) {
					clearTimeout(this._branchChangeTimeout);
				}
			}
		});

		// Initial data will be sent when webview sends 'ready' message
	}

	public async updateConfiguration(issueQuery: string, repos?: string[]): Promise<void> {
		this._issueQuery = issueQuery;
		this._repos = repos;
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

			const data = await this.getDashboardData();

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
				activeSessions: data.activeSessions,
				milestoneIssues: data.milestoneIssues,
				repository,
				currentBranch
			};
			this._postMessage({
				command: 'update-dashboard',
				data: readyData
			});
		} catch (error) {
			Logger.error(`Failed to update dashboard: ${error}`, DashboardWebviewProvider.ID);
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

	private async getDashboardData(): Promise<DashboardData> {
		const [activeSessions, milestoneIssues] = await Promise.all([
			this.getActiveSessions(),
			this.getMilestoneIssues()
		]);

		return {
			activeSessions,
			milestoneIssues,
			issueQuery: this._issueQuery
		};
	}

	private async getActiveSessions(): Promise<SessionData[]> {
		const targetRepos = this.getTargetRepositories();
		return await this._taskManager.getActiveSessions(targetRepos);
	}

	private async switchToLocalTask(branchName: string): Promise<void> {
		// Switch to the branch first
		await this._taskManager.switchToLocalTask(branchName);

		// Open the combined diff view for all changes in the branch
		await this.openBranchDiffView(branchName);

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

			// Get the base branch (usually main or master)
			const baseBranch = await this.getDefaultBranch(folderManager) || 'main';

			// Use git to get the list of changed files
			const changedFiles = await this.getChangedFilesInBranch(folderManager, branchName, baseBranch);

			if (changedFiles.length === 0) {
				vscode.window.showInformationMessage(`No changes found in branch ${branchName}`);
				return;
			}

			// Open the first changed file using the existing openDiff pattern
			// if (changedFiles.length > 0) {
			// 	const firstFile = changedFiles[0];
			// 	await this.openFileInDiffView(folderManager, firstFile, branchName, baseBranch);
			// }

			// Position chat to the right
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				location: vscode.ViewColumn.Two
			});

			// Show info about other changed files
			if (changedFiles.length > 1) {
				const otherFiles = changedFiles.slice(1);
				const action = await vscode.window.showInformationMessage(
					`Showing 1 of ${changedFiles.length} changed files. ${otherFiles.length} more files changed.`,
					'Show All Changes'
				);

				if (action === 'Show All Changes') {
					// Open file explorer focused on the changed files
					await vscode.commands.executeCommand('workbench.view.explorer');
				}
			}

		} catch (error) {
			Logger.error(`Failed to open branch diff view: ${error}`, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage(`Failed to open diff view for branch ${branchName}: ${error}`);
		}
	}

	private async getDefaultBranch(folderManager: FolderRepositoryManager): Promise<string | undefined> {
		try {
			// Try to get the default branch from the repository
			if (folderManager.repository.getRefs) {
				const refs = await folderManager.repository.getRefs({ pattern: 'refs/remotes/origin' });
				const defaultRef = refs.find(ref => ref.name === 'refs/remotes/origin/main') ||
					refs.find(ref => ref.name === 'refs/remotes/origin/master');
				return defaultRef?.name?.split('/').pop();
			}
			return undefined;
		} catch (error) {
			Logger.debug(`Failed to get default branch: ${error}`, DashboardWebviewProvider.ID);
			return undefined;
		}
	}

	private async getChangedFilesInBranch(folderManager: FolderRepositoryManager, branchName: string, baseBranch: string): Promise<string[]> {
		try {
			// Use the repository's git interface to get changed files
			const repository = folderManager.repository;

			// Get the diff between base and target branch
			const diff = await repository.diffBetween('refs/heads/' + baseBranch, 'refs/heads/' + branchName);
			// Extract file paths from the diff
			return diff.map(change => change.uri.fsPath);


		} catch (error) {
			Logger.debug(`Failed to get changed files via API: ${error}`, DashboardWebviewProvider.ID);
		}

		// Fallback: try to get changes using git status if on the branch
		try {
			const repository = folderManager.repository;
			const changes = repository.state.workingTreeChanges.concat(repository.state.indexChanges);
			return changes.map(change => change.uri.fsPath);
		} catch (fallbackError) {
			Logger.debug(`Fallback failed: ${fallbackError}`, DashboardWebviewProvider.ID);
			return [];
		}
	}

	private async openFileInDiffView(folderManager: FolderRepositoryManager, filePath: string, branchName: string, baseBranch: string): Promise<void> {
		try {
			// Create URIs for the base and head versions of the file
			const baseUri = vscode.Uri.file(filePath).with({
				scheme: 'git',
				query: `${baseBranch}`
			});
			const headUri = vscode.Uri.file(filePath).with({
				scheme: 'git',
				query: branchName
			});

			// Use the same openDiff pattern as FileChangeNode
			const fileName = filePath.split('/').pop() || filePath;
			await vscode.commands.executeCommand(
				'vscode.diff',
				baseUri,
				headUri,
				`${fileName} (${baseBranch} ↔ ${branchName})`,
				{ viewColumn: vscode.ViewColumn.One }
			);

		} catch (error) {
			Logger.error(`Failed to open file in diff view: ${error}`, DashboardWebviewProvider.ID);
			throw error;
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

				// Find the first folder manager that manages this repository
				const folderManager = this._repositoriesManager.folderManagers.find(fm =>
					this.folderManagerMatchesRepo(fm, owner, repo)
				);

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
			Logger.error(`Failed to get milestone issues: ${error}`, DashboardWebviewProvider.ID);
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
		// If explicit repos are configured, use those
		if (this._repos) {
			return this._repos;
		}

		// Otherwise, default to current workspace repositories
		const currentRepos = this.getCurrentWorkspaceRepositories();
		return currentRepos;
	}

	private folderManagerMatchesRepo(folderManager: FolderRepositoryManager, owner: string, repo: string): boolean {
		// Check if the folder manager manages a repository that matches the owner/repo
		for (const repository of folderManager.gitHubRepositories) {
			if (repository.remote.owner.toLowerCase() === owner.toLowerCase() &&
				repository.remote.repositoryName.toLowerCase() === repo.toLowerCase()) {
				return true;
			}
		}
		return false;
	}

	private async getIssuesForQuery(folderManager: FolderRepositoryManager, query: string): Promise<IssueData[]> {
		try {
			// Get the primary repository for this folder manager to scope the search
			let scopedQuery = query;
			if (folderManager.gitHubRepositories.length > 0) {
				const repo = folderManager.gitHubRepositories[0];
				const repoScope = `repo:${repo.remote.owner}/${repo.remote.repositoryName}`;
				// Add repo scope to the query if it's not already present
				if (!query.includes('repo:')) {
					scopedQuery = `${repoScope} ${query}`;
				}
			}

			const searchResult = await folderManager.getIssues(scopedQuery);

			if (!searchResult || !searchResult.items) {
				return [];
			}

			return Promise.all(searchResult.items.map(issue => this.convertIssueToData(issue)));
		} catch (error) {
			return [];
		}
	}

	private async convertIssueToData(issue: IssueModel): Promise<IssueData> {
		const issueData: IssueData = {
			number: issue.number,
			title: issue.title,
			assignee: issue.assignees?.[0]?.login,
			milestone: issue.milestone?.title,
			state: issue.state,
			url: issue.html_url,
			createdAt: issue.createdAt,
			updatedAt: issue.updatedAt
		};

		// Check for local task branch
		try {
			const taskBranchName = `task/issue-${issue.number}`;
			const localTaskBranch = await this.findLocalTaskBranch(taskBranchName);
			if (localTaskBranch) {
				issueData.localTaskBranch = localTaskBranch;

				// Check for associated pull request for this branch
				const pullRequest = await this.findPullRequestForBranch(localTaskBranch);
				if (pullRequest) {
					issueData.pullRequest = pullRequest;
				}
			}
		} catch (error) {
			// If we can't check for branches, just continue without the local task info
			Logger.debug(`Could not check for local task branch: ${error}`, DashboardWebviewProvider.ID);
		}

		return issueData;
	}

	private async findLocalTaskBranch(branchName: string): Promise<string | undefined> {
		try {
			// Use the same logic as TaskManager to get all task branches
			for (const folderManager of this._repositoriesManager.folderManagers) {
				if (folderManager.repository.getRefs) {
					const refs = await folderManager.repository.getRefs({ pattern: 'refs/heads/' });

					// Debug: log all branches
					Logger.debug(`All local branches: ${refs.map(r => r.name).join(', ')}`, DashboardWebviewProvider.ID);

					// Filter for task branches and look for our specific branch
					const taskBranches = refs.filter(ref =>
						ref.name &&
						ref.name.startsWith('task/')
					);

					Logger.debug(`Task branches: ${taskBranches.map(r => r.name).join(', ')}`, DashboardWebviewProvider.ID);
					Logger.debug(`Looking for branch: ${branchName}`, DashboardWebviewProvider.ID);

					const matchingBranch = taskBranches.find(ref => ref.name === branchName);

					if (matchingBranch) {
						Logger.debug(`Found local task branch: ${branchName}`, DashboardWebviewProvider.ID);
						return branchName;
					}
				}
			}
			Logger.debug(`Local task branch ${branchName} not found in any repository`, DashboardWebviewProvider.ID);
			return undefined;
		} catch (error) {
			Logger.debug(`Failed to find local task branch ${branchName}: ${error}`, DashboardWebviewProvider.ID);
			return undefined;
		}
	}

	private async findPullRequestForBranch(branchName: string): Promise<{ number: number; title: string; url: string } | undefined> {
		try {
			for (const folderManager of this._repositoriesManager.folderManagers) {
				if (folderManager.gitHubRepositories.length === 0) {
					continue;
				}

				// Try each GitHub repository in this folder manager
				for (const githubRepository of folderManager.gitHubRepositories) {
					try {
						// Use the getPullRequestForBranch method to find PRs for this branch
						const pullRequest = await githubRepository.getPullRequestForBranch(branchName, githubRepository.remote.owner);

						if (pullRequest) {
							Logger.debug(`Found PR #${pullRequest.number} for branch ${branchName}`, DashboardWebviewProvider.ID);
							return {
								number: pullRequest.number,
								title: pullRequest.title,
								url: pullRequest.html_url
							};
						}
					} catch (error) {
						Logger.debug(`Failed to find PR for branch ${branchName} in ${githubRepository.remote.owner}/${githubRepository.remote.repositoryName}: ${error}`, DashboardWebviewProvider.ID);
						// Continue to next repository
					}
				}
			}

			Logger.debug(`No PR found for branch ${branchName}`, DashboardWebviewProvider.ID);
			return undefined;
		} catch (error) {
			Logger.debug(`Failed to find PR for branch ${branchName}: ${error}`, DashboardWebviewProvider.ID);
			return undefined;
		}
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

			// Get the default branch (usually main or master)
			const defaultBranch = await this.getDefaultBranch(folderManager) || 'main';

			// Switch to the default branch
			await folderManager.repository.checkout(defaultBranch);
			vscode.window.showInformationMessage(`Switched to branch: ${defaultBranch}`);

			// Update dashboard to reflect the branch change
			setTimeout(() => {
				this.updateDashboard();
			}, 500);
		} catch (error) {
			Logger.error(`Failed to switch to main branch: ${error}`, DashboardWebviewProvider.ID);
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
						Logger.debug(`Staged ${workingTreeChanges.length} files`, DashboardWebviewProvider.ID);
					}

					// Open SCM view first
					await vscode.commands.executeCommand('workbench.view.scm');

					// Generate commit message using Copilot
					try {
						await vscode.commands.executeCommand('github.copilot.git.generateCommitMessage');
					} catch (commitMsgError) {
						Logger.debug(`Failed to generate commit message: ${commitMsgError}`, DashboardWebviewProvider.ID);
						// Don't fail the whole operation if commit message generation fails
					}

					vscode.window.showInformationMessage('Files staged and commit message generated. Make your first commit before creating a pull request.');
				} catch (stagingError) {
					Logger.error(`Failed to stage files: ${stagingError}`, DashboardWebviewProvider.ID);
					// Fall back to just opening SCM view
					await vscode.commands.executeCommand('workbench.view.scm');
					vscode.window.showInformationMessage('Make your first commit before creating a pull request.');
				}
			} else {
				// Has commits, proceed with create pull request flow
				await vscode.commands.executeCommand('pr.create');
			}
		} catch (error) {
			Logger.error(`Failed to create pull request: ${error}`, DashboardWebviewProvider.ID);
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
				Logger.debug(`Could not find folder manager for repository`, DashboardWebviewProvider.ID);
				return true;
			}

			// Get the default branch (usually main or master)
			const defaultBranch = await this.getDefaultBranch(folderManager) || 'main';

			// Get the GitHub repository for this folder manager
			const githubRepo = folderManager.gitHubRepositories[0];
			if (!githubRepo) {
				Logger.debug(`No GitHub repository found in folder manager`, DashboardWebviewProvider.ID);
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
			Logger.debug(`Could not check branch commits: ${error}`, DashboardWebviewProvider.ID);
			return true;
		}
	}

	protected override async _onDidReceiveMessage(message: IRequestMessage<any>): Promise<void> {
		switch (message.command) {
			case 'ready':
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
			case 'refresh-dashboard':
				await this.updateDashboard();
				break;
			case 'submit-chat':
				await this.handleChatSubmission(message.args?.query);
				break;
			case 'open-session':
				await this.openSession(message.args?.sessionId);
				break;
			case 'open-session-with-pr':
				await this.openSessionWithPullRequest(message.args?.sessionId, message.args?.pullRequest);
				break;
			case 'open-issue':
				await this.openIssue(message.args?.issueUrl);
				break;
			case 'open-pull-request':
				await this.openPullRequest(message.args?.pullRequest);
				break;
			case 'switch-to-local-task':
				await this.switchToLocalTask(message.args?.branchName);
				break;
			case 'start-remote-agent':
				await this.startRemoteAgent(message.args?.issue);
				break;
			case 'open-external-url':
				await vscode.env.openExternal(vscode.Uri.parse(message.args.url));
				break;
			case 'switch-to-main':
				await this.switchToMainBranch();
				break;
			case 'create-pull-request':
				await this.createPullRequest();
				break;
			default:
				await super._onDidReceiveMessage(message);
				break;
		}
	}

	/**
	 * Creates a temporary session that shows in the dashboard with a loading state
	 */
	private createTemporarySession(query: string, type: 'local' | 'remote'): string {
		const tempId = this._taskManager.createTemporarySession(query, type);
		// Immediately update the dashboard to show the temporary session
		this.updateDashboard();
		return tempId;
	}	/**
	 * Removes a temporary session from the dashboard
	 */
	private removeTemporarySession(tempId: string): void {
		this._taskManager.removeTemporarySession(tempId);
		// Update dashboard to remove the temporary session
		setTimeout(() => {
			this.updateDashboard();
		}, 500); // Small delay to allow real session to be created
	}

	private async handleChatSubmission(query: string): Promise<void> {
		if (!query) {
			return;
		}

		query = query.trim();

		try {
			// Check if user explicitly mentions @copilot for remote background session
			if (query.startsWith('@copilot ')) {
				return this.handleRemoteTaskSubmission(query);
			}
			// Check if user explicitly mentions @local for local workflow
			else if (query.startsWith('@local ')) {
				return this.handleLocalTaskSubmission(query);
			}
			// Determine if this is a general question or coding task
			else {
				if (await this.isCodingTask(query)) {
					// Show quick pick to choose between local and remote work
					const workMode = await this.showWorkModeQuickPick();
					if (workMode === 'remote') {
						return this.handleRemoteTaskSubmission(query);
					} else if (workMode === 'local') {
						return this.handleLocalTaskSubmission(query);
					} else {
						// User cancelled the quick pick
						return;
					}
				} else {
					// General question - Submit to ask mode
					await vscode.commands.executeCommand('workbench.action.chat.open', {
						query,
						mode: 'ask'
					});
				}
			}
		} catch (error) {
			Logger.error(`Failed to handle chat submission: ${error} `, DashboardWebviewProvider.ID);
		}
	}

	private async handleLocalTaskSubmission(query: string) {
		const cleanQuery = query.replace(/@local\s*/, '').trim();

		const tempId = this.createTemporarySession(cleanQuery || query, 'local');
		try {
			await this.handleLocalTaskWithIssueSupport(cleanQuery || query);
		} finally {
			this.removeTemporarySession(tempId);
		}
	}

	private async handleRemoteTaskSubmission(query: string) {
		const cleanQuery = query.replace(/@copilot\s*/, '').trim();

		const tempId = this.createTemporarySession(cleanQuery, 'remote');
		try {
			await this.createRemoteBackgroundSession(cleanQuery);
		} finally {
			// Remove temporary session regardless of success/failure
			this.removeTemporarySession(tempId);
		}
	}




	private async startCopilotTask(taskDescription: string, referencedIssues: number[], issueContext: IssueData[]): Promise<void> {
		if (!taskDescription) {
			return;
		}

		try {
			// Build the enhanced query with issue context
			let enhancedQuery = `${taskDescription} `;

			if (issueContext && issueContext.length > 0) {
				enhancedQuery += `\n\nReferenced Issues: \n`;
				for (const issue of issueContext) {
					enhancedQuery += `- Issue #${issue.number}: ${issue.title} \n`;
					enhancedQuery += `  URL: ${issue.url} \n`;
					if (issue.assignee) {
						enhancedQuery += `  Assignee: ${issue.assignee} \n`;
					}
					if (issue.milestone) {
						enhancedQuery += `  Milestone: ${issue.milestone} \n`;
					}
					enhancedQuery += `  State: ${issue.state} \n`;
					enhancedQuery += `  Updated: ${issue.updatedAt} \n\n`;
				}
			}

			// Start a new copilot session with the enhanced context
			await vscode.commands.executeCommand('workbench.action.chat.open', { query: enhancedQuery });

			// Optionally refresh the dashboard to show any new sessions
			setTimeout(() => {
				this.updateDashboard();
			}, 1000);
		} catch (error) {
			Logger.error(`Failed to start copilot task: ${error} `, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage('Failed to start copilot task. Make sure the Chat extension is available.');
		}
	}

	private async checkoutPullRequestBranch(pullRequest: { number: number; title: string; url: string }): Promise<void> {
		if (!pullRequest) {
			return;
		}

		try {
			// Try to find the pull request in the current repositories
			for (const folderManager of this._repositoriesManager.folderManagers) {
				// Parse the URL to get owner and repo
				const urlMatch = pullRequest.url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
				if (urlMatch) {
					const [, owner, repo] = urlMatch;
					const pullRequestModel = await folderManager.resolvePullRequest(owner, repo, pullRequest.number);
					if (pullRequestModel) {
						// Use VS Code's command to switch to the PR (this triggers review mode)
						await vscode.commands.executeCommand('pr.pick', pullRequestModel);

						return;
					}
				}
			}


		} catch (error) {
			Logger.error(`Failed to checkout PR branch: ${error} `, DashboardWebviewProvider.ID);
			vscode.window.showWarningMessage(`Failed to checkout PR branch. Opening PR without branch checkout.`);
		}
	}

	private async openSessionWithPullRequest(sessionId: string, pullRequest?: { number: number; title: string; url: string }): Promise<void> {
		if (!sessionId) {
			return;
		}

		try {
			if (pullRequest) {
				// Show progress notification for the full review mode setup
				await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: `Entering review mode for PR #${pullRequest.number}`,
					cancellable: false
				}, async (progress) => {
					progress.report({ message: 'Setting up workspace...', increment: 10 });

					// First, find and checkout the PR branch to enter review mode
					progress.report({ message: 'Switching to PR branch...', increment: 30 });
					await this.checkoutPullRequestBranch(pullRequest);

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
				});

				// Show success message
				vscode.window.showInformationMessage(
					`Review mode activated for PR #${pullRequest.number}. You can now review changes and continue the chat session.`
				);
			} else {
				// No PR associated, just open the chat session
				await vscode.window.showChatSession('copilot-swe-agent', sessionId, {});
			}
		} catch (error) {
			Logger.error(`Failed to open session with PR: ${error} `, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage(`Failed to enter review mode for pull request: ${error}`);
		}
	}

	private async openSession(sessionId: string): Promise<void> {
		if (!sessionId) {
			return;
		}

		try {
			// Open the chat session
			await vscode.window.showChatSession('copilot-swe-agent', sessionId, {});
		} catch (error) {
			Logger.error(`Failed to open session: ${error} `, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage('Failed to open session.');
		}
	}

	private async openIssue(issueUrl: string): Promise<void> {
		if (!issueUrl) {
			return;
		}

		try {
			// Try to find the issue in the current repositories
			const urlMatch = issueUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/);
			if (urlMatch) {
				const [, owner, repo, issueNumberStr] = urlMatch;
				const issueNumber = parseInt(issueNumberStr, 10);

				for (const folderManager of this._repositoriesManager.folderManagers) {
					const issueModel = await folderManager.resolveIssue(owner, repo, issueNumber);
					if (issueModel) {
						// Use the extension's command to open the issue description
						await vscode.commands.executeCommand('issue.openDescription', issueModel);
						return;
					}
				}
			}

			// Fallback to opening externally if we can't find the issue locally
			await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
		} catch (error) {
			Logger.error(`Failed to open issue: ${error} `, DashboardWebviewProvider.ID);
			// Fallback to opening externally
			try {
				await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
			} catch (fallbackError) {
				vscode.window.showErrorMessage('Failed to open issue.');
			}
		}
	}

	private async openPullRequest(pullRequest: { number: number; title: string; url: string }): Promise<void> {
		if (!pullRequest) {
			return;
		}

		try {
			// Try to find the pull request in the current repositories
			for (const folderManager of this._repositoriesManager.folderManagers) {
				// Parse the URL to get owner and repo
				const urlMatch = pullRequest.url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
				if (urlMatch) {
					const [, owner, repo] = urlMatch;
					const pullRequestModel = await folderManager.resolvePullRequest(owner, repo, pullRequest.number);
					if (pullRequestModel) {
						// Use the extension's command to open the pull request
						await vscode.commands.executeCommand('pr.openDescription', pullRequestModel);
						return;
					}
				}
			}

			// Fallback to opening externally if we can't find the PR locally
			await vscode.env.openExternal(vscode.Uri.parse(pullRequest.url));
		} catch (error) {
			Logger.error(`Failed to open pull request: ${error} `, DashboardWebviewProvider.ID);
			// Fallback to opening externally
			try {
				await vscode.env.openExternal(vscode.Uri.parse(pullRequest.url));
			} catch (fallbackError) {
				vscode.window.showErrorMessage('Failed to open pull request.');
			}
		}
	}

	private async startRemoteAgent(issueData: any): Promise<void> {
		if (!issueData || !issueData.url) {
			return;
		}

		try {
			// Parse the issue URL to get owner, repo, and issue number
			const urlMatch = issueData.url.match(/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/);
			if (urlMatch) {
				const [, owner, repo, issueNumberStr] = urlMatch;
				const issueNumber = parseInt(issueNumberStr, 10);

				// Find the folder manager for this repository
				for (const folderManager of this._repositoriesManager.folderManagers) {
					const issueModel = await folderManager.resolveIssue(owner, repo, issueNumber);
					if (issueModel) {
						// Use the new side-by-side command
						await vscode.commands.executeCommand('issue.openIssueAndCodingAgentSideBySide', issueModel);
						return;
					}
				}
			}

			// If we can't resolve the issue locally, show an error
			vscode.window.showErrorMessage('Unable to start remote agent session. Issue not found in local workspace.');
		} catch (error) {
			Logger.error(`Failed to start remote agent: ${error}`, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage('Failed to start remote agent session.');
		}
	}


	/**
	 * Determines if a query represents a coding task vs a general question using VS Code's Language Model API
	 */
	private async isCodingTask(query: string): Promise<boolean> {
		return this._taskManager.isCodingTask(query);
	}

	/**
	 * Fallback keyword-based classification when LM API is unavailable
	 */
	/**
	 * Shows a quick pick to let user choose between local and remote work
	 */
	private async showWorkModeQuickPick(): Promise<'local' | 'remote' | undefined> {
		return this._taskManager.showWorkModeQuickPick();
	}

	/**
	 * Sets up local workflow: creates branch and opens chat with agent mode
	 */
	private async setupLocalWorkflow(query: string): Promise<void> {
		await this._taskManager.setupNewLocalWorkflow(query);
	}

	/**
	 * Creates a remote background session using the copilot remote agent
	 */
	private async createRemoteBackgroundSession(query: string): Promise<void> {
		await this._taskManager.createRemoteBackgroundSession(query);
		// Refresh the dashboard to show the new session
		setTimeout(() => {
			this.updateDashboard();
		}, 1000);
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

	private _branchChangeTimeout: NodeJS.Timeout | undefined;

	/**
	 * Handles local task submission with issue support - creates branches and formats prompts
	 */
	private async handleLocalTaskWithIssueSupport(query: string): Promise<void> {
		const references = extractIssueReferences(query);

		if (references.length > 0) {
			const firstRef = references[0];
			const issueNumber = firstRef.number;

			try {
				await this._taskManager.handleLocalTaskForIssue(issueNumber, firstRef);
			} catch (error) {
				Logger.error(`Failed to handle local task with issue support: ${error}`, DashboardWebviewProvider.ID);
				vscode.window.showErrorMessage('Failed to set up local task branch.');
			}
		} else {
			await this.setupLocalWorkflow(query);
		}
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


/**
 * Extracts issue references from text (e.g., #123, owner/repo#456)
 */
function extractIssueReferences(text: string): Array<IssueReference> {
	const out: IssueReference[] = [];

	// Match full repository issue references (owner/repo#123)
	const fullRepoRegex = /([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)/g;
	let match: RegExpExecArray | null;
	while ((match = fullRepoRegex.exec(text)) !== null) {
		out.push({
			number: parseInt(match[3], 10),
			nwo: {
				owner: match[1],
				repo: match[2],
			},
		});
	}

	// Match simple issue references (#123) for current repo
	const simpleRegex = /#(\d+)(?![a-zA-Z0-9._-])/g;
	while ((match = simpleRegex.exec(text)) !== null) {
		out.push({
			number: parseInt(match[1], 10),
		});
	}

	return out;
}