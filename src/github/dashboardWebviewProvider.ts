/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { CopilotRemoteAgentManager } from './copilotRemoteAgent';
import { FolderRepositoryManager, ReposManagerState } from './folderRepositoryManager';
import { IssueModel } from './issueModel';
import { RepositoriesManager } from './repositoriesManager';
import { SessionData, TaskManager } from './taskManager';

// Dashboard state discriminated union
export type DashboardState = DashboardLoading | DashboardReady | GlobalDashboardLoading | GlobalDashboardReady;

export interface DashboardLoading {
	state: 'loading';
	issueQuery: string;
}

export interface DashboardReady {
	state: 'ready';
	issueQuery: string;
	activeSessions: SessionData[];
	milestoneIssues: IssueData[];
}

export interface GlobalDashboardLoading {
	state: 'loading';
	isGlobal: true;
}

export interface GlobalDashboardReady {
	state: 'ready';
	isGlobal: true;
	activeSessions: SessionData[];
	recentProjects: ProjectData[];
}

export interface ProjectData {
	name: string;
	path: string;
	lastOpened: string;
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
}

export class DashboardWebviewProvider extends WebviewBase {
	public static readonly viewType = 'github.dashboard';
	private static readonly ID = 'DashboardWebviewProvider';

	protected readonly _panel: vscode.WebviewPanel;

