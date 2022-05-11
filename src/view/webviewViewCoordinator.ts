/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestViewProvider } from '../github/activityBarViewProvider';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';

export class WebviewViewCoordinator {
	private _webviewViewProvider?: PullRequestViewProvider;
	private _pullRequestModel?: PullRequestModel;

	constructor(private _context: vscode.ExtensionContext) { }

	private create(pullRequestModel: PullRequestModel, folderRepositoryManager: FolderRepositoryManager) {
		this._webviewViewProvider = new PullRequestViewProvider(this._context.extensionUri, folderRepositoryManager, pullRequestModel);
		this._context.subscriptions.push(
			vscode.window.registerWebviewViewProvider(
				this._webviewViewProvider.viewType,
				this._webviewViewProvider,
			),
		);
		this._context.subscriptions.push(
			vscode.commands.registerCommand('pr.refreshActivePullRequest', _ => {
				this._webviewViewProvider?.refresh();
			}),
		);
	}

	public setPullRequest(pullRequestModel: PullRequestModel, folderRepositoryManager: FolderRepositoryManager) {
		this._pullRequestModel = pullRequestModel;
		if (!this._webviewViewProvider) {
			this.create(pullRequestModel, folderRepositoryManager);
		} else {
			this._webviewViewProvider.updatePullRequest(pullRequestModel);
		}
	}

	public show(pullReqestModel: PullRequestModel) {
		if (this._webviewViewProvider && (this._pullRequestModel === pullReqestModel)) {
			this._webviewViewProvider.show();
		}
	}
}