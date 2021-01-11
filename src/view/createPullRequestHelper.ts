/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { CreatePullRequestViewProvider } from '../github/createPRViewProvider';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { CompareChangesTreeProvider } from './compareChangesTreeDataProvider';

export class CreatePullRequestHelper {
	private _disposables: vscode.Disposable[] = [];
	private _createPRViewProvider: CreatePullRequestViewProvider | undefined;
	private _treeView: CompareChangesTreeProvider | undefined;

	private _onDidCreate = new vscode.EventEmitter<PullRequestModel>();
	readonly onDidCreate: vscode.Event<PullRequestModel> = this._onDidCreate.event;

	constructor(private readonly repository: Repository) { }

	private registerListeners() {
		this._disposables.push(this._createPRViewProvider!.onDone(async createdPR => {
			vscode.commands.executeCommand('setContext', 'github:createPullRequest', false);

			this._createPRViewProvider?.dispose();
			this._createPRViewProvider = undefined;

			this._treeView?.dispose();
			this._treeView = undefined;

			this._disposables.forEach(d => d.dispose());

			if (createdPR) {
				this._onDidCreate.fire(createdPR);
			}
		}));

		this._disposables.push(this._createPRViewProvider!.onDidChangeSelectedBranch(selectedBranch => {
			this._treeView?.updateBaseBranch(selectedBranch);
		}));

		this._disposables.push(this._createPRViewProvider!.onDidChangeSelectedRemote(remoteInfo => {
			this._treeView?.updateBaseOwner(remoteInfo.owner);
		}));
	}

	async create(extensionUri: vscode.Uri, folderRepoManager: FolderRepositoryManager, isDraft: boolean) {
		vscode.commands.executeCommand('setContext', 'github:createPullRequest', true);
		if (!this._createPRViewProvider) {
			const pullRequestDefaults = await folderRepoManager.getPullRequestDefaults();

			this._createPRViewProvider = new CreatePullRequestViewProvider(extensionUri, folderRepoManager, pullRequestDefaults, !!isDraft);
			this._treeView = new CompareChangesTreeProvider(this.repository, pullRequestDefaults.owner, pullRequestDefaults.base, folderRepoManager);

			this.registerListeners();

			this._disposables.push(vscode.window.registerWebviewViewProvider(CreatePullRequestViewProvider.viewType, this._createPRViewProvider));
		}

		this._createPRViewProvider.show();
	}
}