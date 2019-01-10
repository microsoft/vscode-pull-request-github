/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as Github from '@octokit/rest';
import { CredentialStore } from './credentials';
import { Comment } from '../common/comment';
import { Remote, parseRepositoryRemotes } from '../common/remote';
import { TimelineEvent, EventType, isReviewEvent, isCommitEvent } from '../common/timelineEvent';
import { GitHubRepository, PULL_REQUEST_PAGE_SIZE } from './githubRepository';
import { IPullRequestsPagingOptions, PRType, ReviewEvent, ITelemetry, IPullRequestEditData, PullRequest, IRawFileChange } from './interface';
import { PullRequestGitHelper } from './pullRequestGitHelper';
import { PullRequestModel } from './pullRequestModel';
import { parserCommentDiffHunk } from '../common/diffHunk';
import { GitHubManager } from '../authentication/githubServer';
import { formatError, uniqBy, Predicate } from '../common/utils';
import { Repository, RefType, UpstreamRef, Branch } from '../typings/git';
import Logger from '../common/logger';

const queries = require('./queries.gql');

interface PageInformation {
	pullRequestPage: number;
	hasMorePages: boolean;
}

interface RestErrorResult {
	errors: RestError[];
	message: string;
}

interface RestError {
	code: string;
	field: string;
	resource: string;
}
export class NoGitHubReposError extends Error {
	constructor(public repository: Repository) {
		super();
	}

	get message() {
		return `${this.repository.rootUri.toString()} has no GitHub remotes`;
	}
}

export class DetachedHeadError extends Error {
	constructor(public repository: Repository) {
		super();
	}

	get message() {
		return `${this.repository.rootUri.toString()} has a detached HEAD (create a branch first)`;
	}
}

export class BadUpstreamError extends Error {
	constructor(
		public branchName: string,
		public upstreamRef: UpstreamRef,
		public problem: string) {
		super();
	}

	get message() {
		const { upstreamRef: { remote, name }, branchName, problem } = this;
		return `The upstream ref ${remote}/${name} for branch ${branchName} ${problem}.`;
	}
}

const SETTINGS_NAMESPACE = 'githubPullRequests';
const LOG_LEVEL_SETTING = 'includeRemotes';

const enum IncludeRemote {
	Default,
	All
}

interface NewCommentPosition {
	path: string;
	position: number;
}

interface ReplyCommentPosition {
	inReplyTo: string;
}

export class PullRequestManager {
	static ID = 'PullRequestManager';
	private _activePullRequest?: PullRequestModel;
	private _credentialStore: CredentialStore;
	private _githubRepositories: GitHubRepository[];
	private _githubManager: GitHubManager;
	private _repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();
	private _includeRemotes: IncludeRemote;

	private _onDidChangeActivePullRequest = new vscode.EventEmitter<void>();
	readonly onDidChangeActivePullRequest: vscode.Event<void> = this._onDidChangeActivePullRequest.event;

	constructor(
		private _repository: Repository,
		private readonly _telemetry: ITelemetry,
	) {
		this._githubRepositories = [];
		this._credentialStore = new CredentialStore(this._telemetry);
		this._githubManager = new GitHubManager();
		this._includeRemotes = IncludeRemote.Default;
		vscode.workspace.onDidChangeConfiguration(() => {
			let oldIncludeRemote = this._includeRemotes;
			this.getIncludeRemoteConfig();
			if (this._includeRemotes !== oldIncludeRemote) {
				this.updateRepositories();
			}
		});
		this.getIncludeRemoteConfig();
	}

	private getIncludeRemoteConfig() {
		let includeRemotes = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>(LOG_LEVEL_SETTING);
		switch (includeRemotes) {
			case 'default':
				this._includeRemotes = IncludeRemote.Default;
				break;
			case 'all':
				this._includeRemotes = IncludeRemote.All;
			default:
				break;
		}
	}

	get activePullRequest() {
		return this._activePullRequest;
	}

	set activePullRequest(pullRequest: PullRequestModel) {
		this._activePullRequest = pullRequest;
		this._onDidChangeActivePullRequest.fire();
	}

	get repository(): Repository {
		return this._repository;
	}

	set repository(repository: Repository) {
		this._repository = repository;
	}

	async clearCredentialCache(): Promise<void> {
		this._credentialStore.reset();
	}

