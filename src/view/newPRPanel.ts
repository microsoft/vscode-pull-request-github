/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce } from '../common/utils';
import { Store } from '../store';

export class NewPRPanel {
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static current: NewPRPanel | undefined;

	private static readonly _viewType = 'NewPR';

	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];

	private static _extensionPath: string | undefined;

	public static init(extensionPath: string) {
		this._extensionPath = extensionPath;
	}

	public static show() {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (this.current) {
			return this.current._panel.reveal(column, true);
		}

		this.current = new NewPRPanel(column || vscode.ViewColumn.One);
	}

	private constructor(column: vscode.ViewColumn) {
		// Create and show a new webview panel
		this._panel = vscode.window.createWebviewPanel(
			NewPRPanel._viewType,
			'Create Pull Request', column, {
				// Enable javascript in the webview
				enableScripts: true,

				// And restric the webview to only loading content from our extension's `media` directory.
				localResourceRoots: [
					vscode.Uri.file(path.join(NewPRPanel._extensionPath, 'media'))
				]
			}
		);
		this._panel.webview.html = this.getHtml();

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Dispatch store state to the webview
		Store.onState(this._sendState, this._disposables);

		// Handle messages from the webview as actions
		this._panel.webview.onDidReceiveMessage(Store.dispatch, Store, this._disposables);
	}

	public dispose() {
		NewPRPanel.current = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	_sendState = state =>
		this._panel.webview.postMessage(state)

	private getHtml() {
		const scriptPathOnDisk = vscode.Uri.file(path.join(NewPRPanel._extensionPath, 'media', 'create.js'));
		const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Create Pull Request</title>
			</head>
			<body>
				<div id=main></div>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}
