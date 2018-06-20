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
import { PULL_REQUEST_PAGE_SIZE } from '../github/githubRepository';

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
				this.label = '0 pull requests in this category';
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

interface PageInformation {
	pullRequestPage: number;
	hasMorePages: boolean;
}

export class PRGroupTreeNode extends TreeNode implements vscode.TreeItem {
	public readonly label: string;
	public collapsibleState: vscode.TreeItemCollapsibleState;
	public prs: PullRequestModel[];
	public type: PRType;
	public fetchNextPage: boolean = false;
	public repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();

	constructor(
		private repository: Repository,
		type: PRType
	) {
		super();

		for (let repository of this.repository.githubRepositories) {
			this.repositoryPageInformation.set(repository.remote.url.toString(), {
				pullRequestPage: 1,
				hasMorePages: null
			});
		}

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
				this.prs = await this.getPRs();
			} catch (e) {
				vscode.window.showErrorMessage(`Fetching pull requests failed: ${e}`);
			}
		} else {
			try {
				this.prs = this.prs.concat(await this.getPRs());
			} catch (e) {
				vscode.window.showErrorMessage(`Fetching pull requests failed: ${e}`);
			}

			this.fetchNextPage = false;
		}

		if (this.prs && this.prs.length) {
			const hasMorePages = this.type !== PRType.LocalPullRequest && this.mayHaveMorePages();

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

		let pullRequests: PullRequestModel[] = [];
		let numPullRequests = 0;

		// Limit the number of pull requests that are fetched to less than twice the page size
		const githubRepositories = this.repository.githubRepositories.filter(repo => this.repositoryPageInformation.get(repo.remote.url.toString()).hasMorePages !== false);
		for (let i = 0; i < githubRepositories.length; i++) {
			if (numPullRequests >= PULL_REQUEST_PAGE_SIZE) {
				break;
			}

			const githubRepository = githubRepositories[i];
			const remote = githubRepository.remote.remoteName;
			const isRemoteForPR = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this.repository, remote);
			if (!isRemoteForPR) {
				const pageInformation = this.repositoryPageInformation.get(githubRepository.remote.url.toString());
				while (numPullRequests < PULL_REQUEST_PAGE_SIZE && pageInformation.hasMorePages !== false) {
					const pullRequestData = await githubRepository.getPullRequests(this.type, pageInformation.pullRequestPage);
					numPullRequests += pullRequestData.pullRequests.length;
					pullRequests = pullRequests.concat(...pullRequestData.pullRequests);

					pageInformation.hasMorePages = pullRequestData.hasMorePages;
					pageInformation.pullRequestPage++;;
				}
			}
		}

		return pullRequests;
	}
}
