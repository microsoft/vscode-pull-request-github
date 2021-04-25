/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../azdo/folderRepositoryManager';
import { PullRequestModel } from '../azdo/pullRequestModel';
import { SETTINGS_NAMESPACE } from '../constants';
import { GitFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { RepositoryChangesNode } from './treeNodes/repositoryChangesNode';
import { BaseTreeNode, TreeNode } from './treeNodes/treeNode';

export class PullRequestChangesTreeDataProvider
	extends vscode.Disposable
	implements vscode.TreeDataProvider<TreeNode>, BaseTreeNode {
	private _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _disposables: vscode.Disposable[] = [];

	private _pullRequestManagerMap: Map<FolderRepositoryManager, RepositoryChangesNode> = new Map();
	private _view: vscode.TreeView<TreeNode>;

	public get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(private _context: vscode.ExtensionContext) {
		super(() => this.dispose());
		this._view = vscode.window.createTreeView('azdoprStatus:azdo', {
			treeDataProvider: this,
			showCollapseAll: true,
		});
		this._context.subscriptions.push(this._view);

		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration(async e => {
				if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.fileListLayout`)) {
					this._onDidChangeTreeData.fire();
					const layout = vscode.workspace.getConfiguration(`${SETTINGS_NAMESPACE}`).get<string>('fileListLayout');
					await vscode.commands.executeCommand('setContext', 'fileListLayout:flat', layout === 'flat');
				}
			}),
		);
	}

	refresh() {
		this._onDidChangeTreeData.fire();
	}

	async addPrToView(
		pullRequestManager: FolderRepositoryManager,
		pullRequest: PullRequestModel,
		localFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
		comments: GitPullRequestCommentThread[],
	) {
		const node: RepositoryChangesNode = new RepositoryChangesNode(
			this,
			pullRequest,
			pullRequestManager,
			comments,
			localFileChanges,
		);
		this._pullRequestManagerMap.set(pullRequestManager, node);
		await vscode.commands.executeCommand('setContext', 'azdo:inReviewMode', true);
		this._onDidChangeTreeData.fire();
	}

	async removePrFromView(pullRequestManager: FolderRepositoryManager) {
		this._pullRequestManagerMap.delete(pullRequestManager);
		if (this._pullRequestManagerMap.size === 0) {
			this.hide();
		}
		this._onDidChangeTreeData.fire();
	}

	async hide() {
		await vscode.commands.executeCommand('setContext', 'azdo:inReviewMode', false);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element.getTreeItem();
	}

	getParent(element: TreeNode) {
		return element.getParent();
	}

	async reveal(element: TreeNode, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }): Promise<void> {
		this._view.reveal(element, options);
	}

	async getChildren(element?: GitFileChangeNode): Promise<TreeNode[]> {
		if (!element) {
			const result: TreeNode[] = [];
			if (this._pullRequestManagerMap.size >= 1) {
				for (const item of this._pullRequestManagerMap.values()) {
					result.push(item);
				}
			}
			return result;
		} else {
			return await element.getChildren();
		}
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}
