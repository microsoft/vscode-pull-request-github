/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../../azdo/folderRepositoryManager';
import { PRType } from '../../azdo/interface';
import { PullRequestModel } from '../../azdo/pullRequestModel';
import { AuthenticationError } from '../../common/authentication';
import { ITelemetry } from '../../common/telemetry';
import { formatError } from '../../common/utils';
import { PRNode } from './pullRequestNode';
import { TreeNode, TreeNodeParent } from './treeNode';

export enum PRCategoryActionType {
	Empty,
	More,
	TryOtherRemotes,
	Login,
	NoRemotes,
	NoGitRepositories,
	NoOpenFolder,
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
				this.label = '0 pull requests in this category';
				break;
			case PRCategoryActionType.More:
				this.label = 'Load more';
				this.command = {
					title: 'Load more',
					command: 'azdopr.loadMore',
					arguments: [node],
				};
				break;
			case PRCategoryActionType.TryOtherRemotes:
				this.label = 'Continue fetching from other remotes';
				this.command = {
					title: 'Load more',
					command: 'azdopr.loadMore',
					arguments: [node],
				};
				break;
			case PRCategoryActionType.Login:
				this.label = 'Sign in';
				this.command = {
					title: 'Sign in',
					command: 'azdopr.signinAndRefreshList',
					arguments: [],
				};
				break;
			case PRCategoryActionType.NoRemotes:
				this.label = 'No GitHub repositories found.';
				break;
			case PRCategoryActionType.NoGitRepositories:
				this.label = 'No git repositories found.';
				break;
			case PRCategoryActionType.NoOpenFolder:
				this.label = 'You have not yet opened a folder.';
				break;
			case PRCategoryActionType.NoMatchingRemotes:
				this.label = 'No remotes match the current setting.';
				break;
			case PRCategoryActionType.ConfigureRemotes:
				this.label = 'Configure remotes...';
				this.command = {
					title: 'Configure remotes',
					command: 'azdopr.configureRemotes',
					arguments: [],
				};
				break;
			case PRCategoryActionType.Initializing:
				this.label = 'Loading...';
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

	constructor(
		public parent: TreeNodeParent,
		private _folderRepoManager: FolderRepositoryManager,
		private _telemetry: ITelemetry,
		private _type: PRType,
		_categoryLabel?: string,
		private _categoryQuery?: string,
	) {
		super();

		this.prs = [];
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		switch (_type) {
			case PRType.AllActive:
				this.label = 'All Active';
				break;
			case PRType.Query:
				this.label = _categoryLabel!;
				break;
			case PRType.LocalPullRequest:
				this.label = 'Local Pull Request Branches';
				break;
			case PRType.AssignedToMe:
				this.label = 'Assigned To Me';
				break;
			case PRType.CreatedByMe:
				this.label = 'Created By Me';
				break;
			default:
				break;
		}
	}

	async getChildren(): Promise<TreeNode[]> {
		let hasMorePages = false;
		let hasUnsearchedRepositories = false;
		let needLogin = false;
		if (this._type === PRType.LocalPullRequest) {
			try {
				this.prs = await this._folderRepoManager.getLocalPullRequests();
				/* __GDPR__
					"pr.expand.local" : {}
				*/
				this._telemetry.sendTelemetryEvent('pr.expand.local');
			} catch (e) {
				vscode.window.showErrorMessage(`Fetching local pull requests failed: ${formatError(e)}`);
				needLogin = e instanceof AuthenticationError;
			}
		} else {
			if (!this.fetchNextPage) {
				try {
					const response = await this._folderRepoManager.getPullRequests(
						this._type,
						{ fetchNextPage: false },
						this._categoryQuery,
					);
					this.prs = response.items;
					hasMorePages = response.hasMorePages;
					hasUnsearchedRepositories = response.hasUnsearchedRepositories;

					switch (this._type) {
						case PRType.AllActive:
							/* __GDPR__
								"pr.expand.all" : {}
							*/
							this._telemetry.sendTelemetryEvent('pr.expand.all');
							break;
						case PRType.CreatedByMe:
							/* __GDPR__
								"pr.expand.query" : {}
							*/
							this._telemetry.sendTelemetryEvent('pr.expand.createdByMe');
							break;
						case PRType.AssignedToMe:
							/* __GDPR__
								"pr.expand.query" : {}
							*/
							this._telemetry.sendTelemetryEvent('pr.expand.query');
							break;
					}
				} catch (e) {
					vscode.window.showErrorMessage(`Fetching pull requests failed: ${formatError(e)}`);
					needLogin = e instanceof AuthenticationError;
				}
			} else {
				try {
					const response = await this._folderRepoManager.getPullRequests(
						this._type,
						{ fetchNextPage: true },
						this._categoryQuery,
					);
					this.prs = this.prs.concat(response.items);
					hasMorePages = response.hasMorePages;
					hasUnsearchedRepositories = response.hasUnsearchedRepositories;
				} catch (e) {
					vscode.window.showErrorMessage(`Fetching pull requests failed: ${formatError(e)}`);
					needLogin = e instanceof AuthenticationError;
				}

				this.fetchNextPage = false;
			}
		}

		if (this.prs && this.prs.length) {
			const nodes: TreeNode[] = this.prs.map(
				prItem => new PRNode(this, this._folderRepoManager, prItem, this._type === PRType.LocalPullRequest),
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
