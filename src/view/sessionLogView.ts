/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type * as messages from '../../webviews/sessionLogView/messages';
import { Disposable, disposeAll } from '../common/lifecycle';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { SessionPullInfo } from '../common/timelineEvent';
import { CopilotApi, getCopilotApi } from '../github/copilotApi';
import { CopilotRemoteAgentManager, IAPISessionLogs } from '../github/copilotRemoteAgent';
import { CredentialStore } from '../github/credentials';
import { PullRequestModel } from '../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { RepositoriesManager } from '../github/repositoriesManager';

export class SessionLogViewManager extends Disposable implements vscode.WebviewPanelSerializer {
	public static instance: SessionLogViewManager | undefined;

	public static readonly viewType = 'pr.codingAgentSessionLogView';

	private readonly _panels = new Set<{ readonly view: SessionLogView; readonly disposables: vscode.Disposable[] }>();

	private _activePanel: SessionLogView | undefined;

	constructor(
		private readonly credentialStore: CredentialStore,
		private readonly context: vscode.ExtensionContext,
		private readonly reposManagers: RepositoriesManager,
		private readonly telemetry: ITelemetry,
		private readonly copilotAgentManager: CopilotRemoteAgentManager,
	) {
		super();

		SessionLogViewManager.instance = this;

		this._register(vscode.window.registerWebviewPanelSerializer(SessionLogViewManager.viewType, this));

		this._register(vscode.commands.registerCommand('codingAgent.openSessionLog', async () => {
			const copilotApi = await getCopilotApi(credentialStore);
			if (!copilotApi) {
				vscode.window.showErrorMessage(vscode.l10n.t('You must be authenticated to view sessions.'));
				return;
			}

			const allSessions = await copilotApi.getAllSessions(undefined);
			if (!allSessions.length) {
				vscode.window.showErrorMessage(vscode.l10n.t('No sessions found.'));
				return;
			}

			const sessionItems = allSessions.map(session => ({
				label: session.name || session.id,
				description: session.created_at ? new Date(session.created_at).toLocaleString() : undefined,
				detail: session.id,
				sessionId: session.id
			}));

			const picked = await vscode.window.showQuickPick(sessionItems, {
				placeHolder: vscode.l10n.t('Select a session log to view')
			});

			if (!picked) {
				return;
			}

			const sessionLogs = await copilotAgentManager.getSessionLogsFromSessionId(picked.sessionId);

			return this.open(sessionLogs, undefined);
		}));

		this._register(vscode.commands.registerCommand('sessionLog.openOnWeb', async () => {
			if (!this._activePanel) {
				return;
			}

			const pullInfo = this._activePanel.pullInfo;
			if (!pullInfo) {
				vscode.window.showErrorMessage(vscode.l10n.t('No pull for this session.'));
				return;
			}


			const sessionUrl = vscode.Uri.parse(`https://${pullInfo.host}/${pullInfo.owner}/${pullInfo.repo}/pull/${pullInfo.pullId}/agent-sessions/${this._activePanel.sessionId}`);
			return vscode.env.openExternal(sessionUrl);
		}));
	}

	public override dispose() {
		SessionLogViewManager.instance = undefined;

		for (const panelEntry of this._panels) {
			disposeAll(panelEntry.disposables);
		}

		super.dispose();
	}

	async openForPull(pullRequest: PullRequestModel): Promise<void> {
		try {
			const sessionLogs = await this.copilotAgentManager.getSessionLogsFromPullRequest(pullRequest);
			if (!sessionLogs) {
				throw new Error('No sessions found for this pull request.');
			}

			return this.open(sessionLogs, pullRequest);
		} catch (error) {
			Logger.error(`Failed to retrieve session logs: ${error}`, 'SessionLogViewManager');
			const url = await this.copilotAgentManager.getSessionUrlFromPullRequest(pullRequest);
			if (!url) {
				vscode.window.showErrorMessage(vscode.l10n.t('No sessions found for this pull request.'));
				return;
			}
			vscode.env.openExternal(vscode.Uri.parse(url));
		}
	}

	async open(logs: IAPISessionLogs, pullRequest: PullRequestModel | undefined): Promise<void> {
		const copilotApi = await getCopilotApi(this.credentialStore);
		if (!copilotApi) {
			return;
		}

		const webviewPanel = vscode.window.createWebviewPanel(
			SessionLogViewManager.viewType,
			pullRequest ? vscode.l10n.t(`Session Log (Pull #{0})`, pullRequest.number) : vscode.l10n.t('Session Log'),
			vscode.ViewColumn.Active,
			{
				retainContextWhenHidden: true,
				enableFindWidget: true
			}
		);

		const pullInfo: SessionPullInfo & { title: string } | undefined = pullRequest ? {
			host: pullRequest.githubRepository.remote.gitProtocol.host,
			owner: pullRequest.githubRepository.remote.owner,
			repo: pullRequest.githubRepository.remote.repositoryName,
			pullId: pullRequest.number,
			title: pullRequest.title,
		} : undefined;

		return this.setupWebview(webviewPanel, logs.sessionId, pullInfo, copilotApi);
	}

	async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: messages.WebviewState): Promise<void> {
		if (!state || !state.sessionId) {
			webviewPanel.dispose();
			return;
		}

		const copilotApi = await getCopilotApi(this.credentialStore);
		if (!copilotApi) {
			webviewPanel.dispose();
			return;
		}

		await this.setupWebview(webviewPanel, state.sessionId, state.pullInfo, copilotApi);
	}

	private async setupWebview(webviewPanel: vscode.WebviewPanel, sessionId: string, pullInfo: SessionPullInfo & { title: string } | undefined, copilotApi: CopilotApi): Promise<void> {
		const distDir = vscode.Uri.joinPath(this.context.extensionUri, 'dist');

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				distDir
			]
		};
		webviewPanel.webview.html = `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>${vscode.l10n.t('Session Log')}</title>
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webviewPanel.webview.cspSource}; script-src ${webviewPanel.webview.cspSource} 'unsafe-eval'; font-src ${webviewPanel.webview.cspSource};">
			</head>
			<body>
				<div id="app"></div>

				<script type="module" src="${webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'webview-session-log-view.js'))}"></script>
			</body>
			</html>`;

		const logView = new SessionLogView(sessionId, pullInfo, webviewPanel, copilotApi, this.context, this.reposManagers, this.telemetry);
		const panelDisposables: vscode.Disposable[] = [];
		const panelEntry = { view: logView, disposables: panelDisposables };
		this._panels.add(panelEntry);

		panelDisposables.push(logView.onDidDispose(() => {
			this._panels.delete(panelEntry);
			disposeAll(panelDisposables);
		}));

		panelDisposables.push(webviewPanel.onDidChangeViewState(() => {
			if (webviewPanel.active) {
				this._activePanel = logView;
			} else if (this._activePanel === logView && !webviewPanel.active) {
				this._activePanel = undefined;
			}
		}));
	}
}

class SessionLogView extends Disposable {

	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	public readonly onDidDispose = this._onDidDispose.event;

	constructor(
		public readonly sessionId: string,
		public readonly pullInfo: SessionPullInfo & { title: string } | undefined,
		private readonly webviewPanel: vscode.WebviewPanel,
		private readonly copilotApi: CopilotApi,
		context: vscode.ExtensionContext,
		reposManagers: RepositoriesManager,
		telemetry: ITelemetry,
	) {
		super();

		this._register(webviewPanel.onDidDispose(() => {
			this.dispose();
		}));

		this._register(vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration('workbench.colorTheme')) {
				const themeData = await loadCurrentThemeData();
				webviewPanel.webview.postMessage({
					type: 'changeTheme',
					themeData,
				} as messages.ChangeThemeMessage);
			}
		}));

		this._register(this.webviewPanel.webview.onDidReceiveMessage(async (message: any) => {
			if (message.type === 'openPullRequestView') {

				let pullRequest: PullRequestModel | undefined;
				if (pullInfo) {
					const folderManager = reposManagers.getManagerForRepository(pullInfo.owner, pullInfo.repo) ?? reposManagers.folderManagers.at(0);
					pullRequest = await folderManager?.resolvePullRequest(pullInfo.owner, pullInfo.repo, pullInfo.pullId);
				}

				if (!pullRequest) {
					vscode.window.showErrorMessage(vscode.l10n.t('No pull request information available for this session.'));
					return;
				}

				const folderManager = reposManagers.getManagerForIssueModel(pullRequest) ?? reposManagers.folderManagers[0];
				await PullRequestOverviewPanel.createOrShow(telemetry, context.extensionUri, folderManager, pullRequest);
			}
		}));

		this.initialize();
	}

	override dispose(): void {
		if (this._isDisposed) {
			return;
		}

		this._onDidDispose.fire();
		this._onDidDispose.dispose();
		super.dispose();
	}

	private async initialize() {
		let readyResolve: (value: void | PromiseLike<void>) => void;
		const ready = new Promise<void>(resolve => { readyResolve = resolve; });
		this._register(this.webviewPanel.webview.onDidReceiveMessage((message: any) => {
			if (message.type === 'ready') {
				readyResolve();
			}
		}));

		const apiPromises = Promise.all([
			this.copilotApi.getSessionInfo(this.sessionId),
			this.copilotApi.getLogsFromSession(this.sessionId)
		]);

		const themeData = await loadCurrentThemeData();
		if (this._isDisposed) {
			return;
		}

		await ready;
		if (this._isDisposed) {
			return;
		}


		this.webviewPanel.webview.postMessage({
			type: 'init',
			themeData,
			sessionId: this.sessionId,
			pullInfo: this.pullInfo,
		} as messages.InitMessage);

		const [info, logs] = await apiPromises;
		if (this._isDisposed) {
			return;
		}

		this.webviewPanel.webview.postMessage({
			type: 'loaded',
			info,
			logs,
		} as messages.LoadedMessage);

		if (info.state === 'in_progress') {
			// Poll for updates every 5 seconds
			const interval = setInterval(async () => {
				if (this._isDisposed) {
					clearInterval(interval);
					return;
				}

				const updatedInfo = await this.copilotApi.getSessionInfo(this.sessionId);
				if (updatedInfo.state !== info.state) {
					this.webviewPanel.webview.postMessage({
						type: 'loaded',
						info: updatedInfo,
						logs,
					} as messages.LoadedMessage);
				}
			}, 5000);

			this._register({
				dispose: () => clearInterval(interval)
			});
		}
	}
}

async function loadCurrentThemeData(): Promise<any> {
	let themeData: any = null;
	const currentThemeName = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
	if (currentThemeName) {
		const path = getCurrentThemePath(currentThemeName);
		if (path) {
			themeData = await loadThemeFromFile(path);
		}
	}
	return themeData;
}

async function loadThemeFromFile(path: vscode.Uri): Promise<any> {
	const decoder = new TextDecoder();

	let themeData = JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(path)));

	// Also load the include file if specified
	if (themeData.include) {
		try {
			const includePath = vscode.Uri.joinPath(path, '..', themeData.include);
			const includeData = await loadThemeFromFile(includePath);
			themeData = {
				...themeData,
				colors: {
					...(includeData.colors || {}),
					...(themeData.colors || {}),
				},
				tokenColors: [
					...(includeData.tokenColors || []),
					...(themeData.tokenColors || []),
				],
				semanticTokenColors: {
					...(includeData.semanticTokenColors || {}),
					...(themeData.semanticTokenColors || {}),
				},
			};
		} catch (error) {
			console.warn(`Failed to load theme include file: ${error}`);
		}
	}

	return themeData;
}

function getCurrentThemePath(themeName: string): vscode.Uri | undefined {
	for (const ext of vscode.extensions.all) {
		const themes = ext.packageJSON.contributes && ext.packageJSON.contributes.themes;
		if (!themes) {
			continue;
		}
		const theme = themes.find(theme => theme.label === themeName || theme.id === themeName);
		if (theme) {
			return vscode.Uri.joinPath(ext.extensionUri, theme.path);
		}
	}
}