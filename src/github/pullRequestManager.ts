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
import { IPullRequestManager, IPullRequestModel, IPullRequestsPagingOptions, PRType, ReviewEvent, ITelemetry } from './interface';
import { PullRequestGitHelper } from './pullRequestGitHelper';
import { PullRequestModel } from './pullRequestModel';
import { parserCommentDiffHunk } from '../common/diffHunk';
import { GitHubManager } from '../authentication/githubServer';
import { formatError, uniqBy, groupBy } from '../common/utils';
import Logger from '../common/logger';
import { RefType, Repository } from '../typings/git';

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

export class PullRequestManager implements IPullRequestManager {
	private _activePullRequest?: IPullRequestModel;
	private _credentialStore: CredentialStore;
	private _githubRepositories: GitHubRepository[];
	private _githubManager: GitHubManager;
	private _repositoryPageInformation: Map<string, PageInformation> = new Map<string, PageInformation>();

	private _onDidChangeActivePullRequest = new vscode.EventEmitter<void>();
	readonly onDidChangeActivePullRequest: vscode.Event<void> = this._onDidChangeActivePullRequest.event;

	constructor(
		private _repository: Repository,
		private readonly _telemetry: ITelemetry
	) {
		this._githubRepositories = [];
		this._credentialStore = new CredentialStore(this._telemetry);
		this._githubManager = new GitHubManager();
	}

	get activePullRequest() {
		return this._activePullRequest;
	}

	set activePullRequest(pullRequest: IPullRequestModel) {
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
		for (let remote of gitHubRemotes) {
			const isRemoteForPR = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this.repository, remote.remoteName);
			if (!isRemoteForPR) {
				const repository = new GitHubRepository(remote, this._credentialStore);
				resolveRemotePromises.push(repository.resolveRemote());
				repositories.push(repository);
			}
		}

		return Promise.all(resolveRemotePromises).then(_ => {
			this._githubRepositories = repositories;

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

	async authenticate(): Promise<boolean> {
		let ret = false;
		this._credentialStore.reset();
		for (let repository of uniqBy(this._githubRepositories, x => x.remote.normalizedHost)) {
			ret = await repository.authenticate() || ret;
		}
		return ret;
	}

	async getLocalPullRequests(): Promise<IPullRequestModel[]> {
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

	async deleteLocalPullRequest(pullRequest: PullRequestModel): Promise<void> {
		const remoteName = await this.repository.getConfig(`branch.${pullRequest.localBranchName}.remote`);
		if (!remoteName) {
			throw new Error('Unable to find remote for branch');
		}

		await this.repository.deleteBranch(pullRequest.localBranchName);

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

	async getPullRequests(type: PRType, options: IPullRequestsPagingOptions = { fetchNextPage: false }): Promise<[IPullRequestModel[], boolean]> {
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
			const isRemoteForPR = await PullRequestGitHelper.isRemoteCreatedForPullRequest(this.repository, remote);
			if (!isRemoteForPR) {
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

	async getPullRequestComments(pullRequest: IPullRequestModel): Promise<Comment[]> {
		const { remote, octokit } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		const reviewData = await octokit.pullRequests.getComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});
		const rawComments = reviewData.data.map(comment => this.addCommentPermissions(comment, remote));
		return parserCommentDiffHunk(rawComments);
	}

	async getPullRequestCommits(pullRequest: IPullRequestModel): Promise<Github.PullRequestsGetCommitsResponseItem[]> {
		try {
			const { remote, octokit } = await (pullRequest as PullRequestModel).githubRepository.ensure();
			const commitData = await octokit.pullRequests.getCommits({
				number: pullRequest.prNumber,
				owner: remote.owner,
				repo: remote.repositoryName
			});

			return commitData.data;
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commits failed: ${formatError(e)}`);
			return [];
		}
	}

	async getCommitChangedFiles(pullRequest: IPullRequestModel, commit: Github.PullRequestsGetCommitsResponseItem): Promise<Github.ReposGetCommitResponseFilesItem[]> {
		try {
			const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();
			const fullCommit = await octokit.repos.getCommit({
				owner: remote.owner,
				repo: remote.repositoryName,
				sha: commit.sha
			});

			return fullCommit.data.files.filter(file => !!file.patch);
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commit file changes failed: ${formatError(e)}`);
			return [];
		}
	}

	async getReviewComments(pullRequest: IPullRequestModel, reviewId: number): Promise<Comment[]> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		const reviewData = await octokit.pullRequests.getReviewComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			review_id: reviewId
		});

		const rawComments = reviewData.data.map(comment => this.addCommentPermissions(comment, remote));
		return parserCommentDiffHunk(rawComments);
	}

