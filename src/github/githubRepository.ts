/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as Octokit from '@octokit/rest';
import Logger from '../common/logger';
import { Remote, parseRemote } from '../common/remote';
import { PRType, IGitHubRepository } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { CredentialStore } from './credentials';
import { AuthenticationError } from '../common/authentication';

export const PULL_REQUEST_PAGE_SIZE = 20;

export interface PullRequestData {
	pullRequests: PullRequestModel[];
	hasMorePages: boolean;
}

export class GitHubRepository implements IGitHubRepository {
	private _octokit: Octokit;
	private _initialized: boolean;
	public get octokit(): Octokit {
		if (this._octokit === undefined) {
			if (!this._initialized) {
				throw new Error('Call ensure() before accessing this property.');
			} else {
				throw new AuthenticationError('Not authenticated.');
			}
		}
		return this._octokit;
	}

	constructor(public remote: Remote, private readonly _credentialStore: CredentialStore) {
	}

	async resolveRemote(): Promise<void> {
		try {
			const { octokit, remote } = await this.ensure();
			const { data } = await octokit.repos.get({
				owner: remote.owner,
				repo: remote.repositoryName
			});

			this.remote = parseRemote(remote.remoteName, data.clone_url, remote.gitProtocol);
		} catch (e) {
			Logger.appendLine(`Unable to resolve remote: ${e}`);
		}
	}

	async ensure(): Promise<GitHubRepository> {
		this._initialized = true;

		if (!await this._credentialStore.hasOctokit(this.remote)) {
			this._octokit = await this._credentialStore.loginWithConfirmation(this.remote);
		} else {
			this._octokit = await this._credentialStore.getOctokit(this.remote);
		}

		return this;
	}

	async authenticate(): Promise<boolean> {
		this._initialized = true;
		if (!await this._credentialStore.hasOctokit(this.remote)) {
			this._octokit = await this._credentialStore.login(this.remote);
		} else {
			this._octokit = this._credentialStore.getOctokit(this.remote);
		}
		return this.octokit !== undefined;
	}

	async getDefaultBranch(): Promise<string> {
		try {
			const { octokit, remote } = await this.ensure();
			const { data } = await octokit.repos.get({
				owner: remote.owner,
				repo: remote.repositoryName
			});

			return data.default_branch;
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Fetching default branch failed: ${e}`);
		}

		return 'master';
	}

	async getPullRequests(prType: PRType, page?: number): Promise<PullRequestData> {
		return prType === PRType.All ? this.getAllPullRequests(page) : this.getPullRequestsForCategory(prType, page);
	}

	private async getAllPullRequests(page?: number): Promise<PullRequestData> {
		try {
			const { octokit, remote } = await this.ensure();
			const result = await octokit.pullRequests.getAll({
				owner: remote.owner,
				repo: remote.repositoryName,
				per_page: PULL_REQUEST_PAGE_SIZE,
				page: page || 1
			});

			const hasMorePages = !!result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
			const pullRequests = result.data.map(item => {
				if (!item.head.repo) {
					Logger.appendLine('GitHubRepository> The remote branch for this PR was already deleted.');
					return null;
				}
				return new PullRequestModel(this, this.remote, item);
			}).filter(item => item !== null);

			return {
				pullRequests,
				hasMorePages
			};
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Fetching all pull requests failed: ${e}`);
			if (e.code === 404) {
				// not found
				vscode.window.showWarningMessage(`Fetching pull requests for remote '${this.remote.remoteName}' failed, please check if the url ${this.remote.url} is valid.`);
			} else {
				throw e;
			}
		}

		return null;
	}

	private async getPullRequestsForCategory(prType: PRType, page: number): Promise<PullRequestData> {
		try {
			const { octokit, remote } = await this.ensure();
			const user = await octokit.users.get({});
			// Search api will not try to resolve repo that redirects, so get full name first
			const repo = await octokit.repos.get({ owner: this.remote.owner, repo: this.remote.repositoryName });
			const { data, headers } = await octokit.search.issues({
				q: this.getPRFetchQuery(repo.data.full_name, user.data.login, prType),
				per_page: PULL_REQUEST_PAGE_SIZE,
				page: page || 1
			});
			let promises = [];
			data.items.forEach(item => {
				promises.push(new Promise(async (resolve, reject) => {
					let prData = await octokit.pullRequests.get({
						owner: remote.owner,
						repo: remote.repositoryName,
						number: item.number
					});
					resolve(prData);
				}));
			});

			const hasMorePages = !!headers.link && headers.link.indexOf('rel="next"') > -1;
			const pullRequests = await Promise.all(promises).then(values => {
				return values.map(item => {
					if (!item.data.head.repo) {
						Logger.appendLine('GitHubRepository> The remote branch for this PR was already deleted.');
						return null;
					}
					return new PullRequestModel(this, this.remote, item.data);
				}).filter(item => item !== null);
			});

			return {
				pullRequests,
				hasMorePages
			};
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Fetching all pull requests failed: ${e}`);
			if (e.code === 404) {
				// not found
				vscode.window.showWarningMessage(`Fetching pull requests for remote ${this.remote.remoteName}, please check if the url ${this.remote.url} is valid.`);
			} else {
				throw e;
			}
		}
	}

	async getPullRequest(id: number): Promise<PullRequestModel> {
		try {
			const { octokit, remote } = await this.ensure();
			let { data } = await octokit.pullRequests.get({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: id
			});

			if (!data.head.repo) {
				Logger.appendLine('GitHubRepository> The remote branch for this PR was already deleted.');
				return null;
			}

			return new PullRequestModel(this, remote, data);
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch PR: ${e}`);
			return null;
		}
	}

	private getPRFetchQuery(repo: string, user: string, type: PRType) {
		let filter = '';
		switch (type) {
			case PRType.RequestReview:
				filter = `review-requested:${user}`;
				break;
			case PRType.AssignedToMe:
				filter = `assignee:${user}`;
				break;
			case PRType.Mine:
				filter = `author:${user}`;
				break;
			default:
				break;
		}

		return `is:open ${filter} type:pr repo:${repo}`;
	}
}