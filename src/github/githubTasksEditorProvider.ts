/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { CopilotRemoteAgentManager } from './copilotRemoteAgent';
import { DashboardWebviewProvider } from './dashboardWebviewProvider';
import { RepositoriesManager } from './repositoriesManager';

export interface GitHubTasksDocument {
	version: number;
	issueQuery?: string;
	repos?: string[];
}

export class GitHubTasksEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'github.tasksEditor';
	private static readonly ID = 'GitHubTasksEditorProvider';

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _copilotRemoteAgentManager: CopilotRemoteAgentManager,
		private readonly _telemetry: ITelemetry
	) { }

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		// Set webview options
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._context.extensionUri]
		};

		// Check if this is a global dashboard (file named global.github-tasks)
		const isGlobal = document.uri.path.endsWith('global.github-tasks');

		// Parse the document content
		let tasksDocument: GitHubTasksDocument;
		try {
			tasksDocument = this.parseDocument(document);
		} catch (error) {
			Logger.error(`Failed to parse GitHub tasks document: ${error}`, GitHubTasksEditorProvider.ID);
			// Show error and use default
			tasksDocument = this.getDefaultDocument();
			vscode.window.showWarningMessage('Invalid GitHub tasks file format. Using default settings.');
		}

		// Create dashboard webview with the parsed query, repos, and global flag
		const dashboardProvider = new DashboardWebviewProvider(
			this._context,
			this._repositoriesManager,
			this._copilotRemoteAgentManager,
			this._telemetry,
			this._context.extensionUri,
			webviewPanel,
			tasksDocument.issueQuery ?? GitHubTasksEditorProvider.getDefaultIssueQuery(),
			tasksDocument.repos,
			isGlobal
		);

		// Listen for document changes
		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === document.uri.toString()) {
				this.updateWebview(e.document, dashboardProvider);
			}
		});

		// Clean up on panel disposal
		webviewPanel.onDidDispose(() => {
			changeDocumentSubscription.dispose();
		});
	}

	private parseDocument(document: vscode.TextDocument): GitHubTasksDocument {
		const text = document.getText();
		if (!text.trim()) {
			return this.getDefaultDocument();
		}

		try {
			const parsed = JSON.parse(text) as GitHubTasksDocument;

			// Validate the document structure
			if (typeof parsed.version !== 'number') {
				throw new Error('Missing or invalid version field');
			}

			if (parsed.issueQuery !== undefined && typeof parsed.issueQuery !== 'string') {
				throw new Error('Invalid issueQuery field - must be a string');
			}

			if (parsed.repos !== undefined) {
				if (!Array.isArray(parsed.repos)) {
					throw new Error('Invalid repos field - must be an array');
				}
				for (const repo of parsed.repos) {
					if (typeof repo !== 'string') {
						throw new Error('Invalid repos field - all items must be strings');
					}
					if (!repo.includes('/') || repo.split('/').length !== 2) {
						throw new Error(`Invalid repo format "${repo}" - must be "owner/repo"`);
					}
				}
			}

			return {
				version: parsed.version,
				issueQuery: parsed.issueQuery || GitHubTasksEditorProvider.getDefaultIssueQuery(),
				repos: parsed.repos
			};
		} catch (error) {
			throw new Error(`Invalid JSON format: ${error}`);
		}
	}

	private getDefaultDocument(): GitHubTasksDocument {
		return {
			version: 1,
			issueQuery: GitHubTasksEditorProvider.getDefaultIssueQuery(),
			repos: undefined
		};
	}

	private static getDefaultIssueQuery(): string {
		return 'is:open assignee:@me milestone:"September 2025"';
	}

	private async updateWebview(document: vscode.TextDocument, dashboardProvider: DashboardWebviewProvider): Promise<void> {
		try {
			const tasksDocument = this.parseDocument(document);
			await dashboardProvider.updateConfiguration(
				tasksDocument.issueQuery || GitHubTasksEditorProvider.getDefaultIssueQuery(),
				tasksDocument.repos
			);
		} catch (error) {
			Logger.error(`Failed to update webview with document changes: ${error}`, GitHubTasksEditorProvider.ID);
		}
	}

	public static createDefaultDocument(): string {
		const defaultDoc: GitHubTasksDocument = {
			version: 1,
			issueQuery: this.getDefaultIssueQuery()
		};
		return JSON.stringify(defaultDoc, null, 2);
	}
}