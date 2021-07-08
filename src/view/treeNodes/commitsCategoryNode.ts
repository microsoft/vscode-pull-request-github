/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IComment } from '../../common/comment';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { CommitNode } from './commitNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export class CommitsNode extends TreeNode implements vscode.TreeItem {
	public label: string = 'Commits';
	public collapsibleState: vscode.TreeItemCollapsibleState;
	private _folderRepoManager: FolderRepositoryManager;
	private _pr: PullRequestModel;
	private _comments: IComment[];

	constructor(
		parent: TreeNodeParent,
		reposManager: FolderRepositoryManager,
		pr: PullRequestModel,
		comments: IComment[],
	) {
		super();
		this.parent = parent;
		this._pr = pr;
		this._folderRepoManager = reposManager;
		this._comments = comments;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		try {
			const commits = await this._pr.getCommits();
			const commitNodes = commits.map(
				(commit, index) => new CommitNode(this, this._folderRepoManager, this._pr, commit, this._comments, index === commits.length - 1),
			);
			return Promise.resolve(commitNodes);
		} catch (e) {
			return Promise.resolve([]);
		}
	}
}
