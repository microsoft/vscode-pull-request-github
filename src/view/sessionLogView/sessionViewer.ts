/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type * as messages from '../../../webviews/sessionLogView/messages';
import { AuthProvider } from '../../common/authentication';
import { CopilotApi } from '../../github/copilotApi';
import { CredentialStore } from '../../github/credentials';
import { hasEnterpriseUri } from '../../github/utils';

export function registerPadawanCommands(
	credentialStore: CredentialStore,
	context: vscode.ExtensionContext,
): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];

	disposables.push(vscode.commands.registerCommand('padawan.openSessionLog', async () => {
		const copilotApi = await getCopilotApi(credentialStore);
		if (!copilotApi) {
			vscode.window.showErrorMessage('You must be authenticated to view sessions.');
			return;
		}

		const allSessions = await copilotApi.getAllSessions(undefined);
		if (!allSessions.length) {
			vscode.window.showErrorMessage('No sessions found.');
			return;
		}

		const sessionItems = allSessions.map(session => ({
			label: session.name || session.id,
			description: session.created_at ? new Date(session.created_at).toLocaleString() : undefined,
			detail: session.id,
			sessionId: session.id
		}));

		const picked = await vscode.window.showQuickPick(sessionItems, {
			placeHolder: 'Select a Padawan session to view'
		});

		if (!picked) {
			return;
		}

		return openSessionLog(picked.sessionId, copilotApi, context);
	}));

	return vscode.Disposable.from(...disposables);
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

async function openSessionLog(sessionId: string, copilotApi: CopilotApi, context: vscode.ExtensionContext): Promise<void> {
	const webviewPanel = vscode.window.createWebviewPanel('padawanSessionView', 'Padawan Session View', vscode.ViewColumn.Active);

	const distDir = vscode.Uri.joinPath(context.extensionUri, 'dist');

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
			<title>Padawan Log</title>
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webviewPanel.webview.cspSource}; script-src ${webviewPanel.webview.cspSource};">
		</head>
		<body>
			<div id="app"></div>

			<script type="module" src="${webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'webview-session-log-view.js'))}"></script>
		</body>
		</html>`;

	const info = await copilotApi.getSessionInfo(sessionId);
	const logs = await copilotApi.getLogsFromSession(sessionId);

	webviewPanel.webview.postMessage({
		type: 'init',
		info,
		logs,
	} as messages.InitMessage);
}