	async getTimelineEvents(pullRequest: IPullRequestModel): Promise<TimelineEvent[]> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		let ret = await octokit.issues.getEventsTimeline({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});

		return await this.parseTimelineEvents(pullRequest, remote, ret.data);
	}

	async getIssueComments(pullRequest: IPullRequestModel): Promise<Github.IssuesGetCommentsResponseItem[]> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		const promise = await octokit.issues.getComments({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});

		return promise.data;
	}

	async createIssueComment(pullRequest: IPullRequestModel, text: string): Promise<Github.IssuesCreateCommentResponse> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		const promise = await octokit.issues.createComment({
			body: text,
			number: pullRequest.prNumber,
			owner: remote.owner,
			repo: remote.repositoryName
		});

		return this.addCommentPermissions(promise.data as Comment, remote);
	}

	async createCommentReply(pullRequest: IPullRequestModel, body: string, reply_to: string): Promise<Comment> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		try {
			let ret = await octokit.pullRequests.createCommentReply({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber,
				body: body,
				in_reply_to: Number(reply_to)
			});

			return this.addCommentPermissions(ret.data, remote);
		} catch (e) {
			this.handleError(e);
		}
	}

	async createComment(pullRequest: IPullRequestModel, body: string, path: string, position: number): Promise<Comment> {
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

	async editIssueComment(pullRequest: IPullRequestModel, commentId: string, text: string): Promise<Comment> {
		try {
			const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

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

	async editReviewComment(pullRequest: IPullRequestModel, commentId: string, text: string): Promise<Comment> {
		try {
			const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

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

	async deleteIssueComment(pullRequest: IPullRequestModel, commentId: string): Promise<void> {
		try {
			const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

			await octokit.issues.deleteComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				comment_id: Number(commentId)
			});
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async deleteReviewComment(pullRequest: IPullRequestModel, commentId: string): Promise<void> {
		try {
			const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

			await octokit.pullRequests.deleteComment({
				owner: remote.owner,
				repo: remote.repositoryName,
				comment_id: Number(commentId)
			});
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	canEditPullRequest(pullRequest: IPullRequestModel): boolean {
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

	private async changePullRequestState(state: 'open' | 'closed', pullRequest: IPullRequestModel): Promise<Github.PullRequestsUpdateResponse> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		let ret = await octokit.pullRequests.update({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			state: state
		});

		return ret.data;
	}

	async editPullRequest(pullRequest: IPullRequestModel, newBody: string): Promise<Github.PullRequestsUpdateResponse> {
		try {
			const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();
			const { data } = await octokit.pullRequests.update({
				owner: remote.owner,
				repo: remote.repositoryName,
				number: pullRequest.prNumber,
				body: newBody
			});
			return data;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async closePullRequest(pullRequest: IPullRequestModel): Promise<any> {
		return this.changePullRequestState('closed', pullRequest)
			.then(x => {
				this._telemetry.on('pr.close');
				return x;
			});
	}

	async mergePullRequest(pullRequest: IPullRequestModel): Promise<any> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();
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

	private async createReview(pullRequest: IPullRequestModel, event: ReviewEvent, message?: string): Promise<Github.PullRequestsCreateReviewResponse> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		let ret = await octokit.pullRequests.createReview({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			event: event,
			body: message,
		});

		return ret.data;
	}

	async requestChanges(pullRequest: IPullRequestModel, message?: string): Promise<any> {
		return this.createReview(pullRequest, ReviewEvent.RequestChanges, message)
			.then(x => {
				this._telemetry.on('pr.requestChanges');
				return x;
			});
	}

	async approvePullRequest(pullRequest: IPullRequestModel, message?: string): Promise<any> {
		return this.createReview(pullRequest, ReviewEvent.Approve, message)
			.then(x => {
				this._telemetry.on('pr.approve');
				return x;
			});
	}

	async getPullRequestChangedFiles(pullRequest: IPullRequestModel): Promise<Github.PullRequestsGetFilesResponseItem[]> {
		const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

		let response = await octokit.pullRequests.getFiles({
			owner: remote.owner,
			repo: remote.repositoryName,
			number: pullRequest.prNumber,
			per_page: 100
		});
		let { data } = response;

		while (response.headers.link && octokit.hasNextPage(response.headers)) {
			response = await octokit.getNextPage(response.headers);
			data = data.concat(response.data);
		}
		return data;
	}

	async getPullRequestRepositoryDefaultBranch(pullRequest: IPullRequestModel): Promise<string> {
		const branch = await (pullRequest as PullRequestModel).githubRepository.getDefaultBranch();
		return branch;
	}

	async fullfillPullRequestMissingInfo(pullRequest: IPullRequestModel): Promise<void> {
		try {
			const { octokit, remote } = await (pullRequest as PullRequestModel).githubRepository.ensure();

			if (!pullRequest.base) {
				const { data } = await octokit.pullRequests.get({
					owner: remote.owner,
					repo: remote.repositoryName,
					number: pullRequest.prNumber
				});
				pullRequest.update(data);
			}

			pullRequest.mergeBase = await PullRequestGitHelper.getPullRequestMergeBase(this.repository, remote, pullRequest);
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching Pull Request merge base failed: ${formatError(e)}`);
		}
	}

	//#region Git related APIs

	async resolvePullRequest(owner: string, repositoryName: string, pullReuqestNumber: number): Promise<IPullRequestModel> {
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

	async getBranchForPullRequestFromExistingRemotes(pullRequest: IPullRequestModel) {
		return await PullRequestGitHelper.getBranchForPullRequestFromExistingRemotes(this.repository, this._githubRepositories, pullRequest);
	}

	async fetchAndCheckout(remote: Remote, branchName: string, pullRequest: IPullRequestModel): Promise<void> {
		await PullRequestGitHelper.fetchAndCheckout(this.repository, remote, branchName, pullRequest);
	}

	async createAndCheckout(pullRequest: IPullRequestModel): Promise<void> {
		await PullRequestGitHelper.createAndCheckout(this.repository, pullRequest);
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

	private async addReviewTimelineEventComments(pullRequest: IPullRequestModel, events: TimelineEvent[]): Promise<void> {
		const reviewEvents = events.filter(isReviewEvent);
		const reviewComments = await this.getPullRequestComments(pullRequest);

		// Group comments by file and position
		const commentsByFile = groupBy(reviewComments, comment => comment.path);
		for (let file in commentsByFile) {
			const fileComments = commentsByFile[file];
			const commentThreads = groupBy(fileComments, comment => String(comment.position === null ? comment.original_position : comment.position));

			// Loop through threads, for each thread, see if there is a matching review, push all comments to it
			for (let i in commentThreads) {
				const comments = commentThreads[i];
				const reviewId = comments[0].pull_request_review_id;

				if (reviewId) {
					const matchingEvent = reviewEvents.find(review => review.id === reviewId);
					if (matchingEvent) {
						if (matchingEvent.comments) {
							matchingEvent.comments = matchingEvent.comments.concat(comments);
						} else {
							matchingEvent.comments = comments;
						}
					}
				}
			}
		}
	}

	private async fixCommitAttribution(pullRequest: IPullRequestModel, events: TimelineEvent[]): Promise<void> {
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

	private async parseTimelineEvents(pullRequest: IPullRequestModel, remote: Remote, events: any[]): Promise<TimelineEvent[]> {
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
