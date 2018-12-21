/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as Octokit from '@octokit/rest';
import Logger from '../common/logger';
import { Remote, parseRemote } from '../common/remote';
import { PRType, IGitHubRepository, PullRequest } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { CredentialStore, GitHub } from './credentials';
import { AuthenticationError } from '../common/authentication';
import { QueryOptions, MutationOptions } from 'apollo-boost';
import { ALL_PULL_REQUEST_QUERY as ALL_PULL_REQUESTS_QUERY, resolvePullRequests } from './gql/pullrequests';

export const PULL_REQUEST_PAGE_SIZE = 20;

export interface PullRequestData {
	pullRequests: PullRequestModel[];
	hasMorePages: boolean;
}

export class GitHubRepository implements IGitHubRepository {
	static ID = 'GitHubRepository';
	private _hub: GitHub;
	private _initialized: boolean;
	private _metadata: any;
	public get hub(): GitHub {
		if (this._hub === undefined) {
			if (!this._initialized) {
				throw new Error('Call ensure() before accessing this property.');
			} else {
				throw new AuthenticationError('Not authenticated.');
			}
		}
		return this._hub;
	}

	supportsGraphQl(): boolean {
		return !!(this.hub && this._hub.graphql);
	}

	public get octokit(): Octokit {
		return this.hub && this._hub.octokit;
	}

	query = async <T=any>(query: QueryOptions) => {
		const gql = this.hub && this._hub.graphql;
		if (!gql) {
			Logger.debug(`Not available for query: ${query}`, 'GraphQL');
			return null;
		}
		Logger.appendLine('---');
		Logger.appendLine(JSON.stringify(query, null, 2));
		Logger.appendLine('>>>');
		const rsp = await gql.query<T>(query);
		Logger.appendLine(JSON.stringify(rsp, null, 2));
		Logger.appendLine('---');
		return rsp;
	}

	mutate = async <T=any>(mutation: MutationOptions) => {
		const gql = this.hub && this._hub.graphql;
		if (!gql) {
			Logger.debug(`Not available for query: ${mutation}`, 'GraphQL');
			return null;
		}
		Logger.appendLine('---');
		Logger.appendLine(JSON.stringify(mutation, null, 2));
		Logger.appendLine('>>>');
		const rsp = await gql.mutate<T>(mutation);
		Logger.appendLine(JSON.stringify(rsp, null, 2));
		Logger.appendLine('---');
		return rsp;
	}

	constructor(public remote: Remote, private readonly _credentialStore: CredentialStore) {
	}

	async getMetadata(): Promise<any> {
		Logger.debug(`Fetch metadata - enter`, GitHubRepository.ID);
		if (this._metadata) {
			Logger.debug(`Fetch metadata ${this._metadata.owner.login}/${this._metadata.name} - done`, GitHubRepository.ID);
			return this._metadata;
		}
		const { octokit, remote } = await this.ensure();
		const result = await octokit.repos.get({
			owner: remote.owner,
			repo: remote.repositoryName
		});
		Logger.debug(`Fetch metadata ${remote.owner}/${remote.repositoryName} - done`, GitHubRepository.ID);
		this._metadata = Object.assign(result.data, { currentUser: (octokit as any).currentUser });
		return this._metadata;
	}

	async resolveRemote(): Promise<void> {
		try {
			const { clone_url } = await this.getMetadata();
			this.remote = parseRemote(this.remote.remoteName, clone_url, this.remote.gitProtocol);
		} catch (e) {
			Logger.appendLine(`Unable to resolve remote: ${e}`);
		}
	}

	async ensure(): Promise<GitHubRepository> {
		this._initialized = true;

		if (!await this._credentialStore.hasOctokit(this.remote)) {
			this._hub = await this._credentialStore.loginWithConfirmation(this.remote);
		} else {
			this._hub = await this._credentialStore.getHub(this.remote);
		}

		return this;
	}

