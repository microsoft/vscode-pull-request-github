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
			max-width: 600px;
		}
		.icon {
			margin-bottom: 1.5rem;
			opacity: 0.6;
		}
		.icon svg {
			width: 64px;
			height: 64px;
			fill: currentColor;
		}
		.title {
			font-size: 1.25rem;
			font-weight: 400;
			margin-bottom: 0.5rem;
			color: var(--vscode-foreground);
		}
		.subtitle {
			font-size: 0.95rem;
			color: var(--vscode-descriptionForeground);
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="icon">
			<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
				<path d="M13.5 0h-12C.67 0 0 .67 0 1.5v13c0 .83.67 1.5 1.5 1.5h12c.83 0 1.5-.67 1.5-1.5v-13c0-.83-.67-1.5-1.5-1.5zM13 14H2V2h11v12zM4 7h7v1H4V7zm0 2h7v1H4V9zm0 2h7v1H4v-1zM4 5h7v1H4V5z"/>
			</svg>
		</div>
		<div class="title">No changes to show.</div>
		<div class="subtitle">This commit has no content.</div>
	</div>
</body>
</html>`;
}
