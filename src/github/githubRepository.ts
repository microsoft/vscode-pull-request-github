/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Remote } from "../models/remote";
import { PRType, PullRequestModel } from "./pullRequestModel";
import Logger from "../logger";
import * as Octokit from '@octokit/rest';

export class GitHubRepository {
	constructor(public readonly remote: Remote, public readonly octokit: Octokit) {
	}

	async getPullRequests(prType: PRType) {
		if (prType === PRType.All) {
			let result = await this.octokit.pullRequests.getAll({
				owner: this.remote.owner,
				repo: this.remote.repositoryName,
			});

			return result.data.map(item => {
				if (!item.head.repo) {
					Logger.appendLine('GitHubRepository> The remote branch for this PR was already deleted.');
					return null;
				}
				return new PullRequestModel(this, this.remote, item);
			}).filter(item => item !== null);
		} else {
			const user = await this.octokit.users.get({});
			const { data } = await this.octokit.search.issues({
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

			return Promise.all(promises).then(values => {
				return values.map(item => {
					if (!item.data.head.repo) {
						Logger.appendLine('GitHubRepository> The remote branch for this PR was already deleted.');
						return null;
					}
					return new PullRequestModel(this, this.remote, item.data);
				}).filter(item => item !== null);
			});
		}
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

			return new PullRequestModel(this, this.remote, data);
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