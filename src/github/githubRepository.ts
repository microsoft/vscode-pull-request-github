/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as Octokit from '@octokit/rest';
import Logger from '../common/logger';
import { Remote, parseRemote } from '../common/remote';
import { PRType, IGitHubRepository, IAccount } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { CredentialStore, GitHub } from './credentials';
import { AuthenticationError } from '../common/authentication';
import { QueryOptions, MutationOptions, ApolloQueryResult, NetworkStatus } from 'apollo-boost';
import { PRDocumentCommentProvider, PRDocumentCommentProviderGraphQL } from '../view/prDocumentCommentProvider';
import { convertRESTPullRequestToRawPullRequest, parseGraphQLPullRequest } from './utils';
import { PullRequestResponse, MentionableUsersResponse } from './graphql';
const queries = require('./queries.gql');

export const PULL_REQUEST_PAGE_SIZE = 20;

const GRAPHQL_COMPONENT_ID = 'GraphQL';

export interface PullRequestData {
	pullRequests: PullRequestModel[];
	hasMorePages: boolean;
}

export class GitHubRepository implements IGitHubRepository, vscode.Disposable {
	static ID = 'GitHubRepository';
	private _hub: GitHub | undefined;
	private _initialized: boolean;
	private _metadata: any;
	private _toDispose: vscode.Disposable[] = [];

	public commentsProvider: PRDocumentCommentProvider | PRDocumentCommentProviderGraphQL;

	public get hub(): GitHub {
		if (!this._hub) {
			if (!this._initialized) {
				throw new Error('Call ensure() before accessing this property.');
			} else {
				throw new AuthenticationError('Not authenticated.');
			}
		}
		return this._hub;
	}

	public async ensureCommentsProvider(): Promise<void> {
		try {
			if (this.commentsProvider) {
				return;
			}

			await this.ensure();
			this.commentsProvider = this.supportsGraphQl ? new PRDocumentCommentProviderGraphQL() : new PRDocumentCommentProvider();
			this._toDispose.push(vscode.workspace.registerDocumentCommentProvider(this.commentsProvider));
		} catch (e) {
			console.log(e);
		}

	}

	dispose() {
		this._toDispose.forEach(d => d.dispose());
	}

	public get octokit(): Octokit {
		return this.hub && this.hub.octokit;
	}

	constructor(public remote: Remote, private readonly _credentialStore: CredentialStore) {
	}

	get supportsGraphQl(): boolean {
		return !!(this.hub && this.hub.graphql);
	}

	query = async <T>(query: QueryOptions): Promise<ApolloQueryResult<T>> => {
		const gql = this.hub && this.hub.graphql;
		if (!gql) {
			Logger.debug(`Not available for query: ${query}`, GRAPHQL_COMPONENT_ID);
			return {
				data: null,
				loading: false,
				networkStatus: NetworkStatus.error,
				stale: false
			} as any;
		}

		Logger.debug(`Request: ${JSON.stringify(query, null, 2)}`, GRAPHQL_COMPONENT_ID);
		const rsp = await gql.query<T>(query);
		Logger.debug(`Response: ${JSON.stringify(rsp, null, 2)}`, GRAPHQL_COMPONENT_ID);
		return rsp;
	}

