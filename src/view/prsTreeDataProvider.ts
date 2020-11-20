/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TreeNode } from './treeNodes/treeNode';
import { PRCategoryActionNode, CategoryTreeNode, PRCategoryActionType } from './treeNodes/categoryNode';
import { getInMemPRContentProvider } from './inMemPRContentProvider';
import { SETTINGS_NAMESPACE, REMOTES_SETTING, ReposManagerState } from '../github/folderRepositoryManager';
import { ITelemetry } from '../common/telemetry';
import { DecorationProvider } from './treeDecorationProvider';
import { WorkspaceFolderNode, QUERIES_SETTING } from './treeNodes/workspaceFolderNode';
import { RepositoriesManager } from '../github/repositoriesManager';

export class PullRequestsTreeDataProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> { return this._onDidChange.event; }
	private _disposables: vscode.Disposable[];
	private _childrenDisposables: vscode.Disposable[];
	private _view: vscode.TreeView<TreeNode>;
	private _reposManager: RepositoriesManager;
	private _initialized: boolean = false;

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(
		private _telemetry: ITelemetry
	) {
		this._disposables = [];
		this._disposables.push(vscode.workspace.registerTextDocumentContentProvider('pr', getInMemPRContentProvider()));
		this._disposables.push(vscode.window.registerFileDecorationProvider(DecorationProvider));
		this._disposables.push(vscode.commands.registerCommand('pr.refreshList', _ => {
			this._onDidChangeTreeData.fire();
		}));

		this._disposables.push(vscode.commands.registerCommand('pr.loadMore', (node: CategoryTreeNode) => {
			node.fetchNextPage = true;
			this._onDidChangeTreeData.fire(node);
		}));

		this._view = vscode.window.createTreeView('pr:github', {
			treeDataProvider: this,
			showCollapseAll: true
		});

		this._disposables.push(this._view);
		this._childrenDisposables = [];

		this._disposables.push(vscode.commands.registerCommand('pr.configurePRViewlet', async () => {
			const isLoggedIn = this._reposManager.state === ReposManagerState.RepositoriesLoaded;
			const configuration = await vscode.window.showQuickPick(['Configure Remotes...', 'Configure Queries...', ...isLoggedIn ? ['Sign out of GitHub...'] : []]);

			const { name, publisher } = require('../../package.json') as { name: string, publisher: string };
			const extensionId = `${publisher}.${name}`;

			switch (configuration) {
				case 'Configure Queries...':
					return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId} queries`);
				case 'Configure Remotes...':
					return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId} remotes`);
				case 'Sign out of GitHub...':
					return vscode.commands.executeCommand('auth.signout');
				default:
					return;
			}
		}));

		this._disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.fileListLayout`)) {
				this._onDidChangeTreeData.fire();
			}
		}));

	}

	initialize(reposManager: RepositoriesManager) {
		if (this._initialized) {
			throw new Error('Tree has already been initialized!');
		}

		this._initialized = true;
		this._reposManager = reposManager;
		this._disposables.push(this._reposManager.onDidChangeState(() => {
			this._onDidChangeTreeData.fire();
		}));
		this._disposables.push(...this._reposManager.folderManagers.map(manager => {
			return manager.onDidChangeRepositories(() => {
				this._onDidChangeTreeData.fire();
			});
		}));

		this.initializeCategories();
		this.refresh();
	}

	private async initializeCategories() {
		this._disposables.push(vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.${QUERIES_SETTING}`)) {
				this.refresh();
			}
		}));
	}

	async refresh(node?: TreeNode) {
		return node ? this._onDidChangeTreeData.fire(node) : this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element.getTreeItem();
	}

	private needsRemotes() {
		if (this._reposManager.state === ReposManagerState.NeedsAuthentication) {
			return Promise.resolve([]);
		}

		const remotesSetting = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string[]>(REMOTES_SETTING);
		if (remotesSetting) {
			return Promise.resolve([
				new PRCategoryActionNode(this._view, PRCategoryActionType.NoMatchingRemotes),
				new PRCategoryActionNode(this._view, PRCategoryActionType.ConfigureRemotes)
			]);
		}

		return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.NoRemotes)]);
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!this._reposManager) {
			if (!vscode.workspace.workspaceFolders) {
				return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.NoOpenFolder)]);
			} else {
				return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.NoGitRepositories)]);
			}
		}

		if (this._reposManager.state === ReposManagerState.Initializing) {
			return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.Initializing)]);
		}

		if (this._reposManager.folderManagers.filter(manager => manager.getGitHubRemotes().length > 0).length === 0) {
			return this.needsRemotes();
		}

		if (!element) {
			if (this._childrenDisposables && this._childrenDisposables.length) {
				this._childrenDisposables.forEach(dispose => dispose.dispose());
			}

			let result: TreeNode[];
			if (this._reposManager.folderManagers.length === 1) {
				return WorkspaceFolderNode.getCategoryTreeNodes(this._reposManager.folderManagers[0], this._telemetry, this._view);
			} else {
				result = this._reposManager.folderManagers.map(folderManager => new WorkspaceFolderNode(this._view, folderManager.repository.rootUri, folderManager, this._telemetry));
			}

			this._childrenDisposables = result;
			return Promise.resolve(result);
		}

		if (this._reposManager.folderManagers.filter(manager => manager.repository.state.remotes.length > 0).length === 0) {
			return Promise.resolve([new PRCategoryActionNode(this._view, PRCategoryActionType.Empty)]);
		}

		return element.getChildren();
	}

	async getParent(element: TreeNode): Promise<TreeNode | undefined> {
		return element.getParent();
	}

	dispose() {
		this._disposables.forEach(dispose => dispose.dispose());
	}

}
