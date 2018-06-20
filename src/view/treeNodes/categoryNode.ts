/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../../common/repository';
import { Resource } from '../../common/resources';
import { IPullRequestManager, IPullRequestModel, PRType } from '../../github/interface';
import { PRNode } from './pullRequestNode';
import { TreeNode } from './treeNode';
import { PULL_REQUEST_PAGE_SIZE } from '../github/githubRepository';

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
				this.label = '0 pull request in this category';
				break;
			case PRCategoryActionType.More:
				this.label = 'Load more';
				this.iconPath = {
					light: Resource.icons.light.fold,
					dark: Resource.icons.dark.fold
				};
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

		for (let repository of this._repository.githubRepositories) {
			this.repositoryPageInformation.set(repository.remote.url.toString(), {
				pullRequestPage: 1,
				hasMorePages: null
			});
		}

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

	mayHaveMorePages(): boolean {
		return this.repository.githubRepositories.some(repo =>  this.repositoryPageInformation.get(repo.remote.url.toString()).hasMorePages !== false);
	}

	async getChildren(): Promise<TreeNode[]> {
		if (!this.fetchNextPage) {
			try {
				this.prs = await this._prManager.getPullRequests(this._type);
			} catch (e) {
				vscode.window.showErrorMessage(`Fetching pull requests failed: ${e}`);
			}
		} else {
			try {
				this.prs = this.prs.concat(await this._prManager.getPullRequests(this._type));
			} catch (e) {
				vscode.window.showErrorMessage(`Fetching pull requests failed: ${e}`);
			}

			this.fetchNextPage = false;
		}

		if (this.prs && this.prs.length) {
			const hasMorePages = this._type !== PRType.LocalPullRequest && this.mayHaveMorePages();

			let nodes: TreeNode[] = this.prs.map(prItem => new PRNode(this._prManager, this._repository, prItem));
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
