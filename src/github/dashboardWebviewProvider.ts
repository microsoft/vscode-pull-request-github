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
import { FolderRepositoryManager } from './folderRepositoryManager';
import { IssueModel } from './issueModel';
import { RepositoriesManager } from './repositoriesManager';

export interface DashboardData {
	activeSessions: SessionData[];
	milestoneIssues: IssueData[];
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
}

export class DashboardWebviewProvider extends WebviewBase {
	public static readonly viewType = 'github.dashboard';
	private static readonly ID = 'DashboardWebviewProvider';
	public static currentPanel?: DashboardWebviewProvider;

	protected readonly _panel: vscode.WebviewPanel;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _copilotRemoteAgentManager: CopilotRemoteAgentManager,
		private readonly _telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		panel: vscode.WebviewPanel
	) {
		super();
		this._panel = panel;
		this._webview = panel.webview;
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
			DashboardWebviewProvider.currentPanel = undefined;
		}));

		// Send initial data
		this.updateDashboard();
	}

	public static async createOrShow(
		context: vscode.ExtensionContext,
		reposManager: RepositoriesManager,
		copilotRemoteAgentManager: CopilotRemoteAgentManager,
		telemetry: ITelemetry,
		extensionUri: vscode.Uri
	): Promise<void> {
		const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

		// If we already have a panel, show it
		if (DashboardWebviewProvider.currentPanel) {
			DashboardWebviewProvider.currentPanel._panel.reveal(column);
			return;
		}

		// Create a new panel
		const panel = vscode.window.createWebviewPanel(
			DashboardWebviewProvider.viewType,
			'My Tasks',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri]
			}
		);

		// Set the icon
		panel.iconPath = {
			light: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'github_logo.png'),
			dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'github_logo.png')
		};

		DashboardWebviewProvider.currentPanel = new DashboardWebviewProvider(
			context,
			reposManager,
			copilotRemoteAgentManager,
			telemetry,
			extensionUri,
			panel
		);
	}

	public static refresh(): void {
		if (DashboardWebviewProvider.currentPanel) {
			DashboardWebviewProvider.currentPanel.updateDashboard();
		}
	}

	private async updateDashboard(): Promise<void> {
		try {
			const data = await this.getDashboardData();
			this._postMessage({
				command: 'update-dashboard',
				data: data
			});
		} catch (error) {
			Logger.error(`Failed to update dashboard: ${error}`, DashboardWebviewProvider.ID);
		}
	}

	private async getDashboardData(): Promise<DashboardData> {
		const [activeSessions, milestoneIssues] = await Promise.all([
			this.getActiveSessions(),
			this.getMilestoneIssues()
		]);

		return {
			activeSessions,
			milestoneIssues
		};
	}

	private async getActiveSessions(): Promise<SessionData[]> {
		try {
			// Create a cancellation token for the request
			const source = new vscode.CancellationTokenSource();
			const token = source.token;

			const sessions = await this._copilotRemoteAgentManager.provideChatSessions(token);
			return sessions.map(session => this.convertSessionToData(session));
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

			for (const folderManager of this._repositoriesManager.folderManagers) {
				const milestoneIssues = await this.getIssuesForMilestone(folderManager, 'September 2025');
				issues.push(...milestoneIssues);
			}

			return issues;
		} catch (error) {
			Logger.error(`Failed to get milestone issues: ${error}`, DashboardWebviewProvider.ID);
			return [];
		}
	}

	private async getIssuesForMilestone(folderManager: FolderRepositoryManager, milestoneTitle: string): Promise<IssueData[]> {
		try {
			// Build query for open issues in the specific milestone
			const query = `is:open milestone:"${milestoneTitle}" assignee:@me`;
			const searchResult = await folderManager.getIssues(query);

			if (!searchResult || !searchResult.items) {
				return [];
			}

			return searchResult.items.map(issue => this.convertIssueToData(issue));
		} catch (error) {
			Logger.debug(`Failed to get issues for milestone ${milestoneTitle}: ${error}`, DashboardWebviewProvider.ID);
			return [];
		}
	}

	private convertIssueToData(issue: IssueModel): IssueData {
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
			case 'refresh-dashboard':
				await this.updateDashboard();
				break;
			case 'open-chat':
				await this.openChatWithQuery(message.args?.query);
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
			await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
		} catch (error) {
			Logger.error(`Failed to open issue: ${error}`, DashboardWebviewProvider.ID);
			vscode.window.showErrorMessage('Failed to open issue.');
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

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>GitHub Dashboard</title>
	</head>
	<body>
		<div id="app"></div>
		<script nonce="${nonce}" src="${this._webview!.asWebviewUri(uri).toString()}"></script>
	</body>
</html>`;
	}
}