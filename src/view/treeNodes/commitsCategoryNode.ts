/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { CommitNode } from './commitNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export class CommitsNode extends TreeNode implements vscode.TreeItem {
	public label: string = 'Commits';
	public collapsibleState: vscode.TreeItemCollapsibleState;
	private _folderRepoManager: FolderRepositoryManager;
	private _pr: PullRequestModel;

	constructor(
		parent: TreeNodeParent,
		reposManager: FolderRepositoryManager,
		pr: PullRequestModel,
	) {
		super();
		this.parent = parent;
		this._pr = pr;
		this._folderRepoManager = reposManager;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;

		this.childrenDisposables = [];
		this.childrenDisposables.push(this._pr.onDidChangeReviewThreads(() => this.refresh(this)));
		this.childrenDisposables.push(this._pr.onDidChangeComments(() => this.refresh(this)));
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		try {
			const commits = await this._pr.getCommits();
			const commitNodes = commits.map(
				(commit, index) => new CommitNode(this, this._folderRepoManager, this._pr, commit, index === commits.length - 1),
			);
			return Promise.resolve(commitNodes);
		} catch (e) {
			return Promise.resolve([]);
		}
	}
}
