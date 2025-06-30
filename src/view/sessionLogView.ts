/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type * as messages from '../../webviews/sessionLogView/messages';
import { Disposable, disposeAll } from '../common/lifecycle';
import { ITelemetry } from '../common/telemetry';
import { SessionLinkInfo, SessionPullInfo } from '../common/timelineEvent';
import { CopilotApi, getCopilotApi } from '../github/copilotApi';
import { CopilotRemoteAgentManager, IAPISessionLogs } from '../github/copilotRemoteAgent';
import { CredentialStore } from '../github/credentials';
import { PullRequestModel } from '../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { RepositoriesManager } from '../github/repositoriesManager';
import { loadCurrentThemeData } from './theme';

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

			return this.openForSession(picked.sessionId, false);
		}));
	}

	public override dispose() {
		SessionLogViewManager.instance = undefined;

		for (const panelEntry of this._panels) {
			disposeAll(panelEntry.disposables);
		}

		super.dispose();
	}

	async openForSession(sessionId: string, openToTheSide?: boolean): Promise<void> {
		const existingPanel = this.getPanelForSession(sessionId);
		if (existingPanel) {
			existingPanel.revealAndRefresh({ type: 'session', sessionId });
			return;
		} else {
			return this.open({ type: 'session', sessionId }, openToTheSide);
		}
	}

	async openForPull(pullRequest: PullRequestModel, link: SessionLinkInfo, openToTheSide?: boolean): Promise<void> {
		const source: SessionLogSource = {
			type: 'pull', pullRequest: {
				...link,
				title: pullRequest.title
			}, link
		};
		const existingPanel = this.getPanelForPullRequest(pullRequest);
		if (existingPanel) {
			existingPanel.revealAndRefresh(source);
			return;
		} else {
			return this.open(source, openToTheSide);
		}
	}

	private getPanelForSession(sessionId: string): SessionLogView | undefined {
		return Array.from(this._panels).find(panel => panel.view.isForSession(sessionId))?.view;
	}

	private getPanelForPullRequest(pullRequest: PullRequestModel): SessionLogView | undefined {
		return Array.from(this._panels).find(panel => panel.view.isForPullRequest(pullRequest))?.view;
	}

	private async open(source: SessionLogSource, openToTheSide?: boolean): Promise<void> {
		const copilotApi = await getCopilotApi(this.credentialStore);
		if (!copilotApi) {
			vscode.window.showErrorMessage(vscode.l10n.t('Could not get copilot API for this pull request.'));
			return;
		}

		const viewColumn = openToTheSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
		const webviewPanel = vscode.window.createWebviewPanel(
			SessionLogViewManager.viewType,
			vscode.l10n.t('Session Log'),
			viewColumn,
			{
				retainContextWhenHidden: true,
				enableFindWidget: true
			}
		);

		return this.setupWebview(webviewPanel, source, copilotApi);
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

		await this.setupWebview(webviewPanel, { type: 'session', sessionId: state.sessionId }, copilotApi);
	}

	private async setupWebview(webviewPanel: vscode.WebviewPanel, source: SessionLogSource, copilotApi: CopilotApi): Promise<void> {
		const logView = new SessionLogView(source, webviewPanel, copilotApi, this.context, this.reposManagers, this.telemetry, this.copilotAgentManager);
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

type SessionLogSource =
	| { type: 'pull', readonly pullRequest: SessionLinkInfo & { title: string }; readonly link: SessionLinkInfo }
	| { type: 'session', readonly sessionId: string }
	;

class SessionLogView extends Disposable {


	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	public readonly onDidDispose = this._onDidDispose.event;

	private _sessionId: string | undefined;

	private _source: SessionLogSource;

	private readonly _ready: Promise<void>;

	constructor(
		source: SessionLogSource,
		private readonly webviewPanel: vscode.WebviewPanel,
		private readonly copilotApi: CopilotApi,
		private readonly context: vscode.ExtensionContext,
		private readonly reposManagers: RepositoriesManager,
		telemetry: ITelemetry,
		private readonly copilotAgentManager: CopilotRemoteAgentManager,

	) {
		super();

		this._source = source;

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
				if (this._source.type === 'pull') {
					pullRequest = await this.getPullRequestModel(this._source.pullRequest);
				}

				if (!pullRequest) {
					vscode.window.showErrorMessage(vscode.l10n.t('No pull request information available for this session.'));
					return;
				}

				const folderManager = reposManagers.getManagerForIssueModel(pullRequest) ?? reposManagers.folderManagers[0];
				await PullRequestOverviewPanel.createOrShow(telemetry, context.extensionUri, folderManager, pullRequest);
			} else if (message.type === 'openOnWeb') {
				if (this._source.type !== 'pull') {
					vscode.window.showErrorMessage(vscode.l10n.t('No pull request information available for this session.'));
					return;
				}

				const pullInfo = this._source.pullRequest;
				const sessionUrl = vscode.Uri.parse(`https://${pullInfo.host}/${pullInfo.owner}/${pullInfo.repo}/pull/${pullInfo.pullNumber}/agent-sessions/${this._sessionId}`);
				return vscode.env.openExternal(sessionUrl);
			}
		}));

		this.initialize().then(() => {
			if (this._isDisposed) {
				return;
			}
			this.updateContent();
		});
	}

	override dispose(): void {
		if (this._isDisposed) {
			return;
		}

		this._onDidDispose.fire();
		this._onDidDispose.dispose();
		super.dispose();
	}

	public isForPullRequest(pullRequest: PullRequestModel): boolean {
		return this._source.type === 'pull' && this._source.pullRequest.id === pullRequest.id;
	}

	public isForSession(sessionId: string): boolean {
		return this._sessionId === sessionId;
	}

	public revealAndRefresh(source: SessionLogSource): void {
		if (
			(this._source.type === 'session' && source.type === 'session' && this._source.sessionId === source.sessionId)
			|| (this._source.type === 'pull' && source.type === 'pull' && arePullLinksEqual(this._source.pullRequest, source.pullRequest))
		) {
			// No need to reload content
			this.webviewPanel.reveal();
			return;
		}

		this._source = source;
		this.updateContent();
	}

	private async initialize() {
		this.webviewPanel.title = this._source.type === 'pull' ? vscode.l10n.t(`Session Log (Pull #{0})`, this._source.pullRequest.pullNumber) : vscode.l10n.t('Session Log');
		this.webviewPanel.iconPath = {
			light: vscode.Uri.joinPath(this.context.extensionUri, 'resources/icons/output.svg'),
			dark: vscode.Uri.joinPath(this.context.extensionUri, 'resources/icons/dark/output.svg')
		};

		const distDir = vscode.Uri.joinPath(this.context.extensionUri, 'dist');

		this.webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				distDir
			]
		};
		this.webviewPanel.webview.html = `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>${vscode.l10n.t('Session Log')}</title>
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${this.webviewPanel.webview.cspSource}; script-src ${this.webviewPanel.webview.cspSource} 'unsafe-eval' blob:; font-src ${this.webviewPanel.webview.cspSource};">
			</head>
			<body>
				<div id="app"></div>

				<script type="module" src="${this.webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'webview-session-log-view.js'))}"></script>
			</body>
			</html>`;


		let readyResolve: (value: void | PromiseLike<void>) => void;
		const ready = new Promise<void>(resolve => { readyResolve = resolve; });
		this._register(this.webviewPanel.webview.onDidReceiveMessage((message: any) => {
			if (message.type === 'ready') {
				readyResolve();
			}
		}));

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
		} as messages.InitMessage);
	}

	private async updateContent(): Promise<void> {
		this.webviewPanel.webview.postMessage({
			type: 'reset',
		} as messages.ResetMessage);

		const getLatestLogs = async (): Promise<IAPISessionLogs | undefined> => {
			if (this._source.type === 'session') {
				const [info, logs] = await Promise.all([
					this.copilotApi.getSessionInfo(this._source.sessionId),
					this.copilotApi.getLogsFromSession(this._source.sessionId)
				]);
				return { logs, info };
			} else {
				return this.copilotAgentManager.getSessionLogFromPullRequest(this._source.pullRequest.id, -1 - this._source.link.sessionIndex, false);
			}
		};
		if (this._source.type === 'session') {
			this._sessionId = this._source.sessionId;
		} else {
			// Reset until we have a session ID

			this._sessionId = undefined;
		}

		let apiResponse: IAPISessionLogs | undefined;
		try {
			apiResponse = await getLatestLogs();
		} catch (error) {
			if (this._isDisposed) {
				return;
			}

			// See if we can get a link to the action logs
			if (this._source.type === 'pull') {
				const pullModel = await this.getPullRequestModel(this._source.pullRequest);
				if (pullModel) {
					const url = await this.copilotAgentManager.getSessionUrlFromPullRequest(pullModel);
					this.webviewPanel.webview.postMessage({
						type: 'error',
						logsWebLink: url
					} as messages.ErrorMessage);
					return;
				}
			}

			// Generic error
			this.webviewPanel.webview.postMessage({
				type: 'error',
				logsWebLink: undefined
			} as messages.ErrorMessage);

			return;
		}

		if (this._isDisposed || !apiResponse) {
			return;
		}
		this._sessionId = apiResponse.info.id;

		this.webviewPanel.webview.postMessage({
			type: 'loaded',
			pullInfo: this._source.type === 'pull' ? this._source.pullRequest : undefined,
			info: apiResponse.info,
			logs: apiResponse.logs
		} as messages.LoadedMessage);

		if (apiResponse.info.state === 'in_progress') {
			// Poll for updates
			const interval = setInterval(async () => {
				if (this._isDisposed) {
					clearInterval(interval);
					return;
				}

				const apiResult = await getLatestLogs();
				if (!apiResult) {
					// TODO: Handle error
					return;
				}

				this.webviewPanel.webview.postMessage({
					type: 'update',
					pullInfo: this._source.type === 'pull' ? this._source.pullRequest : undefined,
					info: apiResult.info,
					logs: apiResult.logs
				} as messages.UpdateMessage);

				if (apiResult.info.state !== 'in_progress') {
					clearInterval(interval);
				}
			}, 3000);

			this._register({
				dispose: () => clearInterval(interval)
			});
		}
	}

	private async getPullRequestModel(pullInfo: SessionPullInfo): Promise<PullRequestModel | undefined> {
		const folderManager = this.reposManagers.getManagerForRepository(pullInfo.owner, pullInfo.repo) ?? this.reposManagers.folderManagers.at(0);
		return folderManager?.resolvePullRequest(pullInfo.owner, pullInfo.repo, pullInfo.pullNumber);
	}
}

function arePullLinksEqual(a: SessionLinkInfo, b: SessionLinkInfo): boolean {
	return a.id === b.id && a.sessionIndex === b.sessionIndex;
}
