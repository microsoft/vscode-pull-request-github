/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestModel } from '../../github/pullRequestModel';
import { ReviewModel } from '../reviewModel';
import { DirectoryTreeNode } from './directoryTreeNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export class FilesCategoryNode extends TreeNode implements vscode.TreeItem {
	public label: string = 'Files';
	public collapsibleState: vscode.TreeItemCollapsibleState;
	private directories: TreeNode[] = [];

	constructor(
		public parent: TreeNodeParent,
		private _reviewModel: ReviewModel,
		_pullRequestModel: PullRequestModel
	) {
		super();
		this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		this.childrenDisposables = [];
		this.childrenDisposables.push(this._reviewModel.onDidChangeLocalFileChanges(() => this.refresh(this)));
		this.childrenDisposables.push(_pullRequestModel.onDidChangeReviewThreads(() => this.refresh(this)));
		this.childrenDisposables.push(_pullRequestModel.onDidChangeComments(() => this.refresh(this)));
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		if (this._reviewModel.localFileChanges.length === 0) {
			// Provide loading feedback until we get the files.
			return new Promise<TreeNode[]>(resolve => {
				const promiseResolver = this._reviewModel.onDidChangeLocalFileChanges(() => {
					resolve([]);
					promiseResolver.dispose();
				});
			});
		}

		let nodes: TreeNode[];
		const layout = vscode.workspace.getConfiguration('githubPullRequests').get<string>('fileListLayout');

		const dirNode = new DirectoryTreeNode(this, '');
		this._reviewModel.localFileChanges.forEach(f => dirNode.addFile(f));
		dirNode.finalize();
		if (dirNode.label === '') {
			// nothing on the root changed, pull children to parent
			this.directories = dirNode.children;
		} else {
			this.directories = [dirNode];
		}

		if (layout === 'tree') {
			nodes = this.directories;
		} else {
			nodes = this._reviewModel.localFileChanges;
		}
		return Promise.resolve(nodes);
	}
}
