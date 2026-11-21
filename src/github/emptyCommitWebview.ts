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

	panel.iconPath = {
		light: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'codicons', 'git-commit.svg'),
		dark: vscode.Uri.joinPath(extensionUri, 'resources', 'icons', 'codicons', 'git-commit.svg')
	};

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
			<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M9.99994 11.999H4.99994V10.999H9.99994V11.999Z"/><path d="M7.99994 5.99902H9.99994V6.99902H7.99994V9H6.99994V6.99902H4.99994V5.99902H6.99994V4H7.99994V5.99902Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M10.7099 1.28906L13.7099 4.28906L13.9999 4.99902V13.999L12.9999 14.999H2.99994L1.99994 13.999V1.99902L2.99994 0.999023H9.99994L10.7099 1.28906ZM2.99994 13.999H12.9999V4.99902L9.99994 1.99902H2.99994V13.999Z"/></svg>
		</div>
		<div class="title">No changes to show.</div>
		<div class="subtitle">This commit has no content.</div>
	</div>
</body>
</html>`;
}
