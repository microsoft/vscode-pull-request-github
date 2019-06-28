/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TreeNode } from './treeNode';
import { CommitNode } from './commitNode';
import { IComment } from '../../common/comment';
import { PullRequestManager } from '../../github/pullRequestManager';
import { PullRequestModel } from '../../github/pullRequestModel';

export class CommitsNode extends TreeNode implements vscode.TreeItem {
	public label: string = 'Commits';
	public collapsibleState: vscode.TreeItemCollapsibleState;
	private _prManager: PullRequestManager;
	private _pr: PullRequestModel;
	private _comments: IComment[];

	constructor(parent: TreeNode | vscode.TreeView<TreeNode>, prManager: PullRequestManager, pr: PullRequestModel, comments: IComment[]) {
		super();
		this.parent = parent;
		this._pr = pr;
		this._prManager = prManager;
		this._comments = comments;
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		try {
			const commits = await this._prManager.getPullRequestCommits(this._pr);
			const commitNodes = commits.map(commit => new CommitNode(this, this._prManager, this._pr, commit, this._comments));
			return Promise.resolve(commitNodes);
		} catch (e) {
			return Promise.resolve([]);
		}
	}
}