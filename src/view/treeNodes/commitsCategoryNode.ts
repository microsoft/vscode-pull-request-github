/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger, { PR_TREE } from '../../common/logger';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { CommitNode } from './commitNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export class CommitsNode extends TreeNode implements vscode.TreeItem {
	public label: string = vscode.l10n.t('Commits');
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
		this.childrenDisposables.push(this._pr.onDidChangeReviewThreads(() => {
			Logger.appendLine(`Review threads have changed, refreshing Commits node`, PR_TREE);
			this.refresh(this);
		}));
		this.childrenDisposables.push(this._pr.onDidChangeComments(() => {
			Logger.appendLine(`Comments have changed, refreshing Commits node`, PR_TREE);
			this.refresh(this);
		}));
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		super.getChildren();
		try {
			Logger.appendLine(`Getting children for Commits node`, PR_TREE);
			const commits = await this._pr.getCommits();
			this.children = commits.map(
				(commit, index) => new CommitNode(this, this._folderRepoManager, this._pr, commit, (index === commits.length - 1) && (this._folderRepoManager.repository.state.HEAD?.commit === commit.sha)),
			);
			Logger.appendLine(`Got all children for Commits node`, PR_TREE);
			return this.children;
		} catch (e) {
			return [];
		}
	}
}
