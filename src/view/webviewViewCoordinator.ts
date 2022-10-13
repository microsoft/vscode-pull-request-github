/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestViewProvider } from '../github/activityBarViewProvider';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { ReviewManager } from './reviewManager';

export class WebviewViewCoordinator {
	private _webviewViewProvider?: PullRequestViewProvider;
	private _pullRequestModel: Map<PullRequestModel, { folderRepositoryManager: FolderRepositoryManager, reviewManager: ReviewManager }> = new Map();

	constructor(private _context: vscode.ExtensionContext) { }

	private create(pullRequestModel: PullRequestModel, folderRepositoryManager: FolderRepositoryManager, reviewManager: ReviewManager) {
		this._webviewViewProvider = new PullRequestViewProvider(this._context.extensionUri, folderRepositoryManager, reviewManager, pullRequestModel);
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

	public setPullRequest(pullRequestModel: PullRequestModel, folderRepositoryManager: FolderRepositoryManager, reviewManager: ReviewManager) {
		this._pullRequestModel.set(pullRequestModel, { folderRepositoryManager, reviewManager });
		this.updatePullRequest();
	}

	private updatePullRequest() {
		const pullRequestModel = Array.from(this._pullRequestModel.keys())[0];
		if (!pullRequestModel) {
			return;
		}
		const { folderRepositoryManager, reviewManager } = this._pullRequestModel.get(pullRequestModel)!;
		if (!this._webviewViewProvider) {
			this.create(pullRequestModel, folderRepositoryManager, reviewManager);
		} else {
			this._webviewViewProvider.updatePullRequest(pullRequestModel);
		}
	}

	public removePullRequest(pullReqestModel: PullRequestModel) {
		const oldHead = Array.from(this._pullRequestModel.keys())[0];
		this._pullRequestModel.delete(pullReqestModel);
		const newHead = Array.from(this._pullRequestModel.keys())[0];
		if (newHead !== oldHead) {
			this.updatePullRequest();
		}
	}

	public show(pullReqestModel: PullRequestModel) {
		if (this._webviewViewProvider && (this._pullRequestModel.size > 0) && (Array.from(this._pullRequestModel.keys())[0] === pullReqestModel)) {
			this._webviewViewProvider.show();
		}
	}
}