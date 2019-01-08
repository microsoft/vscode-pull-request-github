/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TreeNode } from './treeNodes/treeNode';
import { PRCategoryActionNode, CategoryTreeNode, PRCategoryActionType } from './treeNodes/categoryNode';
import { PRType, ITelemetry } from '../github/interface';
import { fromFileChangeNodeUri } from '../common/uri';
import { getInMemPRContentProvider } from './inMemPRContentProvider';
import { getPRDocumentCommentProvider } from './prDocumentCommentProvider';
import { PullRequestManager } from '../github/pullRequestManager';

export class PullRequestsTreeDataProvider implements vscode.TreeDataProvider<TreeNode>, vscode.DecorationProvider, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> { return this._onDidChange.event; }
	private _disposables: vscode.Disposable[];
	private _childrenDisposables: vscode.Disposable[];
	private _view: vscode.TreeView<TreeNode>;

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(
		onShouldReload: vscode.Event<any>,
		private _prManager: PullRequestManager,
		private _telemetry: ITelemetry
	) {
		this._disposables = [];
		this._disposables.push(vscode.workspace.registerTextDocumentContentProvider('pr', getInMemPRContentProvider()));
		this._disposables.push(vscode.workspace.registerDocumentCommentProvider(getPRDocumentCommentProvider()));
		this._disposables.push(vscode.window.registerDecorationProvider(this));
		this._disposables.push(vscode.commands.registerCommand('pr.refreshList', _ => {
			this._onDidChangeTreeData.fire();
		}));

		this._disposables.push(vscode.commands.registerCommand('pr.loadMore', (node: CategoryTreeNode) => {
			node.fetchNextPage = true;
			this._onDidChangeTreeData.fire(node);
		}));

		this._view = vscode.window.createTreeView('pr', {
			treeDataProvider: this,
			showCollapseAll: true
		});

		this._disposables.push(this._view);
		this._disposables.push(onShouldReload(e => {
			this._onDidChangeTreeData.fire();
		}));
		this._childrenDisposables = [];
	}

	async refresh(node?: TreeNode) {
		return node ? this._onDidChangeTreeData.fire(node) : this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element.getTreeItem();
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!element) {
			if (this._childrenDisposables && this._childrenDisposables.length) {
				this._childrenDisposables.forEach(dispose => dispose.dispose());
			}

			let result = [
				new CategoryTreeNode(this._view, this._prManager, this._telemetry, PRType.LocalPullRequest),
				new CategoryTreeNode(this._view, this._prManager, this._telemetry, PRType.RequestReview),
				new CategoryTreeNode(this._view, this._prManager, this._telemetry, PRType.AssignedToMe),
				new CategoryTreeNode(this._view, this._prManager, this._telemetry, PRType.Mine),
				new CategoryTreeNode(this._view, this._prManager, this._telemetry, PRType.All)
			];

			this._childrenDisposables = result;
			return Promise.resolve(result);
		}
		if (this._prManager.repository.state.remotes.length === 0) {
			return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.Empty)]);
		}

		return element.getChildren();
	}

	async getParent(element: TreeNode): Promise<TreeNode> {
		return element.getParent();
	}

	_onDidChangeDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
	onDidChangeDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeDecorations.event;
	provideDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DecorationData> {
		let fileChangeUriParams = fromFileChangeNodeUri(uri);
		if (fileChangeUriParams && fileChangeUriParams.hasComments) {
			return {
				bubble: false,
				title: 'Commented',
				letter: '◆',
				priority: 2
			};
		}

		return undefined;
	}

	dispose() {
		this._disposables.forEach(dispose => dispose.dispose());
	}

}