	async authenticate(): Promise<boolean> {
		this._initialized = true;
		if (!await this._credentialStore.hasOctokit(this.remote)) {
			this._hub = await this._credentialStore.login(this.remote);
		} else {
			this._hub = this._credentialStore.getHub(this.remote);
		}
		return this.octokit !== undefined;
	}

	async getDefaultBranch(): Promise<string> {
		try {
			Logger.debug(`Fetch default branch - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const { data } = await octokit.repos.get({
				owner: remote.owner,
				repo: remote.repositoryName
			});
			Logger.debug(`Fetch default branch - done`, GitHubRepository.ID);

			return data.default_branch;
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Fetching default branch failed: ${e}`);
		}

		return 'master';
	}

	async getBranch(branchName: string): Promise<Octokit.ReposGetBranchResponse> {
		try {
			Logger.debug(`Fetch branch ${branchName} - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const { data } = await octokit.repos.getBranch({
				owner: remote.owner,
				repo: remote.repositoryName,
				branch: branchName
			});
			Logger.debug(`Fetch branch ${branchName} - done`, GitHubRepository.ID);

			return data;
		} catch (e) {
			Logger.appendLine(`Fetching branch ${branchName} failed`, GitHubRepository.ID);
		}
	}

	async getPullRequests(prType: PRType, page?: number): Promise<PullRequestData> {
		return prType === PRType.All ? this.getAllPullRequests(page) : this.getPullRequestsForCategory(prType, page);
	}

	private async getAllPullRequests(page?: number): Promise<PullRequestData> {
		try {
			Logger.debug(`Fetch all pull requests - enter`, GitHubRepository.ID);
			const { octokit, remote, query } = await this.ensure();
			if (this.supportsGraphQl()) {
				try {
					const { data } = await query({
						query: ALL_PULL_REQUESTS_QUERY,
						variables: {
							owner: remote.owner,
							name: remote.repositoryName,
						}
					});
					let ret = {
						pullRequests: resolvePullRequests(data),
						hasMorePages: data.repository.pullRequests.pageInfo.hasPreviousPage
					};

					return ret;
				} catch (error) {
					return null;
				}
			}

			const result = await octokit.pullRequests.getAll({
				owner: remote.owner,
				repo: remote.repositoryName,
				per_page: PULL_REQUEST_PAGE_SIZE,
				page: page || 1
			});

			const hasMorePages = !!result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
			const pullRequests = result.data
				.map(
					({
						number,
						body,
						title,
						html_url,
						user,
						state,
						assignee,
						created_at,
						updated_at,
						head,
						base,
						node_id
					}) => {
						if (!head.repo) {
							Logger.appendLine(
								'GitHubRepository> The remote branch for this PR was already deleted.'
							);
							return null;
						}

						const item: PullRequest = {
							number,
							body,
							title,
							html_url,
							user,
							labels: [],
							state,
							merged: false,
							assignee,
							created_at,
							updated_at,
							comments: 0,
							commits: 0,
							head,
							base,
							node_id
						};

						return new PullRequestModel(this, this.remote, item);
					}
				)
				.filter(item => item !== null);

			Logger.debug(`Fetch all pull requests - done`, GitHubRepository.ID);
			return {
				pullRequests,
				hasMorePages
			};
		} catch (e) {
			Logger.appendLine(`Fetching all pull requests failed: ${e}`, GitHubRepository.ID);
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
			Logger.debug(`Fetch pull request catogory ${PRType[prType]} - enter`, GitHubRepository.ID);
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
			Logger.debug(`Fetch pull request catogory ${PRType[prType]} - done`, GitHubRepository.ID);

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
			Logger.debug(`Fetch pull request ${id} - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			let { data } = await octokit.pullRequests.get({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: id
			});
			Logger.debug(`Fetch pull request ${id} - done`, GitHubRepository.ID);

			if (!data.head.repo) {
				Logger.appendLine('The remote branch for this PR was already deleted.', GitHubRepository.ID);
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