	async updateRepositories(): Promise<void> {
		Logger.debug('update repositories', PullRequestManager.ID);
		const remotes = parseRepositoryRemotes(this.repository);
		const potentialRemotes = remotes.filter(remote => remote.host);
		let gitHubRemotes = await Promise.all(potentialRemotes.map(remote => this._githubManager.isGitHub(remote.gitProtocol.normalizeUri())))
			.then(results => potentialRemotes.filter((_, index, __) => results[index]))
			.catch(e => {
				Logger.appendLine(`Resolving GitHub remotes failed: ${formatError(e)}`);
				vscode.window.showErrorMessage(`Resolving GitHub remotes failed: ${formatError(e)}`);
				return [];
			});
		gitHubRemotes = uniqBy(gitHubRemotes, remote => remote.gitProtocol.normalizeUri().toString());

		if (gitHubRemotes.length) {
			await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', true);
			Logger.appendLine('Found GitHub remote');
		} else {
			await vscode.commands.executeCommand('setContext', 'github:hasGitHubRemotes', false);
			Logger.appendLine('No GitHub remotes found');
			return;
		}

		let serverAuthPromises = [];
		for (let server of uniqBy(gitHubRemotes, remote => remote.gitProtocol.normalizeUri().authority)) {
			serverAuthPromises.push(this._credentialStore.hasOctokit(server).then(authd => {
				if (!authd) {
					this._credentialStore.loginWithConfirmation(server);
				}
			}));
		}
		// Make sure authentication is set up for all the servers that the remotes are pointing to
		// this will ask the user to sign in if there's no credentials for a server, once per server
		await Promise.all(serverAuthPromises).catch(e => {
			Logger.appendLine(`serverAuthPromises failed: ${formatError(e)}`);
		});

		let repositories = [];
		let resolveRemotePromises = [];
		let userCreatedRemoteNames = this._includeRemotes === IncludeRemote.All ? (gitHubRemotes as Remote[]) : await PullRequestGitHelper.getUserCreatedRemotes(this.repository, (gitHubRemotes as Remote[]));

		userCreatedRemoteNames.forEach(remote => {
			const repository = new GitHubRepository(remote, this._credentialStore);
			resolveRemotePromises.push(repository.resolveRemote());
			repositories.push(repository);
		});

		return Promise.all(resolveRemotePromises).then(_ => {
			const oldRepositories = this._githubRepositories;
			this._githubRepositories = repositories;
			oldRepositories.forEach(repo => repo.dispose());

			for (let repository of this._githubRepositories) {
				const remoteId = repository.remote.url.toString();
				if (!this._repositoryPageInformation.get(remoteId)) {
					this._repositoryPageInformation.set(remoteId, {
						pullRequestPage: 1,
						hasMorePages: null
					});
				}
			}

			return Promise.resolve();
		});
	}

	getGitHubRemotes(): Remote[] {
		const githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		return githubRepositories.map(repository => repository.remote);
	}

	async authenticate(): Promise<boolean> {
		let ret = false;
		this._credentialStore.reset();
		for (let repository of uniqBy(this._githubRepositories, x => x.remote.normalizedHost)) {
			ret = await repository.authenticate() || ret;
		}
		return ret;
	}

	async getLocalPullRequests(): Promise<PullRequestModel[]> {
		const githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [];
		}

		const localBranches = this.repository.state.refs
			.filter(r => r.type === RefType.Head && r.name)
			.map(r => r.name);

