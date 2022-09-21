/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import { FILE_LIST_LAYOUT } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { EXTENSION_ID } from '../constants';
import { CredentialStore } from '../github/credentials';
import { REMOTES_SETTING, ReposManagerState, SETTINGS_NAMESPACE } from '../github/folderRepositoryManager';
import { NotificationProvider } from '../github/notifications';
import { RepositoriesManager } from '../github/repositoriesManager';
import { findDotComAndEnterpriseRemotes } from '../github/utils';
import { ReviewModel } from './reviewModel';
import { DecorationProvider } from './treeDecorationProvider';
import { CategoryTreeNode, PRCategoryActionNode, PRCategoryActionType } from './treeNodes/categoryNode';
import { InMemFileChangeNode } from './treeNodes/fileChangeNode';
import { BaseTreeNode, TreeNode } from './treeNodes/treeNode';
import { QUERIES_SETTING, WorkspaceFolderNode } from './treeNodes/workspaceFolderNode';

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
	private _reposManager: RepositoriesManager | undefined;
	private _initialized: boolean = false;
	public notificationProvider: NotificationProvider;

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	constructor(private _telemetry: ITelemetry) {
		this._disposables = [];
		this._disposables.push(vscode.window.registerFileDecorationProvider(DecorationProvider));
		this._disposables.push(
			vscode.commands.registerCommand('pr.refreshList', _ => {
				this._onDidChangeTreeData.fire();
			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.loadMore', (node: CategoryTreeNode) => {
				node.fetchNextPage = true;
				this._onDidChangeTreeData.fire(node);
			}),
		);

		this._view = vscode.window.createTreeView('pr:github', {
			treeDataProvider: this,
			showCollapseAll: true,
		});

		this._disposables.push(this._view);
		this._childrenDisposables = [];

		this._disposables.push(
			vscode.commands.registerCommand('pr.configurePRViewlet', async () => {
				const configuration = await vscode.window.showQuickPick([
					'Configure Remotes...',
					'Configure Queries...'
				]);

				switch (configuration) {
					case 'Configure Queries...':
						return vscode.commands.executeCommand(
							'workbench.action.openSettings',
							`@ext:${EXTENSION_ID} queries`,
						);
					case 'Configure Remotes...':
						return vscode.commands.executeCommand(
							'workbench.action.openSettings',
							`@ext:${EXTENSION_ID} remotes`,
						);
					default:
						return;
				}
			}),
		);

		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.${FILE_LIST_LAYOUT}`)) {
					this._onDidChangeTreeData.fire();
				}
			}),
		);

		this._disposables.push(this._view.onDidChangeCheckboxState(checkboxUpdates => {
			checkboxUpdates.items.forEach(checkboxUpdate => {
				const node = checkboxUpdate[0];
				const newState = checkboxUpdate[1];
				node.updateCheckbox(newState);
			});
		}));
	}

	async reveal(element: TreeNode, options?: { select?: boolean, focus?: boolean, expand?: boolean }): Promise<void> {
		return this._view.reveal(element, options);
	}

	initialize(reposManager: RepositoriesManager, reviewModels: ReviewModel[], credentialStore: CredentialStore) {
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
		this._disposables.push(
			...reviewModels.map(model => {
				return model.onDidChangeLocalFileChanges(_ => { this.refresh(); });
			}),
		);

		this.notificationProvider = new NotificationProvider(this, credentialStore, this._reposManager);
		this._disposables.push(this.notificationProvider);

		this.initializeCategories();
		this.refresh();
	}

	private async initializeCategories() {
		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration(async e => {
				if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.${QUERIES_SETTING}`)) {
					this.refresh();
				}
			}),
		);
	}

	refresh(node?: TreeNode): void {
		return node ? this._onDidChangeTreeData.fire(node) : this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element.getTreeItem();
	}

	async resolveTreeItem(item: vscode.TreeItem, element: TreeNode): Promise<vscode.TreeItem> {
		if (element instanceof InMemFileChangeNode) {
			await element.resolve();
		}
		return element;
	}

	private async needsRemotes() {
		if (this._reposManager?.state === ReposManagerState.NeedsAuthentication) {
			return [];
		}

		const remotesSetting = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string[]>(REMOTES_SETTING);
		let actions: PRCategoryActionNode[];
		if (remotesSetting) {
			actions = [
				new PRCategoryActionNode(this, PRCategoryActionType.NoMatchingRemotes),
				new PRCategoryActionNode(this, PRCategoryActionType.ConfigureRemotes),

			];
		} else {
			actions = [new PRCategoryActionNode(this, PRCategoryActionType.NoRemotes)];
		}

		const { enterpriseRemotes } = this._reposManager ? await findDotComAndEnterpriseRemotes(this._reposManager?.folderManagers) : { enterpriseRemotes: [] };
		if ((enterpriseRemotes.length > 0) && !this._reposManager?.credentialStore.isAuthenticated(AuthProvider['github-enterprise'])) {
			actions.push(new PRCategoryActionNode(this, PRCategoryActionType.LoginEnterprise));
		}

		return actions;
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!this._reposManager?.folderManagers.length) {
			return [];
		}

		if (this._reposManager.state === ReposManagerState.Initializing) {
			return Promise.resolve([new PRCategoryActionNode(this, PRCategoryActionType.Initializing)]);
		}

		const remotes = await Promise.all(this._reposManager.folderManagers.map(manager => manager.getGitHubRemotes()));
		if ((this._reposManager.folderManagers.filter((_manager, index) => remotes[index].length > 0).length === 0)) {
			return this.needsRemotes();
		}

		if (!element) {
			if (this._childrenDisposables && this._childrenDisposables.length) {
				this._childrenDisposables.forEach(dispose => dispose.dispose());
			}

			let result: TreeNode[];
			if (this._reposManager.folderManagers.length === 1) {
				result = WorkspaceFolderNode.getCategoryTreeNodes(
					this._reposManager.folderManagers[0],
					this._telemetry,
					this,
					this.notificationProvider
				);
			} else {
				result = this._reposManager.folderManagers.map(
					folderManager =>
						new WorkspaceFolderNode(
							this,
							folderManager.repository.rootUri,
							folderManager,
							this._telemetry,
							this.notificationProvider
						),
				);
			}

			this._childrenDisposables = result;
			return Promise.resolve(result);
		}

		if (
			this._reposManager.folderManagers.filter(manager => manager.repository.state.remotes.length > 0).length ===
			0
		) {
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
