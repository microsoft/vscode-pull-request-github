/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { DescriptionNode } from './treeNodes/descriptionNode';
import { TreeNode } from './treeNodes/treeNode';
import { FilesCategoryNode } from './treeNodes/filesCategoryNode';
import { CommitsNode } from './treeNodes/commitsCategoryNode';
import { Comment } from '../common/comment';
import { PullRequestManager } from '../github/pullRequestManager';
import { PullRequestModel } from '../github/pullRequestModel';

export class PullRequestChangesTreeDataProvider extends vscode.Disposable implements vscode.TreeDataProvider<TreeNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<GitFileChangeNode | DescriptionNode>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _disposables: vscode.Disposable[] = [];

	private _localFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];
	private _comments: Comment[] = [];
	private _pullrequest: PullRequestModel = null;
	private _pullRequestManager: PullRequestManager;

	constructor(private context: vscode.ExtensionContext) {
		super(() => this.dispose());
		this.context.subscriptions.push(vscode.window.createTreeView('prStatus', {
			treeDataProvider: this,
			showCollapseAll: true
		}));
	}

	refresh() {
		this._onDidChangeTreeData.fire();
	}

	async showPullRequestFileChanges(pullRequestManager: PullRequestManager, pullrequest: PullRequestModel, fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[], comments: Comment[]) {
		this._pullRequestManager = pullRequestManager;
		this._pullrequest = pullrequest;
		this._comments = comments;

		await vscode.commands.executeCommand(
			'setContext',
			'github:inReviewMode',
			true
		);

		this._localFileChanges = fileChanges;
		this._onDidChangeTreeData.fire();
	}

	async hide() {
		await vscode.commands.executeCommand(
			'setContext',
			'github:inReviewMode',
			false
		);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element.getTreeItem();
	}

	getChildren(element?: GitFileChangeNode): vscode.ProviderResult<TreeNode[]> {
		if (!element) {
			const descriptionNode = new DescriptionNode(this._pullrequest.title,
				this._pullrequest.userAvatarUri, this._pullrequest);
			const filesCategoryNode = new FilesCategoryNode(this._localFileChanges);
			const commitsCategoryNode = new CommitsNode(this._pullRequestManager, this._pullrequest, this._comments);
			return [ descriptionNode, filesCategoryNode, commitsCategoryNode ];
		} else {
			return element.getChildren();
		}
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}