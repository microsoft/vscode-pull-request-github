/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Octokit = require('@octokit/rest');
import Logger from '../common/logger';
import { Remote, parseRemote } from '../common/remote';
import { IAccount, RepoAccessAndMergeMethods, PullRequestMergeability } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { CredentialStore, GitHub } from './credentials';
import { AuthenticationError } from '../common/authentication';
import { QueryOptions, MutationOptions, ApolloQueryResult, NetworkStatus, FetchResult } from 'apollo-boost';
import { PRCommentController } from '../view/prCommentController';
import { convertRESTPullRequestToRawPullRequest, parseMergeability, parseGraphQLPullRequest, parseGraphQLSearchRequest } from './utils';
import { PullRequestResponse, MentionableUsersResponse, AssignableUsersResponse, PullRequestSearchResponse } from './graphql';
import { IssueModel } from './issueModel';

export const PULL_REQUEST_PAGE_SIZE = 20;

const GRAPHQL_COMPONENT_ID = 'GraphQL';

export interface IssueData {
	items: IssueModel[];
	hasMorePages: boolean;
}

export interface PullRequestData extends IssueData {
	items: PullRequestModel[];
}

export interface IMetadata extends Octokit.ReposGetResponse {
	currentUser: any;
}

export class GitHubRepository implements vscode.Disposable {
	static ID = 'GitHubRepository';
	protected _initialized: boolean;
	protected _hub: GitHub | undefined;
	protected _metadata: IMetadata;
	private _toDispose: vscode.Disposable[] = [];
	public commentsController?: vscode.CommentController;
	public commentsHandler?: PRCommentController;
	public readonly isGitHubDotCom: boolean;

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

	public async ensureCommentsController(): Promise<void> {
		try {
			if (this.commentsController) {
				return;
			}

			await this.ensure();
			this.commentsController = vscode.comments.createCommentController(`browse-${this.remote.normalizedHost}`, `GitHub Pull Request for ${this.remote.normalizedHost}`);
			this.commentsHandler = new PRCommentController(this.commentsController);
			this._toDispose.push(this.commentsController);
			this._toDispose.push(this.commentsController);
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
		this.isGitHubDotCom = remote.host.toLowerCase() === 'github.com';
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

	mutate = async <T>(mutation: MutationOptions): Promise<FetchResult<T>> => {
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

	get schema() {
		return this.hub.schema;
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

	async getRepoAccessAndMergeMethods(): Promise<RepoAccessAndMergeMethods> {
		try {
			Logger.debug(`Fetch repo permissions and available merge methods - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const { data } = await octokit.repos.get({
				owner: remote.owner,
				repo: remote.repositoryName
			});
			Logger.debug(`Fetch repo permissions and available merge methods - done`, GitHubRepository.ID);

			return {
				// Users with push access to repo have rights to merge/close PRs,
				// edit title/description, assign reviewers/labels etc.
				hasWritePermission: data.permissions.push,
				mergeMethodsAvailability: {
					merge: data.allow_merge_commit,
					squash: data.allow_squash_merge,
					rebase: data.allow_rebase_merge
				}
			};
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Fetching repo permissions and available merge methods failed: ${e}`);
		}

		return {
			hasWritePermission: true,
			mergeMethodsAvailability: {
				merge: true,
				squash: true,
				rebase: true
			}
		};
	}

	async getAllPullRequests(page?: number): Promise<PullRequestData | undefined> {
		try {
			Logger.debug(`Fetch all pull requests - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const result = await octokit.pulls.list({
				owner: remote.owner,
				repo: remote.repositoryName,
				per_page: PULL_REQUEST_PAGE_SIZE,
				page: page || 1
			});

			const hasMorePages = !!result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
			if (!result.data) {
				// We really don't expect this to happen, but it seems to (see #574).
				// Log a warning and return an empty set.
				Logger.appendLine(`Warning: no result data for ${remote.owner}/${remote.repositoryName} Status: ${result.status}`);
				return {
					items: [],
					hasMorePages: false,
				};
			}

			const pullRequests = result.data
				.map(
					pullRequest => {
						if (!pullRequest.head.repo) {
							Logger.appendLine(
								'GitHubRepository> The remote branch for this PR was already deleted.'
							);
							return null;
						}

						return new PullRequestModel(this, this.remote, convertRESTPullRequestToRawPullRequest(pullRequest, this));
					}
				)
				.filter(item => item !== null) as PullRequestModel[];

			Logger.debug(`Fetch all pull requests - done`, GitHubRepository.ID);
			return {
				items: pullRequests,
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

	async getAllIssues(page?: number): Promise<IssueData | undefined> {
		try {
			Logger.debug(`Fetch all issues - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<PullRequestSearchResponse>({
				query: schema.Issues,
				variables: {
					query: `assignee:${this._credentialStore.getCurrentUser(remote).login} state:open repo:${remote.owner}/${remote.repositoryName}`
				}
			});
			Logger.debug(`Fetch all issues - done`, GitHubRepository.ID);

			const issues: IssueModel[] = [];
			if (data && data.search && data.search.edges) {
				data.search.edges.forEach(raw => {
					if (raw.node.id) {
						issues.push(new IssueModel(this, remote, parseGraphQLSearchRequest(raw.node, this)));
					}
				});
			}
			return {
				items: issues,
				hasMorePages: data.search.pageInfo.hasNextPage
			};
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch issues: ${e}`);
			return;
		}
	}

	async getPullRequestsForCategory(categoryQuery: string, page?: number): Promise<PullRequestData | undefined> {
		try {
			Logger.debug(`Fetch pull request category ${categoryQuery} - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const user = await octokit.users.getAuthenticated({});
			// Search api will not try to resolve repo that redirects, so get full name first
			const repo = await octokit.repos.get({ owner: this.remote.owner, repo: this.remote.repositoryName });
			const { data, headers } = await octokit.search.issuesAndPullRequests({
				q: this.getPRFetchQuery(repo.data.full_name, user.data.login, categoryQuery),
				per_page: PULL_REQUEST_PAGE_SIZE,
				page: page || 1
			});
			const promises: Promise<Octokit.Response<Octokit.PullsGetResponse>>[] = [];
			data.items.forEach((item: any /** unluckily Octokit.AnyResponse */) => {
				promises.push(new Promise(async (resolve, reject) => {
					const prData = await octokit.pulls.get({
						owner: remote.owner,
						repo: remote.repositoryName,
						pull_number: item.number
					});
					resolve(prData);
				}));
			});

			const hasMorePages = !!headers.link && headers.link.indexOf('rel="next"') > -1;
			const pullRequestResponses = await Promise.all(promises);

			const pullRequests = pullRequestResponses.map(response => {
				if (!response.data.head.repo) {
					Logger.appendLine('GitHubRepository> The remote branch for this PR was already deleted.');
					return null;
				}

				return new PullRequestModel(this, this.remote, convertRESTPullRequestToRawPullRequest(response.data, this));
			}).filter(item => item !== null) as PullRequestModel[];

			Logger.debug(`Fetch pull request category ${categoryQuery} - done`, GitHubRepository.ID);

			return {
				items: pullRequests,
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
			const { query, remote, schema } = await this.ensure();

			const { data } = await query<PullRequestResponse>({
				query: schema.PullRequest,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: id
				}
			});
			Logger.debug(`Fetch pull request ${id} - done`, GitHubRepository.ID);

			return new PullRequestModel(this, remote, parseGraphQLPullRequest(data, this));
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch PR: ${e}`);
			return;
		}
	}

	async getIssue(id: number): Promise<IssueModel | undefined> {
		try {
			Logger.debug(`Fetch issue ${id} - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();

			const { data } = await query<PullRequestResponse>({
				query: schema.Issue,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: id
				}
			});
			Logger.debug(`Fetch issue ${id} - done`, GitHubRepository.ID);

			return new IssueModel(this, remote, parseGraphQLPullRequest(data, this));
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch PR: ${e}`);
			return;
		}
	}

	async getPullRequestMergeability(id: number): Promise<PullRequestMergeability> {
		try {
			Logger.debug(`Fetch pull request mergeability ${id} - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();

			const { data } = await query<PullRequestResponse>({
				query: schema.PullRequestMergeability,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: id
				}
			});
			Logger.debug(`Fetch pull request mergeability ${id} - done`, GitHubRepository.ID);
			return parseMergeability(data.repository.pullRequest.mergeable);
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to fetch PR Mergeability: ${e}`);
			return PullRequestMergeability.Unknown;
		}
	}

	async deleteBranch(pullRequestModel: PullRequestModel): Promise<void> {
		const { octokit } = await this.ensure();

		if (!pullRequestModel.validatePullRequestModel('Unable to delete branch')) {
			return;
		}

		try {
			await octokit.git.deleteRef({
				owner: pullRequestModel.head.repositoryCloneUrl.owner,
				repo: pullRequestModel.head.repositoryCloneUrl.repositoryName,
				ref: `heads/${pullRequestModel.head.ref}`
			});
		} catch (e) {
			Logger.appendLine(`GithubRepository> Unable to delete branch: ${e}`);
			return;
		}
	}

	async getMentionableUsers(): Promise<IAccount[]> {
		Logger.debug(`Fetch mentionable users - enter`, GitHubRepository.ID);
		const { query, remote, schema } = await this.ensure();

		let after = null;
		let hasNextPage = false;
		const ret: IAccount[] = [];

		do {
			try {
				const result: { data: MentionableUsersResponse } = await query<MentionableUsersResponse>({
					query: schema.GetMentionableUsers,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						first: 100,
						after: after
					}
				});

				ret.push(...result.data.repository.mentionableUsers.nodes.map(node => {
					return {
						login: node.login,
						avatarUrl: node.avatarUrl,
						name: node.name,
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

	async getAssignableUsers(): Promise<IAccount[]> {
		Logger.debug(`Fetch assignable users - enter`, GitHubRepository.ID);
		const { query, remote, schema } = await this.ensure();

		let after = null;
		let hasNextPage = false;
		const ret: IAccount[] = [];

		do {
			try {
				const result: { data: AssignableUsersResponse } = await query<AssignableUsersResponse>({
					query: schema.GetAssignableUsers,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						first: 100,
						after: after
					}
				});

				ret.push(...result.data.repository.assignableUsers.nodes.map(node => {
					return {
						login: node.login,
						avatarUrl: node.avatarUrl,
						name: node.name,
						url: node.url
					};
				}));

				hasNextPage = result.data.repository.assignableUsers.pageInfo.hasNextPage;
				after = result.data.repository.assignableUsers.pageInfo.endCursor;
			} catch (e) {
				Logger.debug(`Unable to fetch assignable users: ${e}`, GitHubRepository.ID);
				return ret;
			}
		} while (hasNextPage);

		return ret;
	}

	private getPRFetchQuery(repo: string, user: string, query: string) {
		const filter = query.replace('${user}', user);
		return `is:open ${filter} type:pr repo:${repo}`;
	}
}