	mutate = async <T>(mutation: MutationOptions): Promise<ApolloQueryResult<T>> => {
		const gql = this.hub && this.hub.graphql;
		if (!gql) {
			Logger.debug(`Not available for query: ${mutation}`, GRAPHQL_COMPONENT_ID);
			return {
				data: null,
				loading: false,
				networkStatus: NetworkStatus.error,
				stale: false
			} as any;
		}

		Logger.debug(`Request: ${JSON.stringify(mutation, null, 2)}`, GRAPHQL_COMPONENT_ID);
		const rsp = await gql.mutate<T>(mutation);
		Logger.debug(`Response: ${JSON.stringify(rsp, null, 2)}`, GRAPHQL_COMPONENT_ID);
		return rsp;
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
			this.remote = parseRemote(this.remote.remoteName, clone_url, this.remote.gitProtocol)!;
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

	async getPullRequests(prType: PRType, page?: number): Promise<PullRequestData | undefined> {
		return prType === PRType.All ? this.getAllPullRequests(page) : this.getPullRequestsForCategory(prType, page);
	}

	private async getAllPullRequests(page?: number): Promise<PullRequestData | undefined> {
		try {
			Logger.debug(`Fetch all pull requests - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const result = await octokit.pullRequests.getAll({
				owner: remote.owner,
				repo: remote.repositoryName,
				per_page: PULL_REQUEST_PAGE_SIZE,
				page: page || 1
			});

			const hasMorePages = !!result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
			const pullRequests = result.data
				.map(
					pullRequest => {
						if (!pullRequest.head.repo) {
							Logger.appendLine(
								'GitHubRepository> The remote branch for this PR was already deleted.'
							);
							return null;
						}

						const item = convertRESTPullRequestToRawPullRequest(pullRequest);
						return new PullRequestModel(this, this.remote, item);
					}
				)
				.filter(item => item !== null) as PullRequestModel[];

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
	}

	private async getPullRequestsForCategory(prType: PRType, page?: number): Promise<PullRequestData | undefined> {
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
			let promises: Promise<Octokit.Response<Octokit.PullRequestsGetResponse>>[] = [];
			data.items.forEach((item: any /** unluckily Octokit.AnyResponse */) => {
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
					return new PullRequestModel(this, this.remote, convertRESTPullRequestToRawPullRequest(item.data));
				}).filter(item => item !== null) as PullRequestModel[];
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

	async getPullRequest(id: number): Promise<PullRequestModel | undefined> {
		try {
			Logger.debug(`Fetch pull request ${id} - enter`, GitHubRepository.ID);
			const { octokit, query, remote, supportsGraphQl } = await this.ensure();

			if (supportsGraphQl) {
				const { data } = await query<PullRequestResponse>({
					query: queries.PullRequest,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						number: id
					}
				});

				Logger.debug(`Fetch pull request ${id} - done`, GitHubRepository.ID);
				return new PullRequestModel(this, remote, parseGraphQLPullRequest(data));
			} else {
				let { data } = await octokit.pullRequests.get({
					owner: remote.owner,
					repo: remote.repositoryName,
					number: id
				});
				Logger.debug(`Fetch pull request ${id} - done`, GitHubRepository.ID);

				if (!data.head.repo) {
					Logger.appendLine('The remote branch for this PR was already deleted.', GitHubRepository.ID);
					return;
				}

				let item = convertRESTPullRequestToRawPullRequest(data);
				return new PullRequestModel(this, remote, item);
			}
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch PR: ${e}`);
			return;
		}
	}

	async getMentionableUsers(): Promise<IAccount[]> {
		Logger.debug(`Fetch mentionable users - enter`, GitHubRepository.ID);
		const { query, supportsGraphQl, remote } = await this.ensure();

		if (supportsGraphQl) {
			let after = null;
			let hasNextPage = false;
			let ret: IAccount[] = [];

			do {
				try {
					const result: { data: MentionableUsersResponse } = await query<MentionableUsersResponse>({
						query: queries.GetMentionableUsers,
						variables: {
							owner: remote.owner,
							name: remote.repositoryName,
							first: 100,
							after: after
						}
					});

					ret.push(...result.data.repository.mentionableUsers.nodes.map((node: any) => {
						return {
							login: node.login,
							avatarUrl: node.avatarUrl,
							name: node.name,
							email: node.email,
							url: node.url
						};
					}));

					hasNextPage = result.data.repository.mentionableUsers.pageInfo.hasNextPage;
					after = result.data.repository.mentionableUsers.pageInfo.endCursor;
				} catch (e) {
					Logger.debug(`Unable to fetch mentionable users: ${e}`, GitHubRepository.ID);
					return ret;
				}
			} while (hasNextPage);

			return ret;
		}

		return [];
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