	private _issueQuery: string;
	private _repos?: string[];
	private _taskManager: TaskManager;
	private _isGlobal: boolean;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _copilotRemoteAgentManager: CopilotRemoteAgentManager,
		private readonly _telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		panel: vscode.WebviewPanel,
		issueQuery: string,
		repos: string[] | undefined,
		isGlobal: boolean = false
	) {
		super();
		this._panel = panel;
		this._webview = panel.webview;
		this._issueQuery = issueQuery || 'is:open assignee:@me milestone:"September 2025"';
		this._repos = repos;
		this._isGlobal = isGlobal;
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
			if (this._isGlobal) {
				// For global dashboard, get data from all repositories
				const globalData = await this.getGlobalDashboardData();
				const readyData: GlobalDashboardReady = {
					state: 'ready',
					isGlobal: true,
					activeSessions: globalData.activeSessions,
					recentProjects: globalData.recentProjects
				};
				this._postMessage({
					command: 'update-dashboard',
					data: readyData
				});
				return;
			}

			// Regular dashboard logic
			// Wait for repositories to be loaded before fetching data
			await this.waitForRepositoriesReady();

			// Check if we actually have folder managers available before proceeding
			if (!this._repositoriesManager.folderManagers || this._repositoriesManager.folderManagers.length === 0) {

				// Don't send ready state if we don't have folder managers yet
				return;
			}

			const data = await this.getDashboardData();
			const readyData: DashboardReady = {
				state: 'ready',
				issueQuery: this._issueQuery,
				activeSessions: data.activeSessions,
				milestoneIssues: data.milestoneIssues
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

	private async getGlobalDashboardData(): Promise<{ activeSessions: SessionData[]; recentProjects: ProjectData[] }> {
		// Get all sessions from all repositories
		const allSessions = await this._taskManager.getAllSessions();

		// Get recent projects (this would be implemented to get from VS Code workspace history)
		const recentProjects = await this.getRecentProjects();

		return {
			activeSessions: allSessions,
			recentProjects
		};
	}

	private async getRecentProjects(): Promise<ProjectData[]> {
		// For now, return mock data - in a real implementation, this would get from VS Code's recent workspaces
		return [
			{
				name: 'chat-output-renderer-sample',
				path: '~/projects/vscode-extension-samples/chat-output-renderer-sample',
				lastOpened: new Date().toISOString()
			},
			{
				name: 'vscode',
				path: '~/projects',
				lastOpened: new Date(Date.now() - 86400000).toISOString() // 1 day ago
			},
			{
				name: 'vscode-docs',
				path: '~/projects',
				lastOpened: new Date(Date.now() - 172800000).toISOString() // 2 days ago
			},
			{
				name: 'sandbox',
				path: '~/projects',
				lastOpened: new Date(Date.now() - 259200000).toISOString() // 3 days ago
			},
			{
				name: 'typescript-go',
				path: '~/projects',
				lastOpened: new Date(Date.now() - 345600000).toISOString() // 4 days ago
			}
		];
	}

	private async getActiveSessions(): Promise<SessionData[]> {
		const targetRepos = this.getTargetRepositories();
		return await this._taskManager.getActiveSessions(targetRepos);
	}

	private async switchToLocalTask(branchName: string): Promise<void> {
		await this._taskManager.switchToLocalTask(branchName);
		// Update dashboard to reflect current branch change
		setTimeout(() => {
			this.updateDashboard();
		}, 500);
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
		return {
			number: issue.number,
			title: issue.title,
			assignee: issue.assignees?.[0]?.login,
			milestone: issue.milestone?.title,
			state: issue.state,
			url: issue.html_url,
			createdAt: issue.createdAt,
			updatedAt: issue.updatedAt
		};
	}

	protected override async _onDidReceiveMessage(message: IRequestMessage<any>): Promise<void> {
		switch (message.command) {
			case 'ready':
				this._onIsReady.fire();

				// Send immediate initialize message with loading state
				const loadingData: DashboardLoading | GlobalDashboardLoading = this._isGlobal
					? { state: 'loading', isGlobal: true }
					: { state: 'loading', issueQuery: this._issueQuery };

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
			case 'plan-task-with-local-agent':
				await this.handlePlanTaskWithLocalAgent(message.args?.query);
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

		try {
			// Extract issue references from the query
			const issueReferences = this.extractIssueReferences(query);
			const issueContext = await this.getEnhancedIssueContext(issueReferences);

			// Build enhanced query with issue context if any issues are referenced
			let enhancedQuery = query;
			if (issueContext.length > 0) {
				enhancedQuery += `\n\nReferenced Issues:\n`;
				for (const issue of issueContext) {
					enhancedQuery += `- Issue #${issue.number}: ${issue.title}\n`;
					enhancedQuery += `  URL: ${issue.url}\n`;
					if (issue.assignee) {
						enhancedQuery += `  Assignee: ${issue.assignee}\n`;
					}
					if (issue.milestone) {
						enhancedQuery += `  Milestone: ${issue.milestone}\n`;
					}
					enhancedQuery += `  State: ${issue.state}\n`;
					enhancedQuery += `  Updated: ${issue.updatedAt}\n\n`;
				}
			}

			// Check if user explicitly mentions @copilot for remote background session
			if (query.includes('@copilot')) {
				// Create temporary session first
				const tempId = this.createTemporarySession(enhancedQuery.replace(/@copilot\s*/, '').trim(), 'remote');

				// Create background session using chat sessions API
				try {
					await this.createRemoteBackgroundSession(enhancedQuery);
				} finally {
					// Remove temporary session regardless of success/failure
					this.removeTemporarySession(tempId);
				}
				return;
			}

			// Check if user explicitly mentions @local for local workflow
			if (query.includes('@local')) {
				// Create temporary session first
				const cleanQuery = enhancedQuery.replace(/@local\s*/, '').trim();
				const tempId = this.createTemporarySession(cleanQuery || enhancedQuery, 'local');

				// Remove @local prefix and set up local workflow directly
				try {
					await this.setupLocalWorkflow(cleanQuery || enhancedQuery);
				} finally {
					// Remove temporary session regardless of success/failure
					this.removeTemporarySession(tempId);
				}
				return;
			}

			// Determine if this is a general question or coding task
			const isCodingTask = await this.isCodingTask(query);

			if (isCodingTask) {
				// Show quick pick to choose between local and remote work
				const workMode = await this.showWorkModeQuickPick();

				if (workMode === 'remote') {
					// Create temporary session first
					const tempId = this.createTemporarySession(enhancedQuery, 'remote');

					// Use @copilot to start a new chat session
					try {
						await vscode.commands.executeCommand('workbench.action.chat.open', { query: `@copilot ${enhancedQuery}` });
					} finally {
						// Remove temporary session
						this.removeTemporarySession(tempId);
					}
				} else if (workMode === 'local') {
					// Create temporary session first
					const tempId = this.createTemporarySession(enhancedQuery, 'local');

					// Create a new branch and set up local chat with agent mode
					try {
						await this.setupLocalWorkflow(enhancedQuery);
					} finally {
						// Remove temporary session
						this.removeTemporarySession(tempId);
					}
				}
				// If workMode is undefined, user cancelled - do nothing
			} else {
				// General question - create fresh chat and open with ask mode
				await vscode.commands.executeCommand('workbench.action.chat.newChat');
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					query: enhancedQuery,
					mode: 'ask'
				});
			}

			// Optionally refresh the dashboard to show any new sessions
			setTimeout(() => {
				this.updateDashboard();
			}, 1000);
		} catch (error) {
			Logger.error(`Failed to handle chat submission: ${error} `, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage('Failed to open chat. Make sure the Chat extension is available.');
		}
	}

	/**
	 * Extracts issue references from text (e.g., #123, owner/repo#456)
	 */
	private extractIssueReferences(text: string): Array<{ owner?: string; repo?: string; number: number; originalMatch: string }> {
		const references: Array<{ owner?: string; repo?: string; number: number; originalMatch: string }> = [];

		// Match full repository issue references (owner/repo#123)
		const fullRepoRegex = /([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)/g;
		let match;
		while ((match = fullRepoRegex.exec(text)) !== null) {
			references.push({
				owner: match[1],
				repo: match[2],
				number: parseInt(match[3], 10),
				originalMatch: match[0]
			});
		}

		// Match simple issue references (#123) for current repo
		const simpleRegex = /#(\d+)(?![a-zA-Z0-9._-])/g;
		while ((match = simpleRegex.exec(text)) !== null) {
			const matchIndex = match.index;
			const matchText = match[0];

			// Skip if this number is part of a full repo reference we already found
			const isPartOfFullRef = references.some(ref => {
				const refStart = text.indexOf(ref.originalMatch);
				const refEnd = refStart + ref.originalMatch.length;
				return refStart <= matchIndex && matchIndex < refEnd;
			});

			if (!isPartOfFullRef) {
				references.push({
					number: parseInt(match[1], 10),
					originalMatch: matchText
				});
			}
		}

		return references;
	}

	/**
	 * Gets enhanced issue context data for all types of issue references
	 */
	private async getEnhancedIssueContext(issueReferences: Array<{ owner?: string; repo?: string; number: number; originalMatch: string }>): Promise<IssueData[]> {
		if (issueReferences.length === 0) {
			return [];
		}

		try {
			const issueDataPromises = issueReferences.map(async (ref) => {
				if (ref.owner && ref.repo) {
					// External repository issue
					return await this.getExternalIssueData(ref.owner, ref.repo, ref.number);
				} else {
					// Current repository issue
					return await this.getCurrentRepoIssueData(ref.number);
				}
			});

			const issueDataResults = await Promise.all(issueDataPromises);
			return issueDataResults.filter(Boolean) as IssueData[];
		} catch (error) {
			Logger.error(`Failed to get enhanced issue context: ${error}`, DashboardWebviewProvider.ID);
			return [];
		}
	}

	/**
	 * Gets issue data from external repository
	 */
	private async getExternalIssueData(owner: string, repo: string, issueNumber: number): Promise<IssueData | null> {
		try {
			// Find a folder manager that can access this repository
			let folderManager = this._repositoriesManager.folderManagers.find(fm =>
				fm.gitHubRepositories.some(ghRepo =>
					ghRepo.remote.owner.toLowerCase() === owner.toLowerCase() &&
					ghRepo.remote.repositoryName.toLowerCase() === repo.toLowerCase()
				)
			);

			// If not found, use the first available folder manager (it might still have access)
			if (!folderManager && this._repositoriesManager.folderManagers.length > 0) {
				folderManager = this._repositoriesManager.folderManagers[0];
			}

			if (!folderManager) {
				return null;
			}

			const issueModel = await folderManager.resolveIssue(owner, repo, issueNumber);
			if (issueModel) {
				return await this.convertIssueToData(issueModel);
			}
			return null;
		} catch (error) {
			Logger.debug(`Failed to get external issue ${owner}/${repo}#${issueNumber}: ${error}`, DashboardWebviewProvider.ID);
			return null;
		}
	}

	/**
	 * Gets issue data from current repository
	 */
	private async getCurrentRepoIssueData(issueNumber: number): Promise<IssueData | null> {
		try {
			// Get all milestone issues and find the matching one
			const allIssues = await this.getMilestoneIssues();
			const matchingIssue = allIssues.find(issue => issue.number === issueNumber);
			if (matchingIssue) {
				return matchingIssue;
			}

			// If not found in milestone issues, try to resolve directly
			const targetRepos = this.getTargetRepositories();
			for (const repoIdentifier of targetRepos) {
				const [owner, repo] = repoIdentifier.split('/');
				const folderManager = this._repositoriesManager.folderManagers.find(fm =>
					this.folderManagerMatchesRepo(fm, owner, repo)
				);

				if (folderManager) {
					const issueModel = await folderManager.resolveIssue(owner, repo, issueNumber);
					if (issueModel) {
						return await this.convertIssueToData(issueModel);
					}
				}
			}
			return null;
		} catch (error) {
			Logger.debug(`Failed to get current repo issue #${issueNumber}: ${error}`, DashboardWebviewProvider.ID);
			return null;
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
	 * Handles planning a task with local agent - opens issue side-by-side with chat
	 */
	private async handlePlanTaskWithLocalAgent(query: string): Promise<void> {
		if (!query) {
			return;
		}

		try {
			// Extract issue references from the query to find related issues
			const issueReferences = this.extractIssueReferences(query);

			if (issueReferences.length > 0) {
				// If there are issue references, try to open the first one side-by-side with chat
				const firstIssue = issueReferences[0];

				// Find the issue model for the referenced issue
				for (const folderManager of this._repositoriesManager.folderManagers) {
					try {
						const issueModel = await folderManager.resolveIssue(
							firstIssue.owner || folderManager.gitHubRepositories[0]?.remote.owner || '',
							firstIssue.repo || folderManager.gitHubRepositories[0]?.remote.repositoryName || '',
							firstIssue.number
						);
						if (issueModel) {
							// Use the existing side-by-side command
							await vscode.commands.executeCommand('issue.openIssueAndCodingAgentSideBySide', issueModel);
							return;
						}
					} catch (error) {
						// Continue to try other folder managers
						continue;
					}
				}
			}

			// If no specific issue found, create a general planning session
			// Open a new chat session with the query and planning instructions
			await vscode.commands.executeCommand('workbench.action.chat.newChat');

			const planningQuery = `I want to plan and analyze this task before implementing it:

${query}

Please help me:
1. Break down what needs to be implemented
2. Identify any potential challenges or considerations
3. Suggest an implementation approach
4. Ask any clarifying questions that would help create better instructions for a coding agent

Keep your response focused and actionable - ask at most 3 essential questions if there are genuine ambiguities.`;

			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: planningQuery
			});

		} catch (error) {
			Logger.error(`Failed to plan task with local agent: ${error}`, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage('Failed to open planning session. Make sure the Chat extension is available.');
		}
	}

	/**
	 * Determines if a query represents a coding task vs a general question using VS Code's Language Model API
	 */
	private async isCodingTask(query: string): Promise<boolean> {
		return await this._taskManager.isCodingTask(query);
	}

	/**
	 * Fallback keyword-based classification when LM API is unavailable
	 */
	/**
	 * Shows a quick pick to let user choose between local and remote work
	 */
	private async showWorkModeQuickPick(): Promise<'local' | 'remote' | undefined> {
		return await this._taskManager.showWorkModeQuickPick();
	}

	/**
	 * Sets up local workflow: creates branch and opens chat with agent mode
	 */
	private async setupLocalWorkflow(query: string): Promise<void> {
		await this._taskManager.setupLocalWorkflow(query);
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
