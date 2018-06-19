/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TreeNode } from './TreeNode';
import { PRType, PullRequestModel } from '../github/pullRequestModel';
import { PullRequestGitHelper } from '../common/pullRequestGitHelper';
import { Repository } from '../models/repository';
import { PRNode } from './prNode';

export enum PRGroupActionType {
	Empty,
	More
}

export class PRGroupActionNode extends TreeNode implements vscode.TreeItem {
	public readonly label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public iconPath?: { light: string | vscode.Uri; dark: string | vscode.Uri };
	public type: PRGroupActionType;
	public command?: vscode.Command;

	constructor(type: PRGroupActionType, node?: PRGroupTreeNode) {
		super();
		this.type = type;
		this.collapsibleState = vscode.TreeItemCollapsibleState.None;
		switch (type) {
			case PRGroupActionType.Empty:
				this.label = '0 pull request in this category';
				break;
			case PRGroupActionType.More:
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

export class PRGroupTreeNode extends TreeNode implements vscode.TreeItem {
	public readonly label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public prs: PullRequestModel[];
	public type: PRType;
	public fetchNextPage: boolean = false;

	constructor(
		private repository: Repository,
		type: PRType
	) {
		super();

		this.prs = [];
		this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		this.type = type;
		switch (type) {
			case PRType.All:
				this.label = 'All';
				break;
			case PRType.RequestReview:
				this.label = 'Waiting For My Review';
				break;
			case PRType.ReviewedByMe:
				this.label = 'Reviewed By Me';
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
		if (!this.fetchNextPage) {
			try {
				this.prs = await this.getPRs();
			} catch (e) {
				vscode.window.showErrorMessage(`Fetching pull requests failed: ${e}`);
			}
		} else {
			try {
				this.prs = this.prs.concat(await this.getNextPRs());
			} catch (e) {
				vscode.window.showErrorMessage(`Fetching pull requests failed: ${e}`);
			}

			this.fetchNextPage = false;
		}

		if (this.prs && this.prs.length) {
			const hasMorePages = this.type !== PRType.LocalPullRequest && this.repository.githubRepositories.some(repo => repo.hasMorePages.get(this.type));

			let nodes: TreeNode[] = this.prs.map(prItem => new PRNode(this.repository, prItem));
			if (hasMorePages) {
				nodes.push(new PRGroupActionNode(PRGroupActionType.More, this));
			}

			return nodes;
		} else {
			return [new PRGroupActionNode(PRGroupActionType.Empty)];
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	async getNextPRs(): Promise<PullRequestModel[]> {
		let promises = this.repository.githubRepositories.map(async githubRepository => {
			let remote = githubRepository.remote.remoteName;
			let isRemoteForPR = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this.repository, remote);
			if (isRemoteForPR) {
				return null;
			}
			return await githubRepository.getNextPageOfPullRequests(this.type);
		}).filter(value => value !== null);

		return Promise.all(promises).then(values => {
			return values.reduce((prev, curr) => prev.concat(curr), []);
		});
	}

	async getPRs(): Promise<PullRequestModel[]> {
		if (this.type === PRType.LocalPullRequest) {
			let infos = await PullRequestGitHelper.getLocalBranchesAssociatedWithPullRequest(this.repository);
			let promises = infos.map(async info => {
				let owner = info.owner;
				let prNumber = info.prNumber;
				let githubRepo = this.repository.githubRepositories.find(repo => repo.remote.owner.toLocaleLowerCase() === owner.toLocaleLowerCase());

				if (!githubRepo) {
					return null;
				}

				return await githubRepo.getPullRequest(prNumber);
			}).filter(value => value !== null);

			return Promise.all(promises);
		}

		let promises = this.repository.githubRepositories.map(async githubRepository => {
			let remote = githubRepository.remote.remoteName;
			let isRemoteForPR = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this.repository, remote);
			if (isRemoteForPR) {
				return null;
			}
			return await githubRepository.getPullRequests(this.type);
		}).filter(value => value !== null);

		return Promise.all(promises).then(values => {
			return values.reduce((prev, curr) => prev.concat(curr), []);
		});
	}
}
