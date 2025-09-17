/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { getNonce, IRequestMessage, WebviewBase } from '../common/webview';
import { ComplexityService } from '../issues/complexityService';
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
	complexity?: number;
	complexityReasoning?: string;
}

export class DashboardWebviewProvider extends WebviewBase {
	public static readonly viewType = 'github.dashboard';
	private static readonly ID = 'DashboardWebviewProvider';

	protected readonly _panel: vscode.WebviewPanel;
	private readonly _complexityService: ComplexityService;

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
		this._complexityService = new ComplexityService();
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
			Logger.debug('Repositories need authentication, skipping issue loading', DashboardWebviewProvider.ID);
			return;
		}

		// Wait for repositories to be loaded
		return new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				Logger.debug('Timeout waiting for repositories to load, proceeding anyway', DashboardWebviewProvider.ID);
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

			return filteredSessions.map(session => this.convertSessionToData(session));
		} catch (error) {
			Logger.error(`Failed to get active sessions: ${error}`, DashboardWebviewProvider.ID);
			return [];
		}
	}

	private convertSessionToData(session: ChatSessionWithPR): SessionData {
		return {
			id: session.id,
			title: session.label,
			status: session.status ? session.status.toString() : 'Unknown',
			dateCreated: session.timing?.startTime ? new Date(session.timing.startTime).toISOString() : '',
			pullRequest: session.pullRequest ? {
				number: session.pullRequest.number,
				title: session.pullRequest.title,
				url: session.pullRequest.html_url
			} : undefined
		};
	}

	private async getMilestoneIssues(): Promise<IssueData[]> {
		try {
			const issues: IssueData[] = [];

			// Check if we have any folder managers available
			if (!this._repositoriesManager.folderManagers || this._repositoriesManager.folderManagers.length === 0) {
				Logger.debug('No folder managers available yet, returning empty issues list', DashboardWebviewProvider.ID);
				return [];
			}

			// Get target repositories
			const targetRepos = this.getTargetRepositories();

			for (const folderManager of this._repositoriesManager.folderManagers) {
				// If specific repos are defined, filter by them
				if (targetRepos.length > 0) {
					for (const repoIdentifier of targetRepos) {
						const [owner, repo] = repoIdentifier.split('/');
						// Check if this folder manager manages the target repo
						if (this.folderManagerMatchesRepo(folderManager, owner, repo)) {
							const queryIssues = await this.getIssuesForQuery(folderManager, this._issueQuery);
							issues.push(...queryIssues);
						}
					}
				} else {
					// No specific repos defined, use all folder managers (current behavior)
					const queryIssues = await this.getIssuesForQuery(folderManager, this._issueQuery);
					issues.push(...queryIssues);
				}
			}

			return issues;
		} catch (error) {
			Logger.error(`Failed to get milestone issues: ${error}`, DashboardWebviewProvider.ID);
			return [];
		}
	}

	private getTargetRepositories(): string[] {
		return this._repos || [];
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
			Logger.debug(`Failed to get issues for query "${query}": ${error}`, DashboardWebviewProvider.ID);
			return [];
		}
	}

	private async convertIssueToData(issue: IssueModel): Promise<IssueData> {
		let complexity: number | undefined;
		let complexityReasoning: string | undefined;

		// Check if complexity is already calculated (from IssueItem)
		if ((issue as any).complexity?.score) {
			complexity = (issue as any).complexity.score;
			complexityReasoning = (issue as any).complexity.reasoning;
		} else {
			// Calculate complexity on demand
			try {
				const complexityResult = await this._complexityService.calculateComplexity(issue);
				complexity = complexityResult.score;
				complexityReasoning = complexityResult.reasoning;
			} catch (error) {
				Logger.debug(`Failed to calculate complexity for issue #${issue.number}: ${error}`, DashboardWebviewProvider.ID);
			}
		}

		return {
			number: issue.number,
			title: issue.title,
			assignee: issue.assignees?.[0]?.login,
			milestone: issue.milestone?.title,
			state: issue.state,
			url: issue.html_url,
			createdAt: issue.createdAt,
			updatedAt: issue.updatedAt,
			complexity,
			complexityReasoning
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
			case 'open-chat':
				await this.openChatWithQuery(message.args?.query);
				break;
			case 'start-copilot-task':
				await this.startCopilotTask(message.args?.taskDescription, message.args?.referencedIssues, message.args?.issueContext);
				break;
			case 'open-session':
				await this.openSession(message.args?.sessionId);
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

	private async openChatWithQuery(query: string): Promise<void> {
		if (!query) {
			return;
		}

		try {
			await vscode.commands.executeCommand('workbench.action.chat.open', { query });
		} catch (error) {
			Logger.error(`Failed to open chat with query: ${error}`, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage('Failed to open chat. Make sure the Chat extension is available.');
		}
	}

	private async startCopilotTask(taskDescription: string, referencedIssues: number[], issueContext: IssueData[]): Promise<void> {
		if (!taskDescription) {
			return;
		}

		try {
			// Build the enhanced query with issue context
			let enhancedQuery = `${taskDescription}`;

			if (issueContext && issueContext.length > 0) {
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

			// Start a new copilot session with the enhanced context
			await vscode.commands.executeCommand('workbench.action.chat.open', { query: enhancedQuery });

			// Optionally refresh the dashboard to show any new sessions
			setTimeout(() => {
				this.updateDashboard();
			}, 1000);
		} catch (error) {
			Logger.error(`Failed to start copilot task: ${error}`, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage('Failed to start copilot task. Make sure the Chat extension is available.');
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
			Logger.error(`Failed to open session: ${error}`, DashboardWebviewProvider.ID);
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
			Logger.error(`Failed to open issue: ${error}`, DashboardWebviewProvider.ID);
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
			Logger.error(`Failed to open pull request: ${error}`, DashboardWebviewProvider.ID);
			// Fallback to opening externally
			try {
				await vscode.env.openExternal(vscode.Uri.parse(pullRequest.url));
			} catch (fallbackError) {
				vscode.window.showErrorMessage('Failed to open pull request.');
			}
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
