/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable, disposeAll } from '../common/lifecycle';
import { ITelemetry } from '../common/telemetry';
import { CopilotRemoteAgentManager } from './copilotRemoteAgent';
import { DashboardWebviewProvider } from './dashboardWebviewProvider';
import { RepositoriesManager } from './repositoriesManager';

export class TasksDashboardManager extends Disposable implements vscode.WebviewPanelSerializer {
	public static readonly viewType = 'github-pull-request.projectTasksDashboard';
	private static readonly viewTitle = vscode.l10n.t('Tasks Dashboard');

	private _currentView: {
		readonly webview: vscode.WebviewPanel;
		readonly dashboardProvider: DashboardWebviewProvider;
		readonly disposables: vscode.Disposable[];
	} | undefined;

	private _statusBarItem?: vscode.StatusBarItem;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _copilotRemoteAgentManager: CopilotRemoteAgentManager,
		private readonly _telemetry: ITelemetry
	) {
		super();

		// Create status bar item for launching dashboard
		this.updateStatusBarItem();

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('githubPullRequests.projectTasksDashboard.enabled')) {
				this.updateStatusBarItem();
			}
		}));

		// Register webview panel serializer for tasks dashboard
		this._register(vscode.window.registerWebviewPanelSerializer(TasksDashboardManager.viewType, this));
	}

	public override dispose() {
		super.dispose();

		this._currentView?.disposables.forEach(d => d.dispose());
		this._currentView = undefined;

		this._statusBarItem?.dispose();
		this._statusBarItem = undefined;
	}

	private updateStatusBarItem(): void {
		const dashboardEnabled = vscode.workspace.getConfiguration('githubPullRequests')
			.get<boolean>('projectTasksDashboard.enabled', false);

		if (dashboardEnabled && !this._statusBarItem) {
			// Create status bar item if it doesn't exist and is now enabled
			this._statusBarItem = this._register(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100));
			this._statusBarItem.text = '$(dashboard) Tasks';
			this._statusBarItem.tooltip = vscode.l10n.t('Open GitHub Tasks Dashboard');
			this._statusBarItem.command = 'pr.projectTasksDashboard.open';
			this._statusBarItem.show();
		} else if (!dashboardEnabled && this._statusBarItem) {
			// Hide and dispose status bar item if it exists and is now disabled
			this._statusBarItem.hide();
			this._statusBarItem.dispose();
			this._statusBarItem = undefined;
		}
	}

	public async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, _state: {}): Promise<void> {
		this.restoreDashboard(webviewPanel);
	}

	private restoreDashboard(webviewPanel: vscode.WebviewPanel): void {
		if (this._currentView) {
			disposeAll(this._currentView.disposables);
			this._currentView = undefined;
		}

		// Set webview options (these might have been lost during restoration)
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._context.extensionUri]
		};

		webviewPanel.iconPath = vscode.Uri.joinPath(this._context.extensionUri, 'resources/icons/github_logo.png');
		webviewPanel.title = TasksDashboardManager.viewTitle;

		const issueQuery = this.getIssueQuery();

		const dashboardProvider = new DashboardWebviewProvider(
			this._context,
			this._repositoriesManager,
			this._copilotRemoteAgentManager,
			this._telemetry,
			this._context.extensionUri,
			webviewPanel,
			issueQuery,
			undefined, // repos - we'll use the setting-based query instead
			false
		);

		const disposables: vscode.Disposable[] = [];
		const currentViewEntry = { webview: webviewPanel, dashboardProvider, disposables };
		this._currentView = currentViewEntry;

		// Clean up when panel is disposed
		disposables.push(webviewPanel.onDidDispose(() => {
			if (this._currentView === currentViewEntry) {
				disposeAll(disposables);
				this._currentView = undefined;
			}
		}));

		disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('githubPullRequests.projectTasksDashboard.issueQuery')) {
				const newQuery = this.getIssueQuery();
				dashboardProvider.updateConfiguration(newQuery, undefined);
			}
		}));
	}

	public showOrCreateDashboard(): void {
		// If we already have a panel, just reveal it
		if (this._currentView) {
			this._currentView.webview.reveal(vscode.ViewColumn.Active);
			return;
		}

		const newWebviewPanel = vscode.window.createWebviewPanel(
			TasksDashboardManager.viewType,
			TasksDashboardManager.viewTitle,
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [this._context.extensionUri],
				retainContextWhenHidden: true
			}
		);
		this.restoreDashboard(newWebviewPanel);
	}

	private getIssueQuery(): string {
		const config = vscode.workspace.getConfiguration('githubPullRequests');
		return config.get<string>('projectTasksDashboard.issueQuery') ?? this.getDefaultIssueQuery();
	}

	private getDefaultIssueQuery(): string {
		return 'is:open assignee:@me milestone:"September 2025"';
	}
}