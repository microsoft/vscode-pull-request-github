/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Remote } from "../models/remote";
import { PRType, PullRequestModel } from "./pullRequestModel";
import Logger from "../logger";
import * as Octokit from '@octokit/rest';

export class GitHubRepository {
	private pullRequestPage: Map<PRType, number> = new Map<PRType, number>();
	public hasMorePages: Map<PRType, boolean> = new Map<PRType, boolean>();

	constructor(public readonly remote: Remote, public readonly octokit: Octokit) {
		for (let prtype in PRType) {
			this.pullRequestPage.set(Number(prtype), 1);
		}
	}

	async getPullRequests(prType: PRType): Promise<PullRequestModel[]> {
		return prType === PRType.All ? this.getAllPullRequests() : this.getPullRequestsForCategory(prType);
	}

	private async getAllPullRequests(): Promise<PullRequestModel[]> {
		try {
			const result = await this.octokit.pullRequests.getAll({
				owner: this.remote.owner,
				repo: this.remote.repositoryName,
				page: this.pullRequestPage.get(PRType.All)
			});

			const hasMorePages = result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
			this.hasMorePages.set(PRType.All, hasMorePages);

			return result.data.map(item => {
				if (!item.head.repo) {
					Logger.appendLine('GitHubRepository> The remote branch for this PR was already deleted.');
					return null;
				}

				return new PullRequestModel(this.octokit, this.remote, item);
			}).filter(item => item !== null);
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Fetching all pull requests failed: ${e}`);
			throw e;
		}
	}

	private async getPullRequestsForCategory(prType: PRType): Promise<PullRequestModel[]> {
		try {
			const user = await this.octokit.users.get({});
			const { data, headers } = await this.octokit.search.issues({
				q: this.getPRFetchQuery(this.remote.owner, this.remote.repositoryName, user.data.login, prType)
			});
			let promises = [];
			data.items.forEach(item => {
				promises.push(new Promise(async (resolve, reject) => {
					let prData = await this.octokit.pullRequests.get({
						owner: this.remote.owner,
						repo: this.remote.repositoryName,
						number: item.number
					});
					resolve(prData);
				}));
			});

			const hasMorePages = headers.link && headers.link.indexOf('rel="next"') > -1;
			this.hasMorePages.set(PRType.All, hasMorePages);

			return Promise.all(promises).then(values => {
				return values.map(item => {
					if (!item.data.head.repo) {
						Logger.appendLine('GitHubRepository> The remote branch for this PR was already deleted.');
						return null;
					}

					return new PullRequestModel(this.octokit, this.remote, item.data);
				}).filter(item => item !== null);
			});
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Fetching pull requests failed: ${e}`);
			throw e;
		}
	}

	getNextPageOfPullRequests(prType: PRType): Promise<PullRequestModel[]> {
		const currentPage = this.pullRequestPage.get(prType);
		this.pullRequestPage.set(prType, currentPage + 1);
		return this.getPullRequests(prType);
	}

	async getPullRequest(id: number): Promise<PullRequestModel> {
		try {
			let { data } = await this.octokit.pullRequests.get({
				owner: this.remote.owner,
				repo: this.remote.repositoryName,
				number: id
			});

			if (!data.head.repo) {
				Logger.appendLine('GitHubRepository> The remote branch for this PR was already deleted.');
				return null;
			}

			return new PullRequestModel(this.octokit, this.remote, data);
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch PR: ${e}`);
			return null;
		}
	}

	private getPRFetchQuery(owner: string, repo: string, user: string, type: PRType) {
		let filter = '';
		switch (type) {
			case PRType.RequestReview:
				filter = `review-requested:${user}`;
				break;
			case PRType.ReviewedByMe:
				filter = `reviewed-by:${user}`;
				break;
			case PRType.Mine:
				filter = `author:${user}`;
				break;
			default:
				break;
		}

		return `is:open ${filter} type:pr repo:${owner}/${repo}`;
	}
}