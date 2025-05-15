/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ITelemetry } from './common/telemetry';
import { fromOpenIssueWebviewUri, fromOpenPullRequestWebviewUri, UriHandlerPaths } from './common/uri';
import { IssueOverviewPanel } from './github/issueOverview';
import { PullRequestOverviewPanel } from './github/pullRequestOverview';
import { RepositoriesManager } from './github/repositoriesManager';

export class UriHandler implements vscode.UriHandler {
	constructor(private readonly _reposManagers: RepositoriesManager,
		private readonly _telemetry: ITelemetry,
		private readonly _context: vscode.ExtensionContext
	) { }

	async handleUri(uri: vscode.Uri): Promise<void> {
		switch (uri.path) {
			case UriHandlerPaths.OpenIssueWebview:
				return this._openIssueWebview(uri);
			case UriHandlerPaths.OpenPullRequestWebview:
				return this._openPullRequestWebview(uri);
		}
	}

	private async _openIssueWebview(uri: vscode.Uri): Promise<void> {
		const params = fromOpenIssueWebviewUri(uri);
		if (!params) {
			return;
		}
		const folderManager = this._reposManagers.getManagerForRepository(params.owner, params.repo) ?? this._reposManagers.folderManagers[0];
		const issue = await folderManager.resolveIssue(params.owner, params.repo, params.issueNumber, true);
		if (!issue) {
			return;
		}
		return IssueOverviewPanel.createOrShow(this._telemetry, this._context.extensionUri, folderManager, issue);
	}

	private async _openPullRequestWebview(uri: vscode.Uri): Promise<void> {
		const params = fromOpenPullRequestWebviewUri(uri);
		if (!params) {
			return;
		}
		const folderManager = this._reposManagers.getManagerForRepository(params.owner, params.repo) ?? this._reposManagers.folderManagers[0];
		const pullRequest = await folderManager.resolvePullRequest(params.owner, params.repo, params.pullRequestNumber);
		if (!pullRequest) {
			return;
		}
		return PullRequestOverviewPanel.createOrShow(this._telemetry, this._context.extensionUri, folderManager, pullRequest);
	}

}