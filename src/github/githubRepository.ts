/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApolloQueryResult, FetchResult, MutationOptions, NetworkStatus, QueryOptions } from 'apollo-boost';
import * as vscode from 'vscode';
import { AuthenticationError, AuthProvider, GitHubServerType, isSamlError } from '../common/authentication';
import Logger from '../common/logger';
import { Protocol } from '../common/protocol';
import { GitHubRemote, parseRemote, Remote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { PRCommentControllerRegistry } from '../view/pullRequestCommentControllerRegistry';
import { OctokitCommon } from './common';
import { CredentialStore, GitHub } from './credentials';
import {
	AssignableUsersResponse,
	CreatePullRequestResponse,
	FileContentResponse,
	ForkDetailsResponse,
	GetChecksResponse,
	isCheckRun,
	IssuesResponse,
	IssuesSearchResponse,
	ListBranchesResponse,
	MaxIssueResponse,
	MentionableUsersResponse,
	MilestoneIssuesResponse,
	OrganizationTeamsCountResponse,
	OrganizationTeamsResponse,
	PullRequestParticipantsResponse,
	PullRequestResponse,
	PullRequestsResponse,
	ViewerPermissionResponse,
} from './graphql';
import { CheckState, IAccount, IMilestone, Issue, ITeam, PullRequest, PullRequestChecks, RepoAccessAndMergeMethods } from './interface';
import { IssueModel } from './issueModel';
import { LoggingOctokit } from './loggingOctokit';
import { PullRequestModel } from './pullRequestModel';
import defaultSchema from './queries.gql';
import {
	convertRESTPullRequestToRawPullRequest,
	getAvatarWithEnterpriseFallback,
	getOverrideBranch,
	getPRFetchQuery,
	parseGraphQLIssue,
	parseGraphQLPullRequest,
	parseGraphQLViewerPermission,
	parseMilestone,
} from './utils';

export const PULL_REQUEST_PAGE_SIZE = 20;

const GRAPHQL_COMPONENT_ID = 'GraphQL';

export interface ItemsData {
	items: any[];
	hasMorePages: boolean;
}

export interface IssueData extends ItemsData {
	items: IssueModel[];
	hasMorePages: boolean;
}

export interface PullRequestData extends IssueData {
	items: PullRequestModel[];
}

export interface MilestoneData extends ItemsData {
	items: { milestone: IMilestone; issues: IssueModel[] }[];
	hasMorePages: boolean;
}

export enum ViewerPermission {
	Unknown = 'unknown',
	Admin = 'ADMIN',
	Maintain = 'MAINTAIN',
	Read = 'READ',
	Triage = 'TRIAGE',
	Write = 'WRITE',
}

export interface ForkDetails {
	isFork: boolean;
	parent: {
		owner: {
			login: string;
		};
		name: string;
	};
}

export interface IMetadata extends OctokitCommon.ReposGetResponseData {
	currentUser: any;
}

export class GitHubRepository implements vscode.Disposable {
	static ID = 'GitHubRepository';
	protected _initialized: boolean = false;
	protected _hub: GitHub | undefined;
	protected _metadata: IMetadata | undefined;
	private _toDispose: vscode.Disposable[] = [];
	public commentsController?: vscode.CommentController;
	public commentsHandler?: PRCommentControllerRegistry;
	private _pullRequestModels = new Map<number, PullRequestModel>();

	private _onDidAddPullRequest: vscode.EventEmitter<PullRequestModel> = new vscode.EventEmitter();
	public readonly onDidAddPullRequest: vscode.Event<PullRequestModel> = this._onDidAddPullRequest.event;

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

	public equals(repo: GitHubRepository): boolean {
		return this.remote.equals(repo.remote);
	}

	get pullRequestModels(): Map<number, PullRequestModel> {
		return this._pullRequestModels;
	}

	public async ensureCommentsController(): Promise<void> {
		try {
			if (this.commentsController) {
				return;
			}

			await this.ensure();
			this.commentsController = vscode.comments.createCommentController(
				`github-browse-${this.remote.normalizedHost}`,
				`GitHub Pull Request for ${this.remote.normalizedHost}`,
			);
			this.commentsHandler = new PRCommentControllerRegistry(this.commentsController);
			this._toDispose.push(this.commentsHandler);
			this._toDispose.push(this.commentsController);
		} catch (e) {
			console.log(e);
		}
	}

	dispose() {
		this._toDispose.forEach(d => d.dispose());
		this._toDispose = [];
		this.commentsController = undefined;
		this.commentsHandler = undefined;
	}

	public get octokit(): LoggingOctokit {
		return this.hub && this.hub.octokit;
	}

	constructor(
		public remote: GitHubRemote,
		public readonly rootUri: vscode.Uri,
		private readonly _credentialStore: CredentialStore,
		private readonly _telemetry: ITelemetry,
	) {
		// kick off the comments controller early so that the Comments view is visible and doesn't pop up later in an way that's jarring
		this.ensureCommentsController();
	}

	get authMatchesServer(): boolean {
		if ((this.remote.githubServerType === GitHubServerType.GitHubDotCom) && this._credentialStore.isAuthenticated(AuthProvider.github)) {
			return true;
		} else if ((this.remote.githubServerType === GitHubServerType.Enterprise) && this._credentialStore.isAuthenticated(AuthProvider['github-enterprise'])) {
			return true;
		} else {
			// Not good. We have a mismatch between auth type and server type.
			return false;
		}
	}

	query = async <T>(query: QueryOptions, ignoreSamlErrors: boolean = false): Promise<ApolloQueryResult<T>> => {
		const gql = this.authMatchesServer && this.hub && this.hub.graphql;
		if (!gql) {
			Logger.debug(`Not available for query: ${query}`, GRAPHQL_COMPONENT_ID);
			return {
				data: null,
				loading: false,
				networkStatus: NetworkStatus.error,
				stale: false,
			} as any;
		}

		Logger.trace(`Request: ${JSON.stringify(query, null, 2)}`, GRAPHQL_COMPONENT_ID);
		let rsp;
		try {
			rsp = await gql.query<T>(query);
		} catch (e) {
			// Some queries just result in SAML errors, and some queries we may not want to retry because it will be too disruptive.
			if (!ignoreSamlErrors && e.message?.startsWith('GraphQL error: Resource protected by organization SAML enforcement.')) {
				await this._credentialStore.recreate();
				rsp = await gql.query<T>(query);
			} else {
				throw e;
			}
		}
		Logger.trace(`Response: ${JSON.stringify(rsp, null, 2)}`, GRAPHQL_COMPONENT_ID);
		return rsp;
	};

	mutate = async <T>(mutation: MutationOptions<T>): Promise<FetchResult<T>> => {
		const gql = this.authMatchesServer && this.hub && this.hub.graphql;
		if (!gql) {
			Logger.debug(`Not available for query: ${mutation}`, GRAPHQL_COMPONENT_ID);
			return {
				data: null,
				loading: false,
				networkStatus: NetworkStatus.error,
				stale: false,
			} as any;
		}

		Logger.trace(`Request: ${JSON.stringify(mutation, null, 2)}`, GRAPHQL_COMPONENT_ID);
		const rsp = await gql.mutate<T>(mutation);
		Logger.trace(`Response: ${JSON.stringify(rsp, null, 2)}`, GRAPHQL_COMPONENT_ID);
		return rsp;
	};

	get schema() {
		return defaultSchema as any;
	}

	async getMetadata(): Promise<IMetadata> {
		Logger.debug(`Fetch metadata - enter`, GitHubRepository.ID);
		if (this._metadata) {
			Logger.debug(
				`Fetch metadata ${this._metadata.owner?.login}/${this._metadata.name} - done`,
				GitHubRepository.ID,
			);
			return this._metadata;
		}
		const { octokit, remote } = await this.ensure();
		const result = await octokit.call(octokit.api.repos.get, {
			owner: remote.owner,
			repo: remote.repositoryName,
		});
		Logger.debug(`Fetch metadata ${remote.owner}/${remote.repositoryName} - done`, GitHubRepository.ID);
		this._metadata = ({ ...result.data, currentUser: (octokit as any).currentUser } as unknown) as IMetadata;
		return this._metadata;
	}

	/**
	 * Resolves remotes with redirects.
	 * @returns
	 */
	async resolveRemote(): Promise<boolean> {
		try {
			const { clone_url } = await this.getMetadata();
			this.remote = GitHubRemote.remoteAsGitHub(parseRemote(this.remote.remoteName, clone_url, this.remote.gitProtocol)!, this.remote.githubServerType);
		} catch (e) {
			Logger.warn(`Unable to resolve remote: ${e}`);
			if (isSamlError(e)) {
				return false;
			}
		}
		return true;
	}

	async ensure(): Promise<GitHubRepository> {
		this._initialized = true;

		if (!this._credentialStore.isAuthenticated(this.remote.authProviderId)) {
			// We need auth now. (ex., a PR is already checked out)
			// We can no longer wait until later for login to be done
			await this._credentialStore.create();
			if (!this._credentialStore.isAuthenticated(this.remote.authProviderId)) {
				this._hub = await this._credentialStore.showSignInNotification(this.remote.authProviderId);
			}
		} else {
			this._hub = this._credentialStore.getHub(this.remote.authProviderId);
		}

		return this;
	}

	async getDefaultBranch(): Promise<string> {
		const overrideSetting = getOverrideBranch();
		if (overrideSetting) {
			return overrideSetting;
		}
		try {
			Logger.debug(`Fetch default branch - enter`, GitHubRepository.ID);
			const data = await this.getMetadata();
			Logger.debug(`Fetch default branch - done`, GitHubRepository.ID);

			return data.default_branch;
		} catch (e) {
			Logger.warn(`Fetching default branch failed: ${e}`, GitHubRepository.ID);
		}

		return 'master';
	}

	private _repoAccessAndMergeMethods: RepoAccessAndMergeMethods | undefined;
	async getRepoAccessAndMergeMethods(refetch: boolean = false): Promise<RepoAccessAndMergeMethods> {
		try {
			if (!this._repoAccessAndMergeMethods || refetch) {
				Logger.debug(`Fetch repo permissions and available merge methods - enter`, GitHubRepository.ID);
				const data = await this.getMetadata();

				Logger.debug(`Fetch repo permissions and available merge methods - done`, GitHubRepository.ID);
				const hasWritePermission = data.permissions?.push ?? false;
				this._repoAccessAndMergeMethods = {
					// Users with push access to repo have rights to merge/close PRs,
					// edit title/description, assign reviewers/labels etc.
					hasWritePermission,
					mergeMethodsAvailability: {
						merge: data.allow_merge_commit ?? false,
						squash: data.allow_squash_merge ?? false,
						rebase: data.allow_rebase_merge ?? false,
					},
					viewerCanAutoMerge: ((data as any).allow_auto_merge && hasWritePermission) ?? false
				};
			}
			return this._repoAccessAndMergeMethods;
		} catch (e) {
			Logger.warn(`GitHubRepository> Fetching repo permissions and available merge methods failed: ${e}`);
		}

		return {
			hasWritePermission: true,
			mergeMethodsAvailability: {
				merge: true,
				squash: true,
				rebase: true,
			},
			viewerCanAutoMerge: false
		};
	}

	async getAllPullRequests(page?: number): Promise<PullRequestData | undefined> {
		try {
			Logger.debug(`Fetch all pull requests - enter`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const result = await octokit.call(octokit.api.pulls.list, {
				owner: remote.owner,
				repo: remote.repositoryName,
				per_page: PULL_REQUEST_PAGE_SIZE,
				page: page || 1,
			});

			const hasMorePages = !!result.headers.link && result.headers.link.indexOf('rel="next"') > -1;
			if (!result.data) {
				// We really don't expect this to happen, but it seems to (see #574).
				// Log a warning and return an empty set.
				Logger.warn(
					`No result data for ${remote.owner}/${remote.repositoryName} Status: ${result.status}`,
				);
				return {
					items: [],
					hasMorePages: false,
				};
			}

			const pullRequests = result.data
				.map(pullRequest => {
					if (!pullRequest.head.repo) {
						Logger.appendLine('The remote branch for this PR was already deleted.', GitHubRepository.ID);
						return null;
					}

					return this.createOrUpdatePullRequestModel(
						convertRESTPullRequestToRawPullRequest(pullRequest, this),
					);
				})
				.filter(item => item !== null) as PullRequestModel[];

			Logger.debug(`Fetch all pull requests - done`, GitHubRepository.ID);
			return {
				items: pullRequests,
				hasMorePages,
			};
		} catch (e) {
			Logger.error(`Fetching all pull requests failed: ${e}`, GitHubRepository.ID);
			if (e.code === 404) {
				// not found
				vscode.window.showWarningMessage(
					`Fetching pull requests for remote '${this.remote.remoteName}' failed, please check if the url ${this.remote.url} is valid.`,
				);
			} else {
				throw e;
			}
		}
		return undefined;
	}

	async getPullRequestForBranch(branch: string): Promise<PullRequestModel | undefined> {
		try {
			Logger.debug(`Fetch pull requests for branch - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<PullRequestsResponse>({
				query: schema.PullRequestForHead,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					headRefName: branch,
				},
			});
			Logger.debug(`Fetch pull requests for branch - done`, GitHubRepository.ID);

			if (data?.repository.pullRequests.nodes.length > 0) {
				const prs = data.repository.pullRequests.nodes.map(node => parseGraphQLPullRequest(node, this));
				const mostRecentOrOpenPr = prs.find(pr => pr.state.toLowerCase() === 'open') ?? prs[0];
				return this.createOrUpdatePullRequestModel(mostRecentOrOpenPr);
			}
		} catch (e) {
			Logger.error(`Fetching pull requests for branch failed: ${e}`, GitHubRepository.ID);
			if (e.code === 404) {
				// not found
				vscode.window.showWarningMessage(
					`Fetching pull requests for remote '${this.remote.remoteName}' failed, please check if the url ${this.remote.url} is valid.`,
				);
			} else {
				throw e;
			}
		}

		return undefined;
	}

	private getRepoForIssue(githubRepository: GitHubRepository, parsedIssue: Issue): GitHubRepository {
		if (
			parsedIssue.repositoryName &&
			parsedIssue.repositoryUrl &&
			(githubRepository.remote.owner !== parsedIssue.repositoryOwner ||
				githubRepository.remote.repositoryName !== parsedIssue.repositoryName)
		) {
			const remote = new Remote(
				parsedIssue.repositoryName,
				parsedIssue.repositoryUrl,
				new Protocol(parsedIssue.repositoryUrl),
			);
			githubRepository = new GitHubRepository(GitHubRemote.remoteAsGitHub(remote, this.remote.githubServerType), this.rootUri, this._credentialStore, this._telemetry);
		}
		return githubRepository;
	}

	async getMilestones(includeClosed: boolean = false): Promise<any> {
		try {
			Logger.debug(`Fetch milestones - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const states = ['OPEN'];
			if (includeClosed) {
				states.push('CLOSED');
			}
			const { data } = await query<MilestoneIssuesResponse>({
				query: schema.GetMilestones,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					states: states,
				},
			});
			Logger.debug(`Fetch milestones - done`, GitHubRepository.ID);

			const milestones: IMilestone[] = [];
			if (data && data.repository.milestones && data.repository.milestones.nodes) {
				data.repository.milestones.nodes.forEach(raw => {
					const milestone = parseMilestone(raw);
					if (milestone) {
						milestones.push(milestone);
					}
				});
			}
			return milestones;
		} catch (e) {
			Logger.error(`Unable to fetch milestones: ${e}`, GitHubRepository.ID);
			return;
		}
	}

	async getLines(sha: string, file: string, lineStart: number, lineEnd: number): Promise<string | undefined> {
		Logger.debug(`Fetch milestones - enter`, GitHubRepository.ID);
		const { query, remote, schema } = await this.ensure();
		const { data } = await query<FileContentResponse>({
			query: schema.GetFileContent,
			variables: {
				owner: remote.owner,
				name: remote.repositoryName,
				expression: `${sha}:${file}`
			}
		});

		if (!data.repository.object.text) {
			return undefined;
		}

		return data.repository.object.text.split('\n').slice(lineStart - 1, lineEnd).join('\n');
	}

	async getIssuesForUserByMilestone(_page?: number): Promise<MilestoneData | undefined> {
		try {
			Logger.debug(`Fetch all issues - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<MilestoneIssuesResponse>({
				query: schema.GetMilestonesWithIssues,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					assignee: (await this._credentialStore.getCurrentUser(remote.authProviderId))?.login,
				},
			});
			Logger.debug(`Fetch all issues - done`, GitHubRepository.ID);

			const milestones: { milestone: IMilestone; issues: IssueModel[] }[] = [];
			let githubRepository: GitHubRepository = this;
			if (data && data.repository.milestones && data.repository.milestones.nodes) {
				data.repository.milestones.nodes.forEach(raw => {
					const milestone = parseMilestone(raw);
					if (milestone) {
						const issues: IssueModel[] = [];
						raw.issues.edges.forEach(issue => {
							const parsedIssue = parseGraphQLIssue(issue.node, this);
							githubRepository = this.getRepoForIssue(githubRepository, parsedIssue);
							issues.push(new IssueModel(githubRepository, githubRepository.remote, parsedIssue));
						});
						milestones.push({ milestone, issues });
					}
				});
			}
			return {
				items: milestones,
				hasMorePages: data.repository.milestones.pageInfo.hasNextPage,
			};
		} catch (e) {
			Logger.error(`Unable to fetch issues: ${e}`, GitHubRepository.ID);
			return;
		}
	}

	async getIssuesWithoutMilestone(_page?: number): Promise<IssueData | undefined> {
		try {
			Logger.debug(`Fetch issues without milestone- enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<IssuesResponse>({
				query: schema.IssuesWithoutMilestone,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					assignee: (await this._credentialStore.getCurrentUser(remote.authProviderId))?.login,
				},
			});
			Logger.debug(`Fetch issues without milestone - done`, GitHubRepository.ID);

			const issues: IssueModel[] = [];
			let githubRepository: GitHubRepository = this;
			if (data && data.repository.issues.edges) {
				data.repository.issues.edges.forEach(raw => {
					if (raw.node.id) {
						const parsedIssue = parseGraphQLIssue(raw.node, this);
						githubRepository = this.getRepoForIssue(githubRepository, parsedIssue);
						issues.push(new IssueModel(githubRepository, githubRepository.remote, parsedIssue));
					}
				});
			}
			return {
				items: issues,
				hasMorePages: data.repository.issues.pageInfo.hasNextPage,
			};
		} catch (e) {
			Logger.error(`Unable to fetch issues without milestone: ${e}`, GitHubRepository.ID);
			return;
		}
	}

	async getIssues(page?: number, queryString?: string): Promise<IssueData | undefined> {
		try {
			Logger.debug(`Fetch issues with query - enter`, GitHubRepository.ID);
			const { query, schema } = await this.ensure();
			const { data } = await query<IssuesSearchResponse>({
				query: schema.Issues,
				variables: {
					query: `${queryString} type:issue`,
				},
			});
			Logger.debug(`Fetch issues with query - done`, GitHubRepository.ID);

			const issues: IssueModel[] = [];
			let githubRepository: GitHubRepository = this;
			if (data && data.search.edges) {
				data.search.edges.forEach(raw => {
					if (raw.node.id) {
						const parsedIssue = parseGraphQLIssue(raw.node, this);
						githubRepository = this.getRepoForIssue(githubRepository, parsedIssue);
						issues.push(new IssueModel(githubRepository, githubRepository.remote, parsedIssue));
					}
				});
			}
			return {
				items: issues,
				hasMorePages: data.search.pageInfo.hasNextPage,
			};
		} catch (e) {
			Logger.error(`Unable to fetch issues with query: ${e}`, GitHubRepository.ID);
			return;
		}
	}

	async getMaxIssue(): Promise<number | undefined> {
		try {
			Logger.debug(`Fetch max issue - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<MaxIssueResponse>({
				query: schema.MaxIssue,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
				},
			});
			Logger.debug(`Fetch max issue - done`, GitHubRepository.ID);

			if (data && data.repository.issues.edges.length === 1) {
				return data.repository.issues.edges[0].node.number;
			}
			return;
		} catch (e) {
			Logger.error(`Unable to fetch issues with query: ${e}`, GitHubRepository.ID);
			return;
		}
	}

	async getViewerPermission(): Promise<ViewerPermission> {
		try {
			Logger.debug(`Fetch viewer permission - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<ViewerPermissionResponse>({
				query: schema.GetViewerPermission,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
				},
			});
			Logger.debug(`Fetch viewer permission - done`, GitHubRepository.ID);
			return parseGraphQLViewerPermission(data);
		} catch (e) {
			Logger.error(`Unable to fetch viewer permission: ${e}`, GitHubRepository.ID);
			return ViewerPermission.Unknown;
		}
	}

	async fork(): Promise<string | undefined> {
		try {
			Logger.debug(`Fork repository`, GitHubRepository.ID);
			const { octokit, remote } = await this.ensure();
			const result = await octokit.call(octokit.api.repos.createFork, {
				owner: remote.owner,
				repo: remote.repositoryName,
			});
			return result.data.clone_url;
		} catch (e) {
			Logger.error(`GitHubRepository> Forking repository failed: ${e}`, GitHubRepository.ID);
			return undefined;
		}
	}

	async getRepositoryForkDetails(): Promise<ForkDetails | undefined> {
		try {
			Logger.debug(`Fetch repository fork details - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();
			const { data } = await query<ForkDetailsResponse>({
				query: schema.GetRepositoryForkDetails,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
				},
			});
			Logger.debug(`Fetch repository fork details - done`, GitHubRepository.ID);
			return data.repository;
		} catch (e) {
			Logger.error(`Unable to fetch repository fork details: ${e}`, GitHubRepository.ID);
			return;
		}
	}

	async getAuthenticatedUser(): Promise<string> {
		return (await this._credentialStore.getCurrentUser(this.remote.authProviderId)).login;
	}

	async getPullRequestsForCategory(categoryQuery: string, page?: number): Promise<PullRequestData | undefined> {
		try {
			Logger.debug(`Fetch pull request category ${categoryQuery} - enter`, GitHubRepository.ID);
			const { octokit, query, schema } = await this.ensure();

			const user = await this.getAuthenticatedUser();
			// Search api will not try to resolve repo that redirects, so get full name first
			const repo = await this.getMetadata();
			const { data, headers } = await octokit.call(octokit.api.search.issuesAndPullRequests, {
				q: getPRFetchQuery(repo.full_name, user, categoryQuery),
				per_page: PULL_REQUEST_PAGE_SIZE,
				page: page || 1,
			});

			const promises: Promise<PullRequestResponse>[] = data.items.map(async (item) => {
				const prRepo = new Protocol(item.repository_url);
				const { data } = await query<PullRequestResponse>({
					query: schema.PullRequest,
					variables: {
						owner: prRepo.owner,
						name: prRepo.repositoryName,
						number: item.number
					}
				});
				return data;
			});

			const hasMorePages = !!headers.link && headers.link.indexOf('rel="next"') > -1;
			const pullRequestResponses = await Promise.all(promises);

			const pullRequests = pullRequestResponses
				.map(response => {
					if (!response.repository.pullRequest.headRef) {
						Logger.appendLine('The remote branch for this PR was already deleted.', GitHubRepository.ID);
						return null;
					}

					return this.createOrUpdatePullRequestModel(
						parseGraphQLPullRequest(response.repository.pullRequest, this),
					);
				})
				.filter(item => item !== null) as PullRequestModel[];

			Logger.debug(`Fetch pull request category ${categoryQuery} - done`, GitHubRepository.ID);

			return {
				items: pullRequests,
				hasMorePages,
			};
		} catch (e) {
			Logger.error(`Fetching all pull requests failed: ${e}`, GitHubRepository.ID);
			if (e.code === 404) {
				// not found
				vscode.window.showWarningMessage(
					`Fetching pull requests for remote ${this.remote.remoteName}, please check if the url ${this.remote.url} is valid.`,
				);
			} else {
				throw e;
			}
		}
		return undefined;
	}

	createOrUpdatePullRequestModel(pullRequest: PullRequest): PullRequestModel {
		let model = this._pullRequestModels.get(pullRequest.number);
		if (model) {
			model.update(pullRequest);
		} else {
			model = new PullRequestModel(this._telemetry, this, this.remote, pullRequest);
			model.onDidInvalidate(() => this.getPullRequest(pullRequest.number));
			this._pullRequestModels.set(pullRequest.number, model);
			this._onDidAddPullRequest.fire(model);
		}

		return model;
	}

	async createPullRequest(params: OctokitCommon.PullsCreateParams): Promise<PullRequestModel> {
		try {
			Logger.debug(`Create pull request - enter`, GitHubRepository.ID);
			const metadata = await this.getMetadata();
			const { mutate, schema } = await this.ensure();

			const { data } = await mutate<CreatePullRequestResponse>({
				mutation: schema.CreatePullRequest,
				variables: {
					input: {
						repositoryId: metadata.node_id,
						baseRefName: params.base,
						headRefName: params.head,
						title: params.title,
						body: params.body,
						draft: params.draft
					}
				}
			});
			Logger.debug(`Create pull request - done`, GitHubRepository.ID);
			if (!data) {
				throw new Error('Failed to create pull request.');
			}
			return this.createOrUpdatePullRequestModel(parseGraphQLPullRequest(data.createPullRequest.pullRequest, this));
		} catch (e) {
			Logger.error(`Unable to create PR: ${e}`, GitHubRepository.ID);
			throw e;
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
					number: id,
				},
			});
			Logger.debug(`Fetch pull request ${id} - done`, GitHubRepository.ID);
			return this.createOrUpdatePullRequestModel(parseGraphQLPullRequest(data.repository.pullRequest, this));
		} catch (e) {
			Logger.error(`Unable to fetch PR: ${e}`, GitHubRepository.ID);
			return;
		}
	}

	async getIssue(id: number, withComments: boolean = false): Promise<IssueModel | undefined> {
		try {
			Logger.debug(`Fetch issue ${id} - enter`, GitHubRepository.ID);
			const { query, remote, schema } = await this.ensure();

			const { data } = await query<PullRequestResponse>({
				query: withComments ? schema.IssueWithComments : schema.Issue,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: id,
				},
			}, true); // Don't retry on SAML errors as it's too distruptive for this query.
			Logger.debug(`Fetch issue ${id} - done`, GitHubRepository.ID);

			return new IssueModel(this, remote, parseGraphQLIssue(data.repository.pullRequest, this));
		} catch (e) {
			Logger.error(`Unable to fetch PR: ${e}`, GitHubRepository.ID);
			return;
		}
	}

	async listBranches(owner: string, repositoryName: string): Promise<string[]> {
		const { query, remote, schema } = await this.ensure();
		Logger.debug(`List branches for ${owner}/${repositoryName} - enter`, GitHubRepository.ID);

		let after: string | null = null;
		let hasNextPage = false;
		const branches: string[] = [];
		const startingTime = new Date().getTime();

		do {
			try {
				const { data } = await query<ListBranchesResponse>({
					query: schema.ListBranches,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						first: 100,
						after: after,
					},
				});

				branches.push(...data.repository.refs.nodes.map(node => node.name));
				if (new Date().getTime() - startingTime > 5000) {
					Logger.warn('List branches timeout hit.', GitHubRepository.ID);
					break;
				}
				hasNextPage = data.repository.refs.pageInfo.hasNextPage;
				after = data.repository.refs.pageInfo.endCursor;
			} catch (e) {
				Logger.debug(`List branches for ${owner}/${repositoryName} failed`, GitHubRepository.ID);
				throw e;
			}
		} while (hasNextPage);

		Logger.debug(`List branches for ${owner}/${repositoryName} - done`, GitHubRepository.ID);
		return branches;
	}

	async deleteBranch(pullRequestModel: PullRequestModel): Promise<void> {
		const { octokit } = await this.ensure();

		if (!pullRequestModel.validatePullRequestModel('Unable to delete branch')) {
			return;
		}

		try {
			await octokit.call(octokit.api.git.deleteRef, {
				owner: pullRequestModel.head.repositoryCloneUrl.owner,
				repo: pullRequestModel.head.repositoryCloneUrl.repositoryName,
				ref: `heads/${pullRequestModel.head.ref}`,
			});
		} catch (e) {
			Logger.error(`Unable to delete branch: ${e}`, GitHubRepository.ID);
			return;
		}
	}

	async getMentionableUsers(): Promise<IAccount[]> {
		Logger.debug(`Fetch mentionable users - enter`, GitHubRepository.ID);
		const { query, remote, schema } = await this.ensure();

		let after: string | null = null;
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
						after: after,
					},
				});

				ret.push(
					...result.data.repository.mentionableUsers.nodes.map(node => {
						return {
							login: node.login,
							avatarUrl: getAvatarWithEnterpriseFallback(node.avatarUrl, undefined, this.remote.authProviderId),
							name: node.name,
							url: node.url,
							email: node.email,
						};
					}),
				);

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

		let after: string | null = null;
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
						after: after,
					},
				});

				ret.push(
					...result.data.repository.assignableUsers.nodes.map(node => {
						return {
							login: node.login,
							avatarUrl: getAvatarWithEnterpriseFallback(node.avatarUrl, undefined, this.remote.authProviderId),
							name: node.name,
							url: node.url,
							email: node.email,
						};
					}),
				);

				hasNextPage = result.data.repository.assignableUsers.pageInfo.hasNextPage;
				after = result.data.repository.assignableUsers.pageInfo.endCursor;
			} catch (e) {
				Logger.debug(`Unable to fetch assignable users: ${e}`, GitHubRepository.ID);
				if (
					e.graphQLErrors &&
					e.graphQLErrors.length > 0 &&
					e.graphQLErrors[0].type === 'INSUFFICIENT_SCOPES'
				) {
					vscode.window.showWarningMessage(
						`GitHub user features will not work. ${e.graphQLErrors[0].message}`,
					);
				}
				return ret;
			}
		} while (hasNextPage);

		return ret;
	}

	async getOrgTeamsCount(): Promise<number> {
		Logger.debug(`Fetch Teams Count - enter`, GitHubRepository.ID);
		const { query, remote, schema } = await this.ensure();

		try {
			const result: { data: OrganizationTeamsCountResponse } = await query<OrganizationTeamsCountResponse>({
				query: schema.GetOrganizationTeamsCount,
				variables: {
					login: remote.owner
				},
			});
			return result.data.organization.teams.totalCount;
		} catch (e) {
			Logger.debug(`Unable to fetch teams Count: ${e}`, GitHubRepository.ID);
			if (
				e.graphQLErrors &&
				e.graphQLErrors.length > 0 &&
				e.graphQLErrors[0].type === 'INSUFFICIENT_SCOPES'
			) {
				vscode.window.showWarningMessage(
					`GitHub teams features will not work. ${e.graphQLErrors[0].message}`,
				);
			}
			return 0;
		}
	}

	async getTeams(): Promise<ITeam[]> {
		Logger.debug(`Fetch Teams - enter`, GitHubRepository.ID);
		const { query, remote, schema } = await this.ensure();

		let after: string | null = null;
		let hasNextPage = false;
		const ret: ITeam[] = [];

		do {
			try {
				const result: { data: OrganizationTeamsResponse } = await query<OrganizationTeamsResponse>({
					query: schema.GetOrganizationTeams,
					variables: {
						login: remote.owner,
						after: after,
						repoName: remote.repositoryName,
					},
				});

				result.data.organization.teams.nodes.forEach(node => {
					if (node.repositories.nodes.find(repo => repo.name === remote.repositoryName)) {
						ret.push({
							avatarUrl: getAvatarWithEnterpriseFallback(node.avatarUrl, undefined, this.remote.authProviderId),
							name: node.name,
							url: node.url,
							slug: node.slug,
							id: node.id,
							org: remote.owner
						});
					}
				});

				hasNextPage = result.data.organization.teams.pageInfo.hasNextPage;
				after = result.data.organization.teams.pageInfo.endCursor;
			} catch (e) {
				Logger.debug(`Unable to fetch teams: ${e}`, GitHubRepository.ID);
				if (
					e.graphQLErrors &&
					e.graphQLErrors.length > 0 &&
					e.graphQLErrors[0].type === 'INSUFFICIENT_SCOPES'
				) {
					vscode.window.showWarningMessage(
						`GitHub teams features will not work. ${e.graphQLErrors[0].message}`,
					);
				}
				return ret;
			}
		} while (hasNextPage);

		return ret;
	}

	async getPullRequestParticipants(pullRequestNumber: number): Promise<IAccount[]> {
		Logger.debug(`Fetch participants from a Pull Request`, GitHubRepository.ID);
		const { query, remote, schema } = await this.ensure();

		const ret: IAccount[] = [];

		try {
			const result: { data: PullRequestParticipantsResponse } = await query<PullRequestParticipantsResponse>({
				query: schema.GetParticipants,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: pullRequestNumber,
					first: 18
				},
			});

			ret.push(
				...result.data.repository.pullRequest.participants.nodes.map(node => {
					return {
						login: node.login,
						avatarUrl: getAvatarWithEnterpriseFallback(node.avatarUrl, undefined, this.remote.authProviderId),
						name: node.name,
						url: node.url,
						email: node.email,
					};
				}),
			);
		} catch (e) {
			Logger.debug(`Unable to fetch participants from a PullRequest: ${e}`, GitHubRepository.ID);
			if (
				e.graphQLErrors &&
				e.graphQLErrors.length > 0 &&
				e.graphQLErrors[0].type === 'INSUFFICIENT_SCOPES'
			) {
				vscode.window.showWarningMessage(
					`GitHub user features will not work. ${e.graphQLErrors[0].message}`,
				);
			}
		}

		return ret;
	}

	/**
	 * Compare across commits.
	 * @param base The base branch. Must be a branch name. If comparing across repositories, use the format <repo_owner>:branch.
	 * @param head The head branch. Must be a branch name. If comparing across repositories, use the format <repo_owner>:branch.
	 */
	public async compareCommits(base: string, head: string): Promise<OctokitCommon.ReposCompareCommitsResponseData | undefined> {
		try {
			const { remote, octokit } = await this.ensure();
			const { data } = await octokit.call(octokit.api.repos.compareCommits, {
				repo: remote.repositoryName,
				owner: remote.owner,
				base,
				head,
			});

			return data;
		} catch (e) {
			Logger.error(`Unable to compare commits between ${base} and ${head}: ${e}`, GitHubRepository.ID);
		}
	}

	isCurrentUser(login: string): Promise<boolean> {
		return this._credentialStore.isCurrentUser(login);
	}

	/**
	 * Get the status checks of the pull request, those for the last commit.
	 *
	 * This method should go in PullRequestModel, but because of the status checks bug we want to track `_useFallbackChecks` at a repo level.
	 */
	private _useFallbackChecks: boolean = false;
	async getStatusChecks(number: number): Promise<PullRequestChecks | undefined> {
		const { query, remote, schema } = await this.ensure();
		const captureUseFallbackChecks = this._useFallbackChecks;
		let result;
		try {
			result = await query<GetChecksResponse>({
				query: captureUseFallbackChecks ? schema.GetChecksWithoutSuite : schema.GetChecks,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: number,
				},
			}, true); // There's an issue with the GetChecks that can result in SAML errors.
		} catch (e) {
			if (e.message?.startsWith('GraphQL error: Resource protected by organization SAML enforcement.')) {
				// There seems to be an issue with fetching status checks if you haven't SAML'd with every org you have
				// The issue is specifically with the CheckSuite property. Make the query again, but without that property.
				if (!captureUseFallbackChecks) {
					this._useFallbackChecks = true;
					return this.getStatusChecks(number);
				}
			}
			throw e;
		}

		// We always fetch the status checks for only the last commit, so there should only be one node present
		const statusCheckRollup = result.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup;

		if (!statusCheckRollup) {
			return undefined;
		}

		const checks: PullRequestChecks = {
			state: statusCheckRollup.state.toLowerCase(),
			statuses: statusCheckRollup.contexts.nodes.map(context => {
				if (isCheckRun(context)) {
					return {
						id: context.id,
						url: context.checkSuite?.app?.url,
						avatar_url: context.checkSuite?.app?.logoUrl,
						state: context.conclusion?.toLowerCase() || CheckState.Pending,
						description: context.title,
						context: context.name,
						target_url: context.detailsUrl,
					};
				} else {
					return {
						id: context.id,
						url: context.targetUrl,
						avatar_url: context.avatarUrl,
						state: context.state?.toLowerCase(),
						description: context.description,
						context: context.context,
						target_url: context.targetUrl,
					};
				}
			}),
		};


		return checks;
	}
}
