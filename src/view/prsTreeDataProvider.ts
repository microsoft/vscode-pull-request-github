/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IConfiguration } from '../authentication/configuration';
import { Repository } from '../typings/git';
import { TreeNode } from './treeNodes/treeNode';
import { PRCategoryActionNode, CategoryTreeNode, PRCategoryActionType } from './treeNodes/categoryNode';
import { IPullRequestManager, PRType, ITelemetry } from '../github/interface';
import { fromFileChangeNodeUri } from '../common/uri';
import { getInMemPRContentProvider } from './inMemPRContentProvider';
import { getPRDocumentCommentProvider } from './prDocumentCommentProvider';

export class PullRequestsTreeDataProvider implements vscode.TreeDataProvider<TreeNode>, vscode.DecorationProvider, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> { return this._onDidChange.event; }
	private _disposables: vscode.Disposable[];
	private _childrenDisposables: vscode.Disposable[];

	constructor(
		private _configuration: IConfiguration,
		private _repository: Repository,
		private _prManager: IPullRequestManager,
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

		this._disposables.push(vscode.window.registerTreeDataProvider<TreeNode>('pr', this));
		this._disposables.push(this._configuration.onDidChange(e => {
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
				new CategoryTreeNode(this._prManager, this._telemetry, this._repository, PRType.LocalPullRequest),
				new CategoryTreeNode(this._prManager, this._telemetry, this._repository, PRType.RequestReview),
				new CategoryTreeNode(this._prManager, this._telemetry, this._repository, PRType.AssignedToMe),
				new CategoryTreeNode(this._prManager, this._telemetry, this._repository, PRType.Mine),
				new CategoryTreeNode(this._prManager, this._telemetry, this._repository, PRType.All)
			];

			this._childrenDisposables = result;
			return Promise.resolve(result);
		}
		if (this._repository.state.remotes.length === 0) {
			return Promise.resolve([new PRCategoryActionNode(PRCategoryActionType.Empty)]);
		}

		return element.getChildren();
	}

	_onDidChangeDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
	onDidChangeDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeDecorations.event;
	provideDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DecorationData> {
		let fileChangeUriParams = fromFileChangeNodeUri(uri);
		if (fileChangeUriParams && fileChangeUriParams.hasComments) {
			return {
				bubble: false,
				title: 'Commented',
				letter: '◆'
			};
		}

		return {};
	}

	dispose() {
		this._disposables.forEach(dispose => dispose.dispose());
	}

}
