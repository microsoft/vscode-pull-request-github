/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { addDisposable, Disposable, disposeAll } from '../common/lifecycle';
import { PullRequestViewProvider } from '../github/activityBarViewProvider';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { ReviewManager } from './reviewManager';

export class WebviewViewCoordinator extends Disposable {
	private _webviewViewProvider?: PullRequestViewProvider;
	private _pullRequestModel: Map<PullRequestModel, { folderRepositoryManager: FolderRepositoryManager, reviewManager: ReviewManager }> = new Map();
	private readonly _currentDisposables: Disposable[] = [];

	constructor(private _context: vscode.ExtensionContext) {
		super();
	}

	public override dispose() {
		super.dispose();
		this.reset();
	}

	reset() {
		disposeAll(this._currentDisposables);
		this._webviewViewProvider = undefined;
	}

	private create(pullRequestModel: PullRequestModel, folderRepositoryManager: FolderRepositoryManager, reviewManager: ReviewManager) {
		this._webviewViewProvider = addDisposable(new PullRequestViewProvider(this._context.extensionUri, folderRepositoryManager, reviewManager, pullRequestModel), this._currentDisposables);
		addDisposable(vscode.window.registerWebviewViewProvider(
			this._webviewViewProvider.viewType,
			this._webviewViewProvider,
		), this._currentDisposables);
		addDisposable(vscode.commands.registerCommand('pr.refreshActivePullRequest', _ => {
			this._webviewViewProvider?.refresh();
		}), this._currentDisposables);
	}

	public setPullRequest(pullRequestModel: PullRequestModel, folderRepositoryManager: FolderRepositoryManager, reviewManager: ReviewManager, replace?: PullRequestModel) {
		if (replace) {
			this._pullRequestModel.delete(replace);
		}
		this._pullRequestModel.set(pullRequestModel, { folderRepositoryManager, reviewManager });
		this.updatePullRequest();
	}

	private updatePullRequest() {
		const pullRequestModel = Array.from(this._pullRequestModel.keys())[0];
		if (!pullRequestModel) {
			this.reset();
			return;
		}
		const { folderRepositoryManager, reviewManager } = this._pullRequestModel.get(pullRequestModel)!;
		if (!this._webviewViewProvider) {
			this.create(pullRequestModel, folderRepositoryManager, reviewManager);
		} else {
			this._webviewViewProvider.updatePullRequest(pullRequestModel);
		}
	}

	public removePullRequest(pullRequestModel: PullRequestModel) {
		const oldHead = Array.from(this._pullRequestModel.keys())[0];
		this._pullRequestModel.delete(pullRequestModel);
		const newHead = Array.from(this._pullRequestModel.keys())[0];
		if (newHead !== oldHead) {
			this.updatePullRequest();
		}
	}

	public show(pullRequestModel: PullRequestModel) {
		if (this._webviewViewProvider && (this._pullRequestModel.size > 0) && (Array.from(this._pullRequestModel.keys())[0] === pullRequestModel)) {
			this._webviewViewProvider.show();
		}
	}
}