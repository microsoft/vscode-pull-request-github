/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthenticationError } from '../../common/authentication';
import { PR_SETTINGS_NAMESPACE, QUERIES } from '../../common/settingKeys';
import { ITelemetry } from '../../common/telemetry';
import { formatError } from '../../common/utils';
import { FolderRepositoryManager, ItemsResponseResult } from '../../github/folderRepositoryManager';
import { PRType } from '../../github/interface';
import { NotificationProvider } from '../../github/notifications';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PrsTreeModel } from '../prsTreeModel';
import { PRNode } from './pullRequestNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export enum PRCategoryActionType {
	Empty,
	More,
	TryOtherRemotes,
	Login,
	LoginEnterprise,
	NoRemotes,
	NoMatchingRemotes,
	ConfigureRemotes,
	Initializing,
}

export class PRCategoryActionNode extends TreeNode implements vscode.TreeItem {
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };
	public type: PRCategoryActionType;
	public command?: vscode.Command;

	constructor(parent: TreeNodeParent, type: PRCategoryActionType, node?: CategoryTreeNode) {
		super();
		this.parent = parent;
		this.type = type;
		this.collapsibleState = vscode.TreeItemCollapsibleState.None;
		switch (type) {
			case PRCategoryActionType.Empty:
				this.label = vscode.l10n.t('0 pull requests in this category');
				break;
			case PRCategoryActionType.More:
				this.label = vscode.l10n.t('Load more');
				this.command = {
					title: vscode.l10n.t('Load more'),
					command: 'pr.loadMore',
					arguments: [node],
				};
				break;
			case PRCategoryActionType.TryOtherRemotes:
				this.label = vscode.l10n.t('Continue fetching from other remotes');
				this.command = {
					title: vscode.l10n.t('Load more'),
					command: 'pr.loadMore',
					arguments: [node],
				};
				break;
			case PRCategoryActionType.Login:
				this.label = vscode.l10n.t('Sign in');
				this.command = {
					title: vscode.l10n.t('Sign in'),
					command: 'pr.signinAndRefreshList',
					arguments: [],
				};
				break;
			case PRCategoryActionType.LoginEnterprise:
				this.label = vscode.l10n.t('Sign in with GitHub Enterprise...');
				this.command = {
					title: 'Sign in',
					command: 'pr.signinAndRefreshList',
					arguments: [],
				};
				break;
			case PRCategoryActionType.NoRemotes:
				this.label = vscode.l10n.t('No GitHub repositories found.');
				break;
			case PRCategoryActionType.NoMatchingRemotes:
				this.label = vscode.l10n.t('No remotes match the current setting.');
				break;
			case PRCategoryActionType.ConfigureRemotes:
				this.label = vscode.l10n.t('Configure remotes...');
				this.command = {
					title: vscode.l10n.t('Configure remotes'),
					command: 'pr.configureRemotes',
					arguments: [],
				};
				break;
			case PRCategoryActionType.Initializing:
				this.label = vscode.l10n.t('Loading...');
				break;
			default:
				break;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}

interface PageInformation {
	pullRequestPage: number;
	hasMorePages: boolean;
}

export class CategoryTreeNode extends TreeNode implements vscode.TreeItem {
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public prs: PullRequestModel[];
	public fetchNextPage: boolean = false;
	public repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();
	public contextValue: string;
	public readonly id: string = '';

	constructor(
		public parent: TreeNodeParent,
		private _folderRepoManager: FolderRepositoryManager,
		private _telemetry: ITelemetry,
		private _type: PRType,
		private _notificationProvider: NotificationProvider,
		expandedQueries: Set<string>,
		private _prsTreeModel: PrsTreeModel,
		_categoryLabel?: string,
		private _categoryQuery?: string,
	) {
		super();

		this.prs = [];

		switch (_type) {
			case PRType.All:
				this.label = vscode.l10n.t('All Open');
				break;
			case PRType.Query:
				this.label = _categoryLabel!;
				break;
			case PRType.LocalPullRequest:
				this.label = vscode.l10n.t('Local Pull Request Branches');
				break;
			default:
				this.label = '';
				break;
		}

		this.id = parent instanceof TreeNode ? `${parent.label}/${this.label}` : this.label;

		if ((expandedQueries.size === 0) && (_type === PRType.All)) {
			this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		} else {
			this.collapsibleState =
				expandedQueries.has(this.id)
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.Collapsed;
		}

		if (this._categoryQuery) {
			this.contextValue = 'query';
		}
	}

	async editQuery() {
		const config = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE);
		const inspect = config.inspect<{ label: string; query: string }[]>(QUERIES);
		let command: string;
		if (inspect?.workspaceValue) {
			command = 'workbench.action.openWorkspaceSettingsFile';
		} else {
			const value = config.get<{ label: string; query: string }[]>(QUERIES);
			if (inspect?.defaultValue && JSON.stringify(inspect?.defaultValue) === JSON.stringify(value)) {
				config.update(QUERIES, inspect.defaultValue, vscode.ConfigurationTarget.Global);
			}
			command = 'workbench.action.openSettingsJson';
		}
		await vscode.commands.executeCommand(command);
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const text = editor.document.getText();
			const search = text.search(this.label!);
			if (search >= 0) {
				const position = editor.document.positionAt(search);
				editor.revealRange(new vscode.Range(position, position));
				editor.selection = new vscode.Selection(position, position);
			}
		}
	}

	async getChildren(): Promise<TreeNode[]> {
		if (this.childrenDisposables && this.childrenDisposables.length) {
			this.childrenDisposables.forEach(dp => dp.dispose());
			this.childrenDisposables = [];
		}

		let hasMorePages = false;
		let hasUnsearchedRepositories = false;
		let needLogin = false;
		if (this._type === PRType.LocalPullRequest) {
			try {
				this.prs = await this._prsTreeModel.getLocalPullRequests(this._folderRepoManager);
			} catch (e) {
				vscode.window.showErrorMessage(vscode.l10n.t('Fetching local pull requests failed: {0}', formatError(e)));
				needLogin = e instanceof AuthenticationError;
			}
		} else {
			try {
				let response: ItemsResponseResult<PullRequestModel>;
				switch (this._type) {
					case PRType.All:
						response = await this._prsTreeModel.getAllPullRequests(this._folderRepoManager, this.fetchNextPage);
						break;
					case PRType.Query:
						response = await this._prsTreeModel.getPullRequestsForQuery(this._folderRepoManager, this.fetchNextPage, this._categoryQuery!);
						break;
				}
				if (!this.fetchNextPage) {
					this.prs = response.items;
				} else {
					this.prs = this.prs.concat(response.items);
				}
				hasMorePages = response.hasMorePages;
				hasUnsearchedRepositories = response.hasUnsearchedRepositories;
			} catch (e) {
				vscode.window.showErrorMessage(vscode.l10n.t('Fetching pull requests failed: {0}', formatError(e)));
				needLogin = e instanceof AuthenticationError;
			} finally {
				this.fetchNextPage = false;
			}
		}

		if (this.prs && this.prs.length) {
			const nodes: TreeNode[] = this.prs.map(
				prItem => new PRNode(this, this._folderRepoManager, prItem, this._type === PRType.LocalPullRequest, this._notificationProvider),
			);
			if (hasMorePages) {
				nodes.push(new PRCategoryActionNode(this, PRCategoryActionType.More, this));
			} else if (hasUnsearchedRepositories) {
				nodes.push(new PRCategoryActionNode(this, PRCategoryActionType.TryOtherRemotes, this));
			}

			this.childrenDisposables = nodes;
			return nodes;
		} else {
			const category = needLogin ? PRCategoryActionType.Login : PRCategoryActionType.Empty;
			const result = [new PRCategoryActionNode(this, category)];

			this.childrenDisposables = result;
			return result;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}
