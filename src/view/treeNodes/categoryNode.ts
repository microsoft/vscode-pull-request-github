/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthenticationError } from '../../common/authentication';
import { ITelemetry } from '../../common/telemetry';
import { COPILOT_QUERY, Schemes } from '../../common/uri';
import { formatError } from '../../common/utils';
import { isCopilotQuery } from '../../github/copilotPrWatcher';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { FolderRepositoryManager, ItemsResponseResult } from '../../github/folderRepositoryManager';
import { PRType } from '../../github/interface';
import { NotificationProvider } from '../../github/notifications';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PrsTreeModel } from '../prsTreeModel';
import { PRNode } from './pullRequestNode';
import { TreeNode, TreeNodeParent } from './treeNode';
import { IQueryInfo } from './workspaceFolderNode';

export enum PRCategoryActionType {
	Empty,
	More,
	TryOtherRemotes,
	Login,
	LoginEnterprise,
	NoRemotes,
	NoMatchingRemotes,
	ConfigureRemotes,
}

export class PRCategoryActionNode extends TreeNode implements vscode.TreeItem {
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };
	public type: PRCategoryActionType;
	public command?: vscode.Command;

	constructor(parent: TreeNodeParent, type: PRCategoryActionType, node?: CategoryTreeNode) {
		super(parent);
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

export namespace DefaultQueries {
	export namespace Queries {
		export const LOCAL = 'Local Pull Request Branches';
		export const ALL = 'All Open';
	}
	export namespace Values {
		export const DEFAULT = 'default';
	}
}

export function isLocalQuery(queryInfo: IQueryInfo): boolean {
	return queryInfo.label === DefaultQueries.Queries.LOCAL && queryInfo.query === DefaultQueries.Values.DEFAULT;
}

export function isAllQuery(queryInfo: IQueryInfo): boolean {
	return queryInfo.label === DefaultQueries.Queries.ALL && queryInfo.query === DefaultQueries.Values.DEFAULT;
}

export class CategoryTreeNode extends TreeNode implements vscode.TreeItem {
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public prs: Map<number, PullRequestModel>;
	public fetchNextPage: boolean = false;
	public repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();
	public contextValue: string;
	public resourceUri: vscode.Uri;

	constructor(
		parent: TreeNodeParent,
		readonly folderRepoManager: FolderRepositoryManager,
		private _telemetry: ITelemetry,
		public readonly type: PRType,
		private _notificationProvider: NotificationProvider,
		private _prsTreeModel: PrsTreeModel,
		private _copilotManager: CopilotRemoteAgentManager,
		_categoryLabel?: string,
		private _categoryQuery?: string,
	) {
		super(parent);

		this.prs = new Map();

		const hasCopilotChanges = _categoryQuery && isCopilotQuery(_categoryQuery) && this._copilotManager.notifications.size > 0;

		switch (this.type) {
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

		this.id = parent instanceof TreeNode ? `${parent.id ?? parent.label}/${this.label}` : this.label;

		this.resourceUri = vscode.Uri.parse(Schemes.PRQuery);

		if (hasCopilotChanges) {
			this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
			this.resourceUri = COPILOT_QUERY;
		} else if ((this._prsTreeModel.expandedQueries === undefined) && (this.type === PRType.All)) {
			this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		} else {
			this.collapsibleState =
				this._prsTreeModel.expandedQueries?.has(this.id)
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.Collapsed;
		}

		if (this._categoryQuery) {
			this.contextValue = 'query';
		}
	}

	public async expandPullRequest(pullRequest: PullRequestModel, retry: boolean = true): Promise<boolean> {
		if (!this.children && retry) {
			await this.getChildren();
			retry = false;
		}
		if (this.children) {
			for (const child of this.children) {
				if (child instanceof PRNode) {
					if (child.pullRequestModel.equals(pullRequest)) {
						this.reveal(child, { expand: true, select: true });
						return true;
					}
				}
			}
			// If we didn't find the PR, we might need to re-run the query
			if (retry) {
				await this.getChildren();
				return await this.expandPullRequest(pullRequest, false);
			}
		}
		return false;
	}

	override async getChildren(shouldDispose: boolean = true): Promise<TreeNode[]> {
		await super.getChildren(shouldDispose);
		if (!shouldDispose && this.children) {
			return this.children;
		}
		const isFirstLoad = !this._firstLoad;
		if (isFirstLoad) {
			this._firstLoad = this.doGetChildren();
			if (!this._prsTreeModel.hasLoaded) {
				this._firstLoad.then(() => this.refresh(this));
				return [];
			}
		}
		return isFirstLoad ? this._firstLoad! : this.doGetChildren();
	}

	private _firstLoad: Promise<TreeNode[]> | undefined;
	private async doGetChildren(): Promise<TreeNode[]> {
		let hasMorePages = false;
		let hasUnsearchedRepositories = false;
		let needLogin = false;
		const fetchNextPage = this.fetchNextPage;
		this.fetchNextPage = false;
		if (this.type === PRType.LocalPullRequest) {
			try {
				this.prs.clear();
				(await this._prsTreeModel.getLocalPullRequests(this.folderRepoManager)).items.forEach(item => this.prs.set(item.id, item));
			} catch (e) {
				vscode.window.showErrorMessage(vscode.l10n.t('Fetching local pull requests failed: {0}', formatError(e)));
				needLogin = e instanceof AuthenticationError;
			}
		} else {
			try {
				let response: ItemsResponseResult<PullRequestModel>;
				switch (this.type) {
					case PRType.All:
						response = await this._prsTreeModel.getAllPullRequests(this.folderRepoManager, fetchNextPage);
						break;
					case PRType.Query:
						response = await this._prsTreeModel.getPullRequestsForQuery(this.folderRepoManager, fetchNextPage, this._categoryQuery!);
						break;
				}
				if (!fetchNextPage) {
					this.prs.clear();
				}
				response.items.forEach(item => this.prs.set(item.id, item));
				hasMorePages = response.hasMorePages;
				hasUnsearchedRepositories = response.hasUnsearchedRepositories;
			} catch (e) {
				const error = formatError(e);
				const actions: string[] = [];
				if (error.includes('Bad credentials')) {
					actions.push(vscode.l10n.t('Login again'));
				}
				vscode.window.showErrorMessage(vscode.l10n.t('Fetching pull requests failed: {0}', formatError(e)), ...actions).then(action => {
					if (action && action === actions[0]) {
						this.folderRepoManager.credentialStore.recreate(vscode.l10n.t('Your login session is no longer valid.'));
					}
				});
				needLogin = e instanceof AuthenticationError;
			}
		}

		if (this.prs.size > 0) {
			const nodes: (PRNode | PRCategoryActionNode)[] = Array.from(this.prs.values()).map(
				prItem => new PRNode(this, this.folderRepoManager, prItem, this.type === PRType.LocalPullRequest, this._notificationProvider),
			);
			if (hasMorePages) {
				nodes.push(new PRCategoryActionNode(this, PRCategoryActionType.More, this));
			} else if (hasUnsearchedRepositories) {
				nodes.push(new PRCategoryActionNode(this, PRCategoryActionType.TryOtherRemotes, this));
			}

			this.children = nodes;
			return nodes;
		} else {
			const category = needLogin ? PRCategoryActionType.Login : PRCategoryActionType.Empty;
			const result = [new PRCategoryActionNode(this, category)];

			this.children = result;
			return result;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}
