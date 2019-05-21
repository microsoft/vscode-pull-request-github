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
import { PullRequestManager, SETTINGS_NAMESPACE, REMOTES_SETTING } from '../github/pullRequestManager';

interface CategoryState {
	[name: string]: string;
}

const defaultCategories = {
	'Waiting For My Review': 'is:open review-requested:${user}',
	'Assigned To Me': 'is:open assignee:${user}',
	'Created By Me': 'is:open author:${user}'
};

const CATEGORY_STATE_KEY = 'githubPullRequestCategories';

export class PullRequestsTreeDataProvider implements vscode.TreeDataProvider<TreeNode>, vscode.DecorationProvider, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> { return this._onDidChange.event; }
	private _disposables: vscode.Disposable[];
	private _childrenDisposables: vscode.Disposable[];
	private _view: vscode.TreeView<TreeNode>;
	private _prManager: PullRequestManager;
	private _initialized: boolean = false;
	private _categories: CategoryState;

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(
		private _telemetry: ITelemetry,
		private _context: vscode.ExtensionContext
	) {
		this._disposables = [];
		this.initializeCategories(_context);
		this._disposables.push(vscode.workspace.registerTextDocumentContentProvider('pr', getInMemPRContentProvider()));
		this._disposables.push(vscode.window.registerDecorationProvider(this));
		this._disposables.push(vscode.commands.registerCommand('pr.refreshList', _ => {
			this._onDidChangeTreeData.fire();
		}));

		this._disposables.push(vscode.commands.registerCommand('pr.loadMore', (node: CategoryTreeNode) => {
			node.fetchNextPage = true;
			this._onDidChangeTreeData.fire(node);
		}));

		const treeId = vscode.workspace.getConfiguration('githubPullRequests').get<boolean>('showInSCM') ? 'pr:scm' : 'pr:github';
		this._view = vscode.window.createTreeView(treeId, {
			treeDataProvider: this,
			showCollapseAll: true
		});

		this._disposables.push(this._view);
		this._childrenDisposables = [];

		this._disposables.push(vscode.commands.registerCommand('pr.configurePRViewlet', async () => {
			const categoryAction = await vscode.window.showQuickPick(['Add Category', 'Remove Category']);

			switch (categoryAction) {
				case 'Add Category':
					const categoryName = await vscode.window.showInputBox({ prompt: 'Enter a category name'});
					if (categoryName) {
						if (this._categories[categoryName]) {
							vscode.window.showErrorMessage(`The name '${categoryName}' is already taken. Please use a different category name or edit the existing category.`);
						}

						const query = await vscode.window.showInputBox({ prompt: 'Enter a search query for the category', ignoreFocusOut: true, placeHolder: 'is:open mentions:${user}'});
						if (query) {
							this.addCategory(categoryName, query);
							this.refresh();
						}
					}
					return;
				case 'Remove Category':
					const categoryNames = Object.keys(this._categories);
					const categoryToRemove = await vscode.window.showQuickPick(categoryNames);
					if (categoryToRemove) {
						// Prompt to confirm?
						this.removeCategory(categoryToRemove);
						this.refresh();
					}
				default:
					return;
			}
		}));
	}

	private addCategory(categoryName: string, categoryQuery: string): void {
		this._categories[categoryName] = categoryQuery;
		this._context.globalState.update(CATEGORY_STATE_KEY, this._categories);
	}

	private removeCategory(categoryName: string) {
		delete this._categories[categoryName];
		this._context.globalState.update(CATEGORY_STATE_KEY, this._categories);
	}

	private initializeCategories(context: vscode.ExtensionContext) {
		const existingCategoryState = context.globalState.get<CategoryState>(CATEGORY_STATE_KEY);
		if (existingCategoryState) {
			this._categories = existingCategoryState;
		} else {
			this._categories = defaultCategories;
			context.globalState.update(CATEGORY_STATE_KEY, defaultCategories);
		}
	}

	initialize(prManager: PullRequestManager) {
		if (this._initialized) {
			throw new Error('Tree has already been initialized!');
		}

		this._initialized = true;
		this._prManager = prManager;
		this.refresh();
	}

	async refresh(node?: TreeNode) {
		return node ? this._onDidChangeTreeData.fire(node) : this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element.getTreeItem();
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!this._prManager) {
			if (!vscode.workspace.workspaceFolders) {
				return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.NoOpenFolder)]);
			} else {
				return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.NoGitRepositories)]);
			}
		}

		if (!this._prManager.getGitHubRemotes().length) {
			const remotesSetting = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string[]>(REMOTES_SETTING);
			if (remotesSetting) {
				return Promise.resolve([
					new PRCategoryActionNode(this._view, PRCategoryActionType.NoMatchingRemotes),
					new PRCategoryActionNode(this._view, PRCategoryActionType.ConfigureRemotes)
				]);
			}

			return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.NoRemotes)]);
		}

		if (!element) {
			if (this._childrenDisposables && this._childrenDisposables.length) {
				this._childrenDisposables.forEach(dispose => dispose.dispose());
			}

			const queryCategories = Object.keys(this._categories).map(categoryName => {
				return new CategoryTreeNode(this._view, this._prManager, this._telemetry, PRType.Query, categoryName, this._categories[categoryName]);
			});
			let result = [
				new CategoryTreeNode(this._view, this._prManager, this._telemetry, PRType.LocalPullRequest),
				...queryCategories,
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

	async getParent(element: TreeNode): Promise<TreeNode | undefined> {
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