		const promises = localBranches.map(async localBranchName => {
			const matchingPRMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this.repository, localBranchName);

			if (matchingPRMetadata) {
				const { owner, prNumber } = matchingPRMetadata;
				const githubRepo = githubRepositories.find(repo => repo.remote.owner.toLocaleLowerCase() === owner.toLocaleLowerCase());

				if (githubRepo) {
					const pullRequest: PullRequestModel = await githubRepo.getPullRequest(prNumber);

					if (pullRequest) {
						pullRequest.localBranchName = localBranchName;
						return pullRequest;
					}
				}
			}

			return Promise.resolve(null);
		});

		return Promise.all(promises).then(values => {
			return values.filter(value => value !== null);
		});
	}

	async deleteLocalPullRequest(pullRequest: PullRequestModel, force?: boolean): Promise<void> {
		await this.repository.deleteBranch(pullRequest.localBranchName, force);

		let remoteName: string = null;
		try {
			remoteName = await this.repository.getConfig(`branch.${pullRequest.localBranchName}.remote`);
		} catch (e) {}

		if (!remoteName) {
			return;
		}

		// If the extension created a remote for the branch, remove it if there are no other branches associated with it
		const isPRRemote = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this.repository, remoteName);
		if (isPRRemote) {
			const configs = await this.repository.getConfigs();
			const hasOtherAssociatedBranches = configs
				.some(({ key, value }) => /^branch.*\.remote$/.test(key) && value === remoteName);

			if (!hasOtherAssociatedBranches) {
				await this.repository.removeRemote(remoteName);
			}
		}
		this._telemetry.on('branch.delete');
	}

	async getPullRequests(type: PRType, options: IPullRequestsPagingOptions = { fetchNextPage: false }): Promise<[PullRequestModel[], boolean]> {
		let githubRepositories = this._githubRepositories;

		if (!githubRepositories || !githubRepositories.length) {
			return [[], false];
		}

		if (!options.fetchNextPage) {
			for (let repository of this._githubRepositories) {
				this._repositoryPageInformation.set(repository.remote.url.toString(), {
					pullRequestPage: 1,
					hasMorePages: null
				});
			}
		}

		githubRepositories = githubRepositories.filter(repo => this._repositoryPageInformation.get(repo.remote.url.toString()).hasMorePages !== false);

		let pullRequests: PullRequestModel[] = [];
		let numPullRequests = 0;
		let hasMorePages = false;

		for (let i = 0; i < githubRepositories.length; i++) {
			if (numPullRequests >= PULL_REQUEST_PAGE_SIZE) {
				hasMorePages = true;
				break;
			}

			const githubRepository = githubRepositories[i];
			const remote = githubRepository.remote.remoteName;
			const shouldLoad = this._includeRemotes === IncludeRemote.All || !(await PullRequestGitHelper.isRemoteCreatedForPullRequest(this.repository, remote));
			if (shouldLoad) {
				const pageInformation = this._repositoryPageInformation.get(githubRepository.remote.url.toString());
				while (numPullRequests < PULL_REQUEST_PAGE_SIZE && pageInformation.hasMorePages !== false) {
					const pullRequestData = await githubRepository.getPullRequests(type, pageInformation.pullRequestPage);
					if (!pullRequestData) {
						break;
					}
					numPullRequests += pullRequestData.pullRequests.length;
					pullRequests = pullRequests.concat(...pullRequestData.pullRequests);

					pageInformation.hasMorePages = pullRequestData.hasMorePages;
					hasMorePages = hasMorePages || pageInformation.hasMorePages;
					pageInformation.pullRequestPage++;
				}
			}
		}

		return [pullRequests, hasMorePages];
	}

	public mayHaveMorePages(): boolean {
		return this._githubRepositories.some(repo => this._repositoryPageInformation.get(repo.remote.url.toString()).hasMorePages !== false);
	}

	async getStatusChecks(pullRequest: PullRequestModel): Promise<Github.ReposGetCombinedStatusForRefResponse> {
		const { remote, octokit } = await pullRequest.githubRepository.ensure();

		const result = await octokit.repos.getCombinedStatusForRef({
			owner: remote.owner,
			repo: remote.repositoryName,
			ref: pullRequest.head.sha
		});

		return result.data;
	}

	async getPullRequestComments(pullRequest: PullRequestModel): Promise<Comment[]> {
		const { supportsGraphQl } = pullRequest.githubRepository;
		return supportsGraphQl
			? this.getAllPullRequestReviewComments(pullRequest)
			: this.getPullRequestReviewComments(pullRequest);
	}

	private async getAllPullRequestReviewComments(pullRequest: PullRequestModel): Promise<Comment[]> {
		const { remote, query } = await pullRequest.githubRepository.ensure();
		try {
			const { data } = await query({
				query: queries.PullRequestComments,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: pullRequest.prNumber,
				}
			});

			const comments = data.repository.pullRequest.reviews.nodes
				.map(node => node.comments.nodes.map(comment => this.addCommentPermissions(toComment(comment), remote)))
				.reduce((prev, curr) => prev.concat(curr), []);
			return parserCommentDiffHunk(comments);
		} catch (e) {
			Logger.appendLine(`Failed to get pull request review comments: ${formatError(e)}`);
		}
	}

	/**
	 * Returns review comments from the pull request using the REST API, comments on pending reviews are not included.
	 */
	private async getPullRequestReviewComments(pullRequest: PullRequestModel): Promise<Comment[]> {
		Logger.debug(`Fetch comments of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const { remote, octokit } = await (pullRequest as PullRequestModel).githubRepository.ensure();
		const reviewData = await octokit.pullRequests.getComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});
		Logger.debug(`Fetch comments of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);
		const rawComments = reviewData.data.map(comment => this.addCommentPermissions(comment, remote));
		return parserCommentDiffHunk(rawComments);
	}

	async getPullRequestCommits(pullRequest: PullRequestModel): Promise<Github.PullRequestsGetCommitsResponseItem[]> {
		try {
			Logger.debug(`Fetch commits of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
			const { remote, octokit } = await pullRequest.githubRepository.ensure();
			const commitData = await octokit.pullRequests.getCommits({
				number: pullRequest.prNumber,
				owner: remote.owner,
				repo: remote.repositoryName
			});
			Logger.debug(`Fetch commits of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);

			return commitData.data;
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commits failed: ${formatError(e)}`);
			return [];
		}
	}

	async getCommitChangedFiles(pullRequest: PullRequestModel, commit: Github.PullRequestsGetCommitsResponseItem): Promise<Github.ReposGetCommitResponseFilesItem[]> {
		try {
			Logger.debug(`Fetch file changes of commit ${commit.sha} in PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
			const { octokit, remote } = await pullRequest.githubRepository.ensure();
			const fullCommit = await octokit.repos.getCommit({
				owner: remote.owner,
				repo: remote.repositoryName,
				sha: commit.sha
			});
			Logger.debug(`Fetch file changes of commit ${commit.sha} in PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);

			return fullCommit.data.files.filter(file => !!file.patch);
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commit file changes failed: ${formatError(e)}`);
			return [];
		}
	}

	async getTimelineEvents(pullRequest: PullRequestModel): Promise<TimelineEvent[]> {
		Logger.debug(`Fetch timeline events of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		let ret = await octokit.issues.getEventsTimeline({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});
		Logger.debug(`Fetch timeline events of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);

		return await this.parseTimelineEvents(pullRequest, remote, ret.data);
	}

	async getIssueComments(pullRequest: PullRequestModel): Promise<Github.IssuesGetCommentsResponseItem[]> {
		Logger.debug(`Fetch issue comments of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		const promise = await octokit.issues.getComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});
		Logger.debug(`Fetch issue comments of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);

		return promise.data;
	}

	async createIssueComment(pullRequest: PullRequestModel, text: string): Promise<Github.IssuesCreateCommentResponse> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		const promise = await octokit.issues.createComment({
			body: text,
			number: pullRequest.prNumber,
			owner: remote.owner,
			repo: remote.repositoryName
		});

		return this.addCommentPermissions(promise.data as Comment, remote);
	}

	async createCommentReply(pullRequest: PullRequestModel, body: string, reply_to: Comment): Promise<Comment> {
		const pendingReviewId = await this.getPendingReviewId(pullRequest);
		if (pendingReviewId) {
			return this.addCommentToPendingReview(pullRequest, pendingReviewId, body, { inReplyTo: reply_to.node_id });
		}

		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		try {
			let ret = await octokit.pullRequests.createCommentReply({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber,
				body: body,
				in_reply_to: Number(reply_to.id)
			});

			return this.addCommentPermissions(ret.data, remote);
		} catch (e) {
			this.handleError(e);
		}
	}

	async deleteReview(pullRequest: PullRequestModel): Promise<Comment[]> {
		const pendingReviewId = await this.getPendingReviewId(pullRequest);
		const { mutate } = await pullRequest.githubRepository.ensure();
		const { data } = await mutate<any>({
			mutation: queries.DeleteReview,
			variables: {
				input: { pullRequestReviewId: pendingReviewId }
			}
		});

		return data.deletePullRequestReview.pullRequestReview.comments.nodes.map(toComment);
	}

	async startReview(pullRequest: PullRequestModel): Promise<void> {
		const { mutate } = await pullRequest.githubRepository.ensure();
		return mutate<void>({
			mutation: queries.StartReview,
			variables: {
				input: {
					body: '',
					pullRequestId: pullRequest.prItem.node_id
				}
			}
		}).then(x => x.data).catch(e => {
			Logger.appendLine(`Failed to start review: ${e.message}`);
		});
	}

	async inDraftMode(pullRequest: PullRequestModel): Promise<boolean> {
		return !!await this.getPendingReviewId(pullRequest);
	}

	async getPendingReviewId(pullRequest = this._activePullRequest): Promise<string | null> {
		if (!pullRequest.githubRepository.supportsGraphQl()) {
			return null;
		}

		const { query, octokit } = await pullRequest.githubRepository.ensure();
		const { currentUser = '' } = octokit as any;
		try {
			const { data } = await query({
				query: queries.GetPendingReviewId,
				variables: {
					pullRequestId: (pullRequest as PullRequestModel).prItem.node_id,
					author: currentUser.login
				}
			});
			return data.node.reviews.nodes[0].id;
		} catch (error) {
			return null;
		}
	}

	async addCommentToPendingReview(pullRequest: PullRequestModel, reviewId: string, body: string, position: NewCommentPosition | ReplyCommentPosition): Promise<Comment> {
		const { mutate, remote } = await pullRequest.githubRepository.ensure();
		const { data } = await mutate({
			mutation: queries.AddComment,
			variables: {
				input: {
					pullRequestReviewId: reviewId,
					body,
					...position
				}
			}
		});

		const { comment } = data.addPullRequestReviewComment;
		return this.addCommentPermissions(toComment(comment), remote);
	}

	async createComment(pullRequest: PullRequestModel, body: string, path: string, position: number): Promise<Comment> {
		const pendingReviewId = await this.getPendingReviewId(pullRequest as PullRequestModel);
		if (pendingReviewId) {
			return this.addCommentToPendingReview(pullRequest as PullRequestModel, pendingReviewId, body, { path, position });
		}

		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		try {
			let ret = await octokit.pullRequests.createComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber,
				body: body,
				commit_id: pullRequest.head.sha,
				path: path,
				position: position
			});

			return this.addCommentPermissions(ret.data, remote);
		} catch (e) {
			this.handleError(e);
		}
	}

	async getPullRequestDefaults(): Promise<Github.PullRequestsCreateParams> {
		if (!this.repository.state.HEAD) {
			throw new DetachedHeadError(this.repository);
		}
		const { origin } = this;
		const meta = await origin.getMetadata();
		const parent = meta.fork
			? meta.parent
			: await (this.findRepo(byRemoteName('upstream')) || origin).getMetadata();
		const branchName = this.repository.state.HEAD.name;
		const { title, body } = titleAndBodyFrom(await this.getHeadCommitMessage());
		return {
			title, body,
			owner: parent.owner.login,
			repo: parent.name,
			head: `${meta.owner.login}:${branchName}`,
			base: parent.default_branch,
		};
	}

	async getMetadata(remote: string): Promise<any> {
		const repo = this.findRepo(byRemoteName(remote));
		return repo && repo.getMetadata();
	}

	async getHeadCommitMessage(): Promise<string> {
		const { repository } = this;
		const { message } = await repository.getCommit(repository.state.HEAD.commit);
		return message;
	}

	get origin(): GitHubRepository {
		if (!this._githubRepositories.length) {
			throw new NoGitHubReposError(this.repository);
		}

		const { upstreamRef } = this;
		if (upstreamRef) {
			// If our current branch has an upstream ref set, find its GitHubRepository.
			const upstream = this.findRepo(byRemoteName(upstreamRef.remote));
			if (!upstream) {
				// No GitHubRepository? We currently won't try pushing elsewhere,
				// so fail.
				throw new BadUpstreamError(
					this.repository.state.HEAD.name,
					upstreamRef,
					'is not a GitHub repo');
			}
			// Otherwise, we'll push upstream.
			return upstream;
		}

		// If no upstream is set, let's go digging.
		const [first, ...rest] = this._githubRepositories;
		return !rest.length  // Is there only one GitHub remote?
			? first // I GUESS THAT'S WHAT WE'RE GOING WITH, THEN.
			:  // Otherwise, let's try...
			this.findRepo(byRemoteName('origin')) || // by convention
			this.findRepo(ownedByMe) ||              // bc maybe we can push there
			first; // out of raw desperation
	}

	findRepo(where: Predicate<GitHubRepository>): GitHubRepository | undefined {
		return this._githubRepositories.filter(where)[0];
	}

	get upstreamRef(): UpstreamRef | undefined {
		const { HEAD } = this.repository.state;
		return HEAD && HEAD.upstream;
	}

	async createPullRequest(params: Github.PullRequestsCreateParams): Promise<PullRequestModel> {
		try {
			const repo = this._githubRepositories.find(r => r.remote.owner === params.owner && r.remote.repositoryName === params.repo);
			if (!repo) {
				throw new Error(`No matching repository ${params.repo} found for ${params.owner}`);
			}

			await repo.ensure();

			const { title, body } = titleAndBodyFrom(await this.getHeadCommitMessage());
			if (!params.title) {
				params.title = title;
			}

			if (!params.body) {
				params.body = body;
			}

			// Create PR
			let { data } = await repo.octokit.pullRequests.create(params);

			const item: PullRequest = {
				number: data.number,
				body: data.body,
				title: data.title,
				html_url: data.html_url,
				user: data.user,
				labels: [],
				state: data.state,
				merged: false,
				assignee: data.assignee,
				created_at: data.created_at,
				updated_at: data.updated_at,
				head: data.head,
				base: data.base,
				node_id: data.node_id
			};

			const pullRequestModel = new PullRequestModel(repo, repo.remote, item);

			const branchNameSeparatorIndex = params.head.indexOf(':');
			const branchName = params.head.slice(branchNameSeparatorIndex + 1);
			await PullRequestGitHelper.associateBranchWithPullRequest(this._repository, pullRequestModel, branchName);

			return pullRequestModel;
		} catch (e) {
			Logger.appendLine(`GitHubRepository> Creating pull requests failed: ${e}`);
			vscode.window.showWarningMessage(`Creating pull requests for '${params.head}' failed: ${formatError(e)}`);
			return null;
		}
	}

	async editIssueComment(pullRequest: PullRequestModel, commentId: string, text: string): Promise<Comment> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			const ret = await octokit.issues.editComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				body: text,
				comment_id: Number(commentId)
			});

			return this.addCommentPermissions(ret.data as Comment, remote);
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async editReviewComment(pullRequest: PullRequestModel, commentId: string, text: string): Promise<Comment> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			const ret = await octokit.pullRequests.editComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				body: text,
				comment_id: Number(commentId)
			});

			return this.addCommentPermissions(ret.data, remote);
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async deleteIssueComment(pullRequest: PullRequestModel, commentId: string): Promise<void> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			await octokit.issues.deleteComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				comment_id: Number(commentId)
			});
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async deleteReviewComment(pullRequest: PullRequestModel, commentId: string): Promise<void> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			await octokit.pullRequests.deleteComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				comment_id: Number(commentId)
			});
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	canEditPullRequest(pullRequest: PullRequestModel): boolean {
		const username = pullRequest.author && pullRequest.author.login;
		return this._credentialStore.isCurrentUser(username, pullRequest.remote);
	}

	private addCommentPermissions<T extends Pick<Comment, 'canEdit' | 'canDelete' | 'position' | 'user'>>(
		rawComment: T,
		remote: Remote
	): T {
		const isCurrentUser = this._credentialStore.isCurrentUser(rawComment.user.login, remote);
		const notOutdated = rawComment.position !== null;
		rawComment.canEdit = isCurrentUser && notOutdated;
		rawComment.canDelete = isCurrentUser && notOutdated;

		return rawComment;
	}

	private async changePullRequestState(state: 'open' | 'closed', pullRequest: PullRequestModel): Promise<Github.PullRequestsUpdateResponse> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		let ret = await octokit.pullRequests.update({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			state: state
		});

		return ret.data;
	}

	async editPullRequest(pullRequest: PullRequestModel, toEdit: IPullRequestEditData): Promise<Github.PullRequestsUpdateResponse> {
		try {
			const { octokit, remote } = await pullRequest.githubRepository.ensure();
			const { data } = await octokit.pullRequests.update({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber,
				body: toEdit.body,
				title: toEdit.title
			});
			return data;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async closePullRequest(pullRequest: PullRequestModel): Promise<any> {
		return this.changePullRequestState('closed', pullRequest)
			.then(x => {
				this._telemetry.on('pr.close');
				return x;
			});
	}

	async mergePullRequest(pullRequest: PullRequestModel): Promise<any> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();
		return await octokit.pullRequests.merge({
			commit_message: '',
			commit_title: '',
			merge_method: 'merge',
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
		})
			.then(x => {
				this._telemetry.on('pr.merge');
				return x.data;
			});
	}

	private async createReview(pullRequest: PullRequestModel, event: ReviewEvent, message?: string): Promise<Github.PullRequestsCreateReviewResponse> {
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		let ret = await octokit.pullRequests.createReview({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			event: event,
			body: message,
		});

		return ret.data;
	}

	public async submitReview(pullRequest: PullRequestModel, event='COMMENT'): Promise<Comment[]> {
		const pendingReviewId = await this.getPendingReviewId(pullRequest);
		const { mutate } = await pullRequest.githubRepository.ensure();

		if (pendingReviewId) {
			const { data } = await mutate({
				mutation: queries.SubmitReview,
				variables: {
					id: pendingReviewId,
					event,
				}
			});

			return data.submitPullRequestReview.pullRequestReview.comments.nodes.map(toComment);
		} else {
			Logger.appendLine(`Submitting review failed, no pending review for current pull request: ${pullRequest.prNumber}.`);
		}
	}

	async requestChanges(pullRequest: PullRequestModel, message?: string): Promise<any> {
		const action: Promise<any> = await this.getPendingReviewId(pullRequest)
				? this.submitReview(pullRequest, 'REQUEST_CHANGES')
				: this.createReview(pullRequest, ReviewEvent.RequestChanges, message);

		return action
			.then(x => {
				this._telemetry.on('pr.requestChanges');
				return x;
			});
	}

	async approvePullRequest(pullRequest: PullRequestModel, message?: string): Promise<any> {
		const action: Promise<any> = await this.getPendingReviewId(pullRequest)
				? this.submitReview(pullRequest, 'APPROVE')
				: this.createReview(pullRequest, ReviewEvent.Approve, message);
		return action.then(x => {
			this._telemetry.on('pr.approve');
			return x;
		});
	}

	async getPullRequestFileChangesInfo(pullRequest: PullRequestModel): Promise<IRawFileChange[]> {
		Logger.debug(`Fetch file changes, base, head and merge base of PR #${pullRequest.prNumber} - enter`, PullRequestManager.ID);
		const { octokit, remote } = await pullRequest.githubRepository.ensure();

		if (!pullRequest.base) {
			const info = await octokit.pullRequests.get({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber
			});
			pullRequest.update(info.data);
		}

		const { data } = await octokit.repos.compareCommits({
			repo: remote.repositoryName,
			owner: remote.owner,
			base: `${pullRequest.base.repositoryCloneUrl.owner}:${pullRequest.base.ref}`,
			head: `${pullRequest.head.repositoryCloneUrl.owner}:${pullRequest.head.ref}`
		});

		pullRequest.mergeBase = data.merge_base_commit.sha;

		Logger.debug(`Fetch file changes and merge base of PR #${pullRequest.prNumber} - done`, PullRequestManager.ID);
		return data.files;
	}

	async getPullRequestRepositoryDefaultBranch(pullRequest: PullRequestModel): Promise<string> {
		const branch = await pullRequest.githubRepository.getDefaultBranch();
		return branch;
	}

	async fullfillPullRequestMissingInfo(pullRequest: PullRequestModel): Promise<void> {
		try {
			Logger.debug(`Fullfill pull request missing info - start`, PullRequestManager.ID);
			const { octokit, remote } = await pullRequest.githubRepository.ensure();

			if (!pullRequest.base) {
				const { data } = await octokit.pullRequests.get({
					owner: remote.owner,
					repo: remote.repositoryName,
					number: pullRequest.prNumber
				});
				pullRequest.update(data);
			}

			if (!pullRequest.mergeBase) {
				const { data } = await octokit.repos.compareCommits({
					repo: remote.repositoryName,
					owner: remote.owner,
					base: `${pullRequest.base.repositoryCloneUrl.owner}:${pullRequest.base.ref}`,
					head: `${pullRequest.head.repositoryCloneUrl.owner}:${pullRequest.head.ref}`
				});

				pullRequest.mergeBase = data.merge_base_commit.sha;
			}
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching Pull Request merge base failed: ${formatError(e)}`);
		}
		Logger.debug(`Fullfill pull request missing info - done`, PullRequestManager.ID);
	}

	//#region Git related APIs

	async resolvePullRequest(owner: string, repositoryName: string, pullReuqestNumber: number): Promise<PullRequestModel> {
		const githubRepo = this._githubRepositories.find(repo =>
			repo.remote.owner.toLowerCase() === owner.toLowerCase() && repo.remote.repositoryName.toLowerCase() === repositoryName.toLowerCase()
		);

		if (!githubRepo) {
			return null;
		}

		const pr = await githubRepo.getPullRequest(pullReuqestNumber);
		return pr;
	}

	async getMatchingPullRequestMetadataForBranch() {
		if (!this.repository || !this.repository.state.HEAD) {
			return null;
		}

		const HEAD = this.repository.state.HEAD;
		let matchingPullRequestMetadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(this.repository, HEAD.name);
		return matchingPullRequestMetadata;
	}

	async checkoutExistingPullRequestBranch(pullRequest: PullRequestModel): Promise<boolean> {
		return await PullRequestGitHelper.checkoutExistingPullRequestBranch(this.repository, this._githubRepositories, pullRequest);
	}

	async fetchAndCheckout(pullRequest: PullRequestModel): Promise<void> {
		await PullRequestGitHelper.fetchAndCheckout(this.repository, this._githubRepositories, pullRequest);
	}

	async getBranch(remote: Remote, branchName: string): Promise<Branch> {
		let githubRepository = this.findRepo(byRemoteName(remote.remoteName));
		if (githubRepository) {
			let githubBranch = await githubRepository.getBranch(branchName);

			if (githubBranch) {
				return {
					name: githubBranch.name,
					type: RefType.RemoteHead
				};
			}
		}

		return null;
	}

	async checkout(branchName: string): Promise<void> {
		return this.repository.checkout(branchName);
	}

	private handleError(e: any) {
		if (e.code && e.code === 422) {
			let errorObject: RestErrorResult;
			try {
				errorObject = e.message && JSON.parse(e.message);
			} catch {
				// If we failed to parse the JSON re-throw the original error
				// since it will have a more useful stack
				throw e;
			}
			const firstError = errorObject && errorObject.errors && errorObject.errors[0];
			if (firstError && firstError.code === 'missing_field' && firstError.field === 'body') {
				throw new Error('Body can\'t be blank');
			} else {
				throw new Error('There is already a pending review for this pull request on GitHub. Please finish or dismiss this review to be able to leave more comments');
			}

		} else {
			throw e;
		}
	}

	private async addReviewTimelineEventComments(pullRequest: PullRequestModel, events: TimelineEvent[]): Promise<void> {
		interface CommentNode extends Comment {
			childComments?: CommentNode[];
		}

		const reviewEvents = events.filter(isReviewEvent);
		const reviewComments = await this.getPullRequestComments(pullRequest) as CommentNode[];

		const reviewEventsById = reviewEvents.reduce((index, evt) => {
			index[evt.id] = evt;
			evt.comments = [];
			return index;
		}, {});

		const commentsById = reviewComments.reduce((index, evt) => {
			index[evt.id] = evt;
			return index;
		}, {});

		const roots = [];
		let i = reviewComments.length; while (i --> 0) {
			const c: CommentNode = reviewComments[i];
			if (!c.in_reply_to_id) {
				roots.push(c);
				continue;
			}
			const parent = commentsById[c.in_reply_to_id];
			parent.childComments = parent.childComments || [];
			parent.childComments = [c, ...(c.childComments || []), ...parent.childComments];
		}

		roots.forEach(c => {
			const review = reviewEventsById[c.pull_request_review_id];
			review.comments = review.comments.concat(c).concat(c.childComments || []);
		});

		console.log(reviewEvents);
	}

	private async fixCommitAttribution(pullRequest: PullRequestModel, events: TimelineEvent[]): Promise<void> {
		const commits = await this.getPullRequestCommits(pullRequest);
		const commitEvents = events.filter(isCommitEvent);
		for (let commitEvent of commitEvents) {
			const matchingCommits = commits.filter(commit => commit.sha === commitEvent.sha);
			if (matchingCommits.length === 1) {
				const author = matchingCommits[0].author;
				// There is not necessarily a GitHub account associated with the commit.
				if (author !== null) {
					commitEvent.author.avatar_url = author.avatar_url;
					commitEvent.author.login = author.login;
					commitEvent.author.html_url = author.html_url;
				}
			}
		}
	}

	private async parseTimelineEvents(pullRequest: PullRequestModel, remote: Remote, events: any[]): Promise<TimelineEvent[]> {
		events.forEach(event => {
			let type = getEventType(event.event);
			event.event = type;
			return event;
		});

		events.forEach(event => {
			if (event.event === EventType.Commented) {
				this.addCommentPermissions(event, remote);
			}
		});

		return Promise.all([
			this.addReviewTimelineEventComments(pullRequest, events),
			this.fixCommitAttribution(pullRequest, events)
		]).then(_ => {
			return events;
		});
	}
}

export function getEventType(text: string) {
	switch (text) {
		case 'committed':
			return EventType.Committed;
		case 'mentioned':
			return EventType.Mentioned;
		case 'subscribed':
			return EventType.Subscribed;
		case 'commented':
			return EventType.Commented;
		case 'reviewed':
			return EventType.Reviewed;
		default:
			return EventType.Other;
	}
}

const ownedByMe: Predicate<GitHubRepository> = repo => {
	const { currentUser = null } = repo.octokit as any;
	return currentUser && repo.remote.owner === currentUser.login;
};

const byRemoteName = (name: string): Predicate<GitHubRepository> =>
	({ remote: { remoteName } }) => remoteName === name;

const titleAndBodyFrom = (message: string): { title: string, body: string } => {
	const idxLineBreak = message.indexOf('\n');
	return {
		title: idxLineBreak === -1
			? message
			: message.substr(0, idxLineBreak),

		body: idxLineBreak === -1
			? ''
			: message.slice(idxLineBreak + 1),
	};
};

const toComment = (comment: any): any => ({
	id: comment.databaseId,
	node_id: comment.id,
	body: comment.body,
	user: {
		login: comment.author.login,
		avatar_url: comment.author.avatarUrl,
	},
	position: comment.position,
	url: comment.url,
	path: comment.path,
	original_position: comment.originalPosition,
	diff_hunk: comment.diffHunk,
	isDraft: comment.state === 'PENDING',
	pull_request_review_id: comment.pullRequestReview && comment.pullRequestReview.databaseId,
	in_reply_to_id: comment.replyTo && comment.replyTo.databaseId,
});