/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type * as messages from '../../webviews/sessionLogView/messages';
import { AuthProvider } from '../common/authentication';
import { Disposable } from '../common/lifecycle';
import { CopilotApi } from '../github/copilotApi';
import { CredentialStore } from '../github/credentials';
import { PullRequestModel } from '../github/pullRequestModel';
import { hasEnterpriseUri } from '../github/utils';

export class SessionLogViewManager extends Disposable {
	static instance: SessionLogViewManager | undefined;

	constructor(
		private readonly credentialStore: CredentialStore,
		private readonly context: vscode.ExtensionContext,
	) {
		super();

		SessionLogViewManager.instance = this;

		this._register(vscode.commands.registerCommand('padawan.openSessionLog', async () => {
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

			return this.open(picked.sessionId);
		}));
	}

	async openForPull(pullRequest: PullRequestModel): Promise<void> {
		const copilotApi = await getCopilotApi(this.credentialStore);
		if (!copilotApi) {
			return;
		}

		const sessionId = (await copilotApi.getAllSessions(pullRequest))[0].id;
		if (!sessionId) {
			vscode.window.showErrorMessage(vscode.l10n.t('No sessions found for this pull request.'));
			return;
		}

		return this.open(sessionId);
	}

	async open(sessionId: string): Promise<void> {
		const copilotApi = await getCopilotApi(this.credentialStore);
		if (!copilotApi) {
			return;
		}

		const webviewPanel = vscode.window.createWebviewPanel('padawanSessionView', vscode.l10n.t('Session Logs'), vscode.ViewColumn.Active);

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
			<title>Session Log</title>
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webviewPanel.webview.cspSource}; script-src ${webviewPanel.webview.cspSource};">
		</head>
		<body>
			<div id="app"></div>

			<script type="module" src="${webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'webview-session-log-view.js'))}"></script>
		</body>
		</html>`;

		const [info, logs] = await Promise.all([
			copilotApi.getSessionInfo(sessionId),
			copilotApi.getLogsFromSession(sessionId)
		]);

		webviewPanel.webview.postMessage({
			type: 'init',
			info,
			logs,
		} as messages.InitMessage);
	}
}

async function getCopilotApi(credentialStore: CredentialStore): Promise<CopilotApi | undefined> {
	let authProvider: AuthProvider | undefined;
	if (credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
		authProvider = AuthProvider.githubEnterprise;
	} else if (credentialStore.isAuthenticated(AuthProvider.github)) {
		authProvider = AuthProvider.github;
	} else {
		return;
	}

	const github = credentialStore.getHub(authProvider);
	if (!github || !github.octokit) {
		return;
	}

	const { token } = await github.octokit.api.auth() as { token: string };
	return new CopilotApi(github.octokit, token);
}
