/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../../common/repository';
import { IPullRequestManager, IPullRequestModel, PRType } from '../../github/interface';
import { PRNode } from './pullRequestNode';
import { TreeNode } from './treeNode';
import { formatError } from '../../common/utils';

export enum PRCategoryActionType {
	Empty,
	More
}

export class PRCategoryActionNode extends TreeNode implements vscode.TreeItem {
	public readonly label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };
	public type: PRCategoryActionType;
	public command?: vscode.Command;

	constructor(type: PRCategoryActionType, node?: CategoryTreeNode) {
		super();
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
					command: 'pr.loadMore',
					arguments: [
						node
					]
				}
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
	public readonly label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public prs: IPullRequestModel[];
	public fetchNextPage: boolean = false;
	public repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();


	constructor(
		private _prManager: IPullRequestManager,
		private _repository: Repository,
		private _type: PRType
	) {
		super();

		this.prs = [];
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		switch (_type) {
			case PRType.All:
				this.label = 'All';
				break;
			case PRType.RequestReview:
				this.label = 'Waiting For My Review';
				break;
			case PRType.AssignedToMe:
				this.label = 'Assigned To Me';
				break;
			case PRType.Mine:
				this.label = 'Created By Me';
				break;
			case PRType.LocalPullRequest:
				this.label = 'Local Pull Request Branches';
				break;
			default:
				break;
		}
	}

	async getChildren(): Promise<TreeNode[]> {
		let hasMorePages = false;
		if (this._type === PRType.LocalPullRequest) {
			try {
				this.prs = await this._prManager.getLocalPullRequests();
			} catch (e) {
				vscode.window.showErrorMessage(`Fetching local pull requests failed: ${formatError(e)}`);
			}
		} else {
			if (!this.fetchNextPage) {
				try {
					let ret = await this._prManager.getPullRequests(this._type, { fetchNextPage: false });
					this.prs = ret[0];
					hasMorePages = ret[1];
				} catch (e) {
					vscode.window.showErrorMessage(`Fetching pull requests failed: ${formatError(e)}`);
				}
			} else {
				try {
					let ret = await this._prManager.getPullRequests(this._type, { fetchNextPage: true});
					this.prs = this.prs.concat(ret[0]);
					hasMorePages = ret[1];
				} catch (e) {
					vscode.window.showErrorMessage(`Fetching pull requests failed: ${formatError(e)}`);
				}

				this.fetchNextPage = false;
			}
		}

		if (this.prs && this.prs.length) {
			let nodes: TreeNode[] = this.prs.map(prItem => new PRNode(this._prManager, this._repository, prItem, this._type === PRType.LocalPullRequest));
			if (hasMorePages) {
				nodes.push(new PRCategoryActionNode(PRCategoryActionType.More, this));
			}

			return nodes;
		} else {
			return [new PRCategoryActionNode(PRCategoryActionType.Empty)];
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}
}
