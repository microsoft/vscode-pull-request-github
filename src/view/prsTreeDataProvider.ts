/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { REMOTES_SETTING, ReposManagerState } from '../azdo/folderRepositoryManager';
import { RepositoriesManager } from '../azdo/repositoriesManager';
import { ITelemetry } from '../common/telemetry';
import { SETTINGS_NAMESPACE, URI_SCHEME_PR } from '../constants';
import { FileViewedDecorationProvider } from './fileViewedDecorationProvider';
import { getInMemPRContentProvider } from './inMemPRContentProvider';
import { DecorationProvider } from './treeDecorationProvider';
import { CategoryTreeNode, PRCategoryActionNode, PRCategoryActionType } from './treeNodes/categoryNode';
import { BaseTreeNode, TreeNode } from './treeNodes/treeNode';
import { WorkspaceFolderNode } from './treeNodes/workspaceFolderNode';

export class PullRequestsTreeDataProvider implements vscode.TreeDataProvider<TreeNode>, BaseTreeNode, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> {
		return this._onDidChange.event;
	}
	private _disposables: vscode.Disposable[];
	private _childrenDisposables: vscode.Disposable[];
	private _view: vscode.TreeView<TreeNode>;
	private _reposManager: RepositoriesManager;
	private _initialized: boolean = false;

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(private _telemetry: ITelemetry) {
		this._disposables = [];
		this._disposables.push(
			vscode.workspace.registerTextDocumentContentProvider(URI_SCHEME_PR, getInMemPRContentProvider()),
		);
		this._disposables.push(vscode.window.registerFileDecorationProvider(DecorationProvider));
		this._disposables.push(vscode.window.registerFileDecorationProvider(FileViewedDecorationProvider));
		this._disposables.push(
			vscode.commands.registerCommand('azdopr.refreshList', _ => {
				this._onDidChangeTreeData.fire();
			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('azdopr.loadMore', (node: CategoryTreeNode) => {
				node.fetchNextPage = true;
				this._onDidChangeTreeData.fire(node);
			}),
		);

		this._view = vscode.window.createTreeView('azdopr:azdo', {
			treeDataProvider: this,
			showCollapseAll: true,
		});

		this._disposables.push(this._view);
		this._childrenDisposables = [];

		this._disposables.push(
			vscode.commands.registerCommand('azdopr.configurePRViewlet', async () => {
				const isLoggedIn = this._reposManager.state === ReposManagerState.RepositoriesLoaded;
				const configuration = await vscode.window.showQuickPick([
					'Configure Project Name...',
					'Configure Organization URL...',
					...(isLoggedIn ? ['Sign out of Azure Devops...'] : []),
				]);

				// eslint-disable-next-line @typescript-eslint/no-var-requires
				const { name, publisher } = require('../../package.json') as { name: string; publisher: string };
				const extensionId = `${publisher}.${name}`;

				switch (configuration) {
					case 'Configure Project Name...':
						return vscode.commands.executeCommand(
							'workbench.action.openSettings',
							`@ext:${extensionId} projectName`,
						);
					case 'Configure Organization URL...':
						return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId} orgUrl`);
					case 'Sign out of Azure Devops...':
						return vscode.commands.executeCommand('azdopr.signout');
					default:
						return;
				}
			}),
		);

		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.fileListLayout`)) {
					this._onDidChangeTreeData.fire();
				}
			}),
		);
	}

	async reveal(element: TreeNode, options?: { select?: boolean; focus?: boolean; expand?: boolean }): Promise<void> {
		return this._view.reveal(element, options);
	}

	initialize(reposManager: RepositoriesManager) {
		if (this._initialized) {
			throw new Error('Tree has already been initialized!');
		}

		this._initialized = true;
		this._reposManager = reposManager;
		this._disposables.push(
			this._reposManager.onDidChangeState(() => {
				this._onDidChangeTreeData.fire();
			}),
		);
		this._disposables.push(
			...this._reposManager.folderManagers.map(manager => {
				return manager.onDidChangeRepositories(() => {
					this._onDidChangeTreeData.fire();
				});
			}),
		);

		this.refresh();
	}

	refresh(node?: TreeNode) {
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
				new PRCategoryActionNode(this, PRCategoryActionType.NoMatchingRemotes),
				new PRCategoryActionNode(this, PRCategoryActionType.ConfigureRemotes),
			]);
		}

		return Promise.resolve([new PRCategoryActionNode(this, PRCategoryActionType.NoRemotes)]);
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!this._reposManager) {
			if (!vscode.workspace.workspaceFolders) {
				return Promise.resolve([new PRCategoryActionNode(this, PRCategoryActionType.NoOpenFolder)]);
			} else {
				return Promise.resolve([new PRCategoryActionNode(this, PRCategoryActionType.NoGitRepositories)]);
			}
		}

		if (this._reposManager.state === ReposManagerState.Initializing) {
			return Promise.resolve([new PRCategoryActionNode(this, PRCategoryActionType.Initializing)]);
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
				return WorkspaceFolderNode.getCategoryTreeNodes(this._reposManager.folderManagers[0], this._telemetry, this);
			} else {
				result = this._reposManager.folderManagers.map(
					folderManager =>
						new WorkspaceFolderNode(this, folderManager.repository.rootUri, folderManager, this._telemetry),
				);
			}

			this._childrenDisposables = result;
			return Promise.resolve(result);
		}

		if (this._reposManager.folderManagers.filter(manager => manager.repository.state.remotes.length > 0).length === 0) {
			return Promise.resolve([new PRCategoryActionNode(this, PRCategoryActionType.Empty)]);
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
