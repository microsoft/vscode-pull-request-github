/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { ChatSessionWithPR } from './copilotApi';
import { CopilotRemoteAgentManager } from './copilotRemoteAgent';
import { FolderRepositoryManager, ReposManagerState } from './folderRepositoryManager';
import { IssueModel } from './issueModel';
import { RepositoriesManager } from './repositoriesManager';

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
}

// Legacy interface for backward compatibility
export interface DashboardData {
	activeSessions: SessionData[];
	milestoneIssues: IssueData[];
	issueQuery: string;
}

export interface SessionData {
	id: string;
	title: string;
	status: string;
	dateCreated: string;
	isCurrentBranch?: boolean;
	pullRequest?: {
		number: number;
		title: string;
		url: string;
	};
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

	private async getActiveSessions(): Promise<SessionData[]> {
		try {
			// Create a cancellation token for the request
			const source = new vscode.CancellationTokenSource();
			const token = source.token;

			const sessions = await this._copilotRemoteAgentManager.provideChatSessions(token);
			let filteredSessions = sessions;

			// Filter sessions by repositories if specified
			const targetRepos = this.getTargetRepositories();
			if (targetRepos.length > 0) {
				filteredSessions = sessions.filter(session => {
					// If session has a pull request, check if it belongs to one of the target repos
					if (session.pullRequest?.html_url) {
						const urlMatch = session.pullRequest.html_url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/\d+/);
						if (urlMatch) {
							const [, owner, repo] = urlMatch;
							const repoIdentifier = `${owner}/${repo}`;
							return targetRepos.some(targetRepo =>
								targetRepo.toLowerCase() === repoIdentifier.toLowerCase()
							);
						}
					}
					// If no pull request or URL doesn't match pattern, include it
					// (this covers sessions that might not be tied to a specific repo)
					return targetRepos.length === 0;
				});
			}

			// Deduplicate sessions by ID to prevent duplicate display
			const sessionMap = new Map<string, SessionData>();
			for (const session of filteredSessions) {
				const sessionData = this.convertSessionToData(session);
				sessionMap.set(sessionData.id, sessionData);
			}

			return Array.from(sessionMap.values());
		} catch (error) {
			Logger.error(`Failed to get active sessions: ${error}`, DashboardWebviewProvider.ID);
			return [];
		}
	}

	private convertSessionToData(session: ChatSessionWithPR): SessionData {
		const isCurrentBranch = this.isSessionAssociatedWithCurrentBranch(session);
		return {
			id: session.id,
			title: session.label,
			status: session.status ? session.status.toString() : 'Unknown',
			dateCreated: session.timing?.startTime ? new Date(session.timing.startTime).toISOString() : '',
			isCurrentBranch,
			pullRequest: session.pullRequest ? {
				number: session.pullRequest.number,
				title: session.pullRequest.title,
				url: session.pullRequest.html_url
			} : undefined
		};
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
		const currentRepos = new Set<string>();

		if (!vscode.workspace.workspaceFolders) {
			return [];
		}

		// Get repository identifiers for all workspace folders
		for (const folderManager of this._repositoriesManager.folderManagers) {
			for (const repository of folderManager.gitHubRepositories) {
				const repoIdentifier = `${repository.remote.owner}/${repository.remote.repositoryName}`;
				currentRepos.add(repoIdentifier);

				// only add first for now
				break;
			}
		}

		const repoArray = Array.from(currentRepos);
		return repoArray;
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
			// Use the provided query directly
			const searchResult = await folderManager.getIssues(query);

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
			default:
				await super._onDidReceiveMessage(message);
				break;
		}
	}

	private async handleChatSubmission(query: string): Promise<void> {
		if (!query) {
			return;
		}

		try {
			// Extract issue references from the query
			const referencedIssues = this.extractIssueNumbers(query);
			const issueContext = await this.getIssueContext(referencedIssues);

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
				// Create background session using chat sessions API
				await this.createRemoteBackgroundSession(enhancedQuery);
				return;
			}

			// Check if user explicitly mentions @local for local workflow
			if (query.includes('@local')) {
				// Remove @local prefix and set up local workflow directly
				const cleanQuery = enhancedQuery.replace(/@local\s*/, '').trim();
				await this.setupLocalWorkflow(cleanQuery || enhancedQuery);
				return;
			}

			// Determine if this is a general question or coding task
			const isCodingTask = await this.isCodingTask(query);

			if (isCodingTask) {
				// Show quick pick to choose between local and remote work
				const workMode = await this.showWorkModeQuickPick();

				if (workMode === 'remote') {
					// Use @copilot to start a new chat session
					await vscode.commands.executeCommand('workbench.action.chat.open', { query: `@copilot ${enhancedQuery}` });
				} else if (workMode === 'local') {
					// Create a new branch and set up local chat with agent mode
					await this.setupLocalWorkflow(enhancedQuery);
				}
				// If workMode is undefined, user cancelled - do nothing
			} else {
				// General question - open chat normally
				await vscode.commands.executeCommand('workbench.action.chat.open', { query: enhancedQuery });
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
	 * Extracts issue numbers from text (e.g., #123, #456)
	 */
	private extractIssueNumbers(text: string): number[] {
		const issueRegex = /#(\d+)/g;
		const matches: number[] = [];
		let match;
		while ((match = issueRegex.exec(text)) !== null) {
			matches.push(parseInt(match[1], 10));
		}
		return matches;
	}

	/**
	 * Gets issue context data for referenced issue numbers
	 */
	private async getIssueContext(issueNumbers: number[]): Promise<IssueData[]> {
		if (issueNumbers.length === 0) {
			return [];
		}

		try {
			// Get all milestone issues and filter for referenced ones
			const allIssues = await this.getMilestoneIssues();
			return issueNumbers
				.map(issueNum => allIssues.find(issue => issue.number === issueNum))
				.filter(Boolean) as IssueData[];
		} catch (error) {
			Logger.error(`Failed to get issue context: ${error}`, DashboardWebviewProvider.ID);
			return [];
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

	/**
	 * Determines if a query represents a coding task vs a general question using VS Code's Language Model API
	 */
	private async isCodingTask(query: string): Promise<boolean> {
		try {
			// Try to get a language model for classification
			const models = await vscode.lm.selectChatModels({
				vendor: 'copilot',
				family: 'gpt-4o'
			});

			if (!models || models.length === 0) {
				// Fallback to keyword-based classification if no LM available
				return this.isCodingTaskFallback(query);
			}

			const model = models[0];

			// Create a focused prompt for binary classification
			const classificationPrompt = `You are a classifier that determines whether a user query represents a coding/development task or a general question.

Examples of CODING TASKS:
- "Implement user authentication"
- "Fix the bug in the login function"
- "Add a search feature to the app"
- "Refactor the database connection code"
- "Create unit tests for the API"
- "Debug the memory leak issue"
- "Update the CSS styling"
- "Build a REST endpoint"

Examples of GENERAL QUESTIONS:
- "How does authentication work?"
- "What is a REST API?"
- "Explain the difference between async and sync"
- "What are the benefits of unit testing?"
- "How do I learn React?"
- "What is the best IDE for Python?"

Respond with exactly one word: "CODING" if the query is about implementing, building, fixing, creating, or working on code. "GENERAL" if it's asking for information, explanations, or learning resources.

Query: "${query}"

Classification:`;

			const messages = [vscode.LanguageModelChatMessage.User(classificationPrompt)];

			const response = await model.sendRequest(messages, {
				justification: 'Classifying user query type for workflow routing'
			});

			let result = '';
			for await (const chunk of response.text) {
				result += chunk;
			}

			// Parse the response - look for "CODING" or "GENERAL"
			const cleanResult = result.trim().toUpperCase();
			return cleanResult.includes('CODING');

		} catch (error) {
			Logger.error(`Failed to classify query using LM API: ${error}`, DashboardWebviewProvider.ID);
			// Fallback to keyword-based classification
			return this.isCodingTaskFallback(query);
		}
	}

	/**
	 * Fallback keyword-based classification when LM API is unavailable
	 */
	private isCodingTaskFallback(query: string): boolean {
		const codingKeywords = [
			'implement', 'create', 'add', 'build', 'develop', 'code', 'write',
			'fix', 'debug', 'resolve', 'solve', 'repair',
			'refactor', 'optimize', 'improve', 'enhance', 'update',
			'feature', 'function', 'method', 'class', 'component',
			'api', 'endpoint', 'service', 'module', 'library',
			'test', 'testing', 'unit test', 'integration test',
			'bug', 'issue', 'error', 'exception', 'crash'
		];

		const lowercaseQuery = query.toLowerCase();
		return codingKeywords.some(keyword => lowercaseQuery.includes(keyword));
	}

	/**
	 * Shows a quick pick to let user choose between local and remote work
	 */
	private async showWorkModeQuickPick(): Promise<'local' | 'remote' | undefined> {
		const quickPick = vscode.window.createQuickPick();
		quickPick.title = 'Choose how to work on this task';
		quickPick.placeholder = 'Select whether to work locally or remotely';
		quickPick.items = [
			{
				label: '$(device-desktop) Work locally',
				detail: 'Create a new branch and work in your local environment',
				alwaysShow: true
			},
			{
				label: '$(cloud) Work remotely',
				detail: 'Use GitHub Copilot remote agent to work in the cloud',
				alwaysShow: true
			}
		];

		return new Promise<'local' | 'remote' | undefined>((resolve) => {
			quickPick.onDidAccept(() => {
				const selectedItem = quickPick.selectedItems[0];
				quickPick.hide();
				if (selectedItem) {
					if (selectedItem.label.includes('locally')) {
						resolve('local');
					} else if (selectedItem.label.includes('remotely')) {
						resolve('remote');
					}
				}
				resolve(undefined);
			});

			quickPick.onDidHide(() => {
				quickPick.dispose();
				resolve(undefined);
			});

			quickPick.show();
		});
	}

	/**
	 * Sets up local workflow: creates branch and opens chat with agent mode
	 */
	private async setupLocalWorkflow(query: string): Promise<void> {
		try {
			// Get the first available folder manager with a repository
			const folderManager = this._repositoriesManager.folderManagers.find(fm =>
				fm.gitHubRepositories.length > 0
			);

			if (!folderManager) {
				vscode.window.showErrorMessage('No GitHub repository found in the current workspace.');
				return;
			}

			// Generate a logical branch name from the query
			const branchName = this.generateBranchName(query);

			// Create the branch
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Creating branch: ${branchName}`,
				cancellable: false
			}, async () => {
				await folderManager.repository.createBranch(branchName, true);
			});

			// Show success message
			vscode.window.showInformationMessage(`Created and switched to branch: ${branchName}`);

			// Open chat with agent mode
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query,
				// Note: Agent mode activation might require additional parameters
				// This depends on the VS Code chat API implementation
			});

		} catch (error) {
			Logger.error(`Failed to setup local workflow: ${error}`, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage(`Failed to create branch: ${error}`);
		}
	}

	/**
	 * Creates a remote background session using the copilot remote agent
	 */
	private async createRemoteBackgroundSession(query: string): Promise<void> {
		try {
			// Extract the query without @copilot mention
			const cleanQuery = query.replace(/@copilot\s*/, '').trim();

			// Use the copilot remote agent manager to create a new session
			const sessionResult = await this._copilotRemoteAgentManager.provideNewChatSessionItem({
				request: {
					prompt: cleanQuery,
					references: [],
					participant: 'copilot-swe-agent'
				} as any, // Type assertion as we're using this internal API
				prompt: cleanQuery,
				history: [],
				metadata: { source: 'dashboard' }
			}, new vscode.CancellationTokenSource().token);

			// Show confirmation that the task has been created
			if (sessionResult && sessionResult.id) {
				const sessionTitle = sessionResult.label || `Session ${sessionResult.id}`;
				const viewAction = 'View Session';
				const result = await vscode.window.showInformationMessage(
					`Created new coding agent task: ${sessionTitle}`,
					viewAction
				);

				if (result === viewAction) {
					// Open the session if user chooses to view it
					await vscode.window.showChatSession('copilot-swe-agent', sessionResult.id, {});
				}

				// Refresh the dashboard to show the new session
				setTimeout(() => {
					this.updateDashboard();
				}, 1000);
			} else {
				vscode.window.showErrorMessage('Failed to create coding agent session.');
			}

		} catch (error) {
			Logger.error(`Failed to create remote background session: ${error}`, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage(`Failed to create coding agent session: ${error}`);
		}
	}

	/**
	 * Generates a logical branch name from a query
	 */
	private generateBranchName(query: string): string {
		// Clean up the query to create a branch-friendly name
		const cleaned = query
			.toLowerCase()
			.replace(/[^\w\s-]/g, '') // Remove special characters except hyphens
			.replace(/\s+/g, '-') // Replace spaces with hyphens
			.replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
			.replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

		// Truncate to reasonable length
		const truncated = cleaned.length > 40 ? cleaned.substring(0, 40) : cleaned;

		// Add timestamp to ensure uniqueness
		const timestamp = Date.now().toString().slice(-6);

		return `task/${truncated}-${timestamp}`;
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

	private isSessionAssociatedWithCurrentBranch(session: ChatSessionWithPR): boolean {
		if (!session.pullRequest) {
			return false;
		}

		// Parse the PR URL to get owner and repo
		const urlMatch = session.pullRequest.html_url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
		if (!urlMatch) {
			return false;
		}

		const [, owner, repo] = urlMatch;
		const prNumber = session.pullRequest.number;

		// Check if any folder manager has this PR checked out on current branch
		for (const folderManager of this._repositoriesManager.folderManagers) {
			// Check if this folder manager manages the target repo
			if (this.folderManagerMatchesRepo(folderManager, owner, repo)) {
				// Check if the current branch corresponds to this PR
				const currentBranchName = folderManager.repository.state.HEAD?.name;
				if (currentBranchName) {
					// Try to find the PR model for this session
					try {
						// Use the active PR if it matches
						if (folderManager.activePullRequest?.number === prNumber) {
							return true;
						}
						// Also check if the branch name suggests it's a PR branch
						// Common patterns: pr-123, pull/123, etc.
						const prBranchPatterns = [
							new RegExp(`pr-${prNumber}$`, 'i'),
							new RegExp(`pull/${prNumber}$`, 'i'),
							new RegExp(`pr/${prNumber}$`, 'i')
						];
						for (const pattern of prBranchPatterns) {
							if (pattern.test(currentBranchName)) {
								return true;
							}
						}
					} catch (error) {
						// Ignore errors in checking PR association
					}
				}
			}
		}

		return false;
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
