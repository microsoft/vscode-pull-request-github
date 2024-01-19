/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger, { PR_TREE } from '../../common/logger';
import { FILE_LIST_LAYOUT, PR_SETTINGS_NAMESPACE } from '../../common/settingKeys';
import { PullRequestModel } from '../../github/pullRequestModel';
import { ReviewModel } from '../reviewModel';
import { DirectoryTreeNode } from './directoryTreeNode';
import { LabelOnlyNode, TreeNode, TreeNodeParent } from './treeNode';

export class FilesCategoryNode extends TreeNode implements vscode.TreeItem {
	public label: string = vscode.l10n.t('Files');
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
		this.childrenDisposables.push(this._reviewModel.onDidChangeLocalFileChanges(() => {
			Logger.appendLine(`Local files have changed, refreshing Files node`, PR_TREE);
			this.refresh(this);
		}));
		this.childrenDisposables.push(_pullRequestModel.onDidChangeReviewThreads(() => {
			Logger.appendLine(`Review threads have changed, refreshing Files node`, PR_TREE);
			this.refresh(this);
		}));
		this.childrenDisposables.push(_pullRequestModel.onDidChangeComments(() => {
			Logger.appendLine(`Comments have changed, refreshing Files node`, PR_TREE);
			this.refresh(this);
		}));
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getChildren(): Promise<TreeNode[]> {
		super.getChildren(false);

		Logger.appendLine(`Getting children for Files node`, PR_TREE);
		if (!this._reviewModel.hasLocalFileChanges) {
			// Provide loading feedback until we get the files.
			return new Promise<TreeNode[]>(resolve => {
				const promiseResolver = this._reviewModel.onDidChangeLocalFileChanges(() => {
					resolve([]);
					promiseResolver.dispose();
				});
			});
		}

		if (this._reviewModel.localFileChanges.length === 0) {
			return [new LabelOnlyNode(vscode.l10n.t('No changed files'))];
		}

		let nodes: TreeNode[];
		const layout = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string>(FILE_LIST_LAYOUT);

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
		Logger.appendLine(`Got all children for Files node`, PR_TREE);
		this.children = nodes;
		return nodes;
	}
}
