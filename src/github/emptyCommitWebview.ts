/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Opens a webview panel to display a message for an empty commit.
 * The message is centered and styled similar to GitHub.com.
 */
export function showEmptyCommitWebview(extensionUri: vscode.Uri, commitSha: string): void {
	const panel = vscode.window.createWebviewPanel(
		'emptyCommit',
		vscode.l10n.t('Commit {0}', commitSha.substring(0, 7)),
		vscode.ViewColumn.Active,
		{
			enableScripts: false,
			localResourceRoots: []
		}
	);

	panel.webview.html = getEmptyCommitHtml();
}

function getEmptyCommitHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Empty Commit</title>
	<style>
		body {
			margin: 0;
			padding: 0;
			height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
			background-color: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
		}
		.container {
			text-align: center;
			padding: 2rem;
		}
		.message {
			font-size: 1.2rem;
			line-height: 1.6;
			color: var(--vscode-descriptionForeground);
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="message">
			No changes to show.<br>
			This commit has no content.
		</div>
	</div>
</body>
</html>`;
}
