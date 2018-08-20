/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Resource } from '../common/resources';
import { IPullRequestModel, IPullRequestManager } from '../github/interface';
import { FileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { DescriptionNode } from './treeNodes/descriptionNode';
import { TreeNode } from './treeNodes/treeNode';
import { FilesCategoryNode } from './treeNodes/filesCategoryNode';
import { CommitsNode } from './treeNodes/commitsCategoryNode';
import { Comment } from '../common/comment';

export class PullRequestChangesTreeDataProvider extends vscode.Disposable implements vscode.TreeDataProvider<TreeNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<FileChangeNode | DescriptionNode>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _disposables: vscode.Disposable[] = []

	private _localFileChanges: (FileChangeNode | RemoteFileChangeNode)[] = [];
	private _comments: Comment[] = [];
	private _pullrequest: IPullRequestModel = null;
	private _pullRequestManager: IPullRequestManager;

	constructor(private context: vscode.ExtensionContext) {
		super(() => this.dispose());
		this.context.subscriptions.push(vscode.window.registerTreeDataProvider<TreeNode>('prStatus', this));
	}

	refresh() {
		this._onDidChangeTreeData.fire();
	}

	async showPullRequestFileChanges(pullRequestManager: IPullRequestManager, pullrequest: IPullRequestModel, fileChanges: (FileChangeNode | RemoteFileChangeNode)[], comments: Comment[]) {
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

	getChildren(element?: FileChangeNode): vscode.ProviderResult<TreeNode[]> {
		if (!element) {
			const descriptionNode = new DescriptionNode('Description',
				{
					light: Resource.icons.light.Description,
					dark: Resource.icons.dark.Description
				}, this._pullrequest);
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