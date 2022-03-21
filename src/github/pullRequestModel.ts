/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as buffer from 'buffer';
import * as path from 'path';
import equals from 'fast-deep-equal';
import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { DiffSide, IComment, IReviewThread, ViewedState } from '../common/comment';
import { parseDiff } from '../common/diffHunk';
import { commands, contexts } from '../common/executeCommands';
import { GitChangeType, InMemFileChange, SlimFileChange } from '../common/file';
import { GitHubRef } from '../common/githubRef';
import Logger from '../common/logger';
import { Remote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { ReviewEvent as CommonReviewEvent, isReviewEvent, TimelineEvent } from '../common/timelineEvent';
import { resolvePath, toPRUri, toReviewUri } from '../common/uri';
import { formatError } from '../common/utils';
import { OctokitCommon } from './common';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GitHubRepository } from './githubRepository';
import {
	AddCommentResponse,
	AddReactionResponse,
	AddReviewThreadResponse,
	DeleteReactionResponse,
	DeleteReviewResponse,
	EditCommentResponse,
	GetChecksResponse,
	isCheckRun,
	MarkPullRequestReadyForReviewResponse,
	PendingReviewIdResponse,
	PullRequestCommentsResponse,
	PullRequestFilesResponse,
	PullRequestMergabilityResponse,
	ReactionGroup,
	ResolveReviewThreadResponse,
	StartReviewResponse,
	SubmitReviewResponse,
	TimelineEventsResponse,
	UnresolveReviewThreadResponse,
	UpdatePullRequestResponse,
} from './graphql';
import {
	GithubItemStateEnum,
	IAccount,
	IRawFileChange,
	ISuggestedReviewer,
	PullRequest,
	PullRequestChecks,
	PullRequestMergeability,
	ReviewEvent,
} from './interface';
import { IssueModel } from './issueModel';
import {
	convertRESTPullRequestToRawPullRequest,
	convertRESTReviewEvent,
	convertRESTUserToAccount,
	getReactionGroup,
	parseGraphQLComment,
	parseGraphQLReaction,
	parseGraphQLReviewEvent,
	parseGraphQLReviewThread,
	parseGraphQLTimelineEvents,
	parseMergeability,
} from './utils';

interface IPullRequestModel {
	head: GitHubRef | null;
}

export interface IResolvedPullRequestModel extends IPullRequestModel {
	head: GitHubRef;
}

export interface ReviewThreadChangeEvent {
	added: IReviewThread[];
	changed: IReviewThread[];
	removed: IReviewThread[];
}

export interface FileViewedStateChangeEvent {
	changed: {
		fileName: string;
		viewed: ViewedState;
	}[];
}

export type FileViewedState = { [key: string]: ViewedState };

export class PullRequestModel extends IssueModel<PullRequest> implements IPullRequestModel {
	static ID = 'PullRequestModel';

	public isDraft?: boolean;
	public localBranchName?: string;
	public mergeBase?: string;
	public suggestedReviewers?: ISuggestedReviewer[];
	private _hasPendingReview: boolean = false;
	private _onDidChangePendingReviewState: vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
	public onDidChangePendingReviewState = this._onDidChangePendingReviewState.event;

	private _reviewThreadsCache: IReviewThread[] = [];
	private _reviewThreadsCacheInitialized = false;
	private _onDidChangeReviewThreads = new vscode.EventEmitter<ReviewThreadChangeEvent>();
	public onDidChangeReviewThreads = this._onDidChangeReviewThreads.event;

	private _fileChangeViewedState: FileViewedState = {};
	private _viewedFiles: Set<string> = new Set();
	private _unviewedFiles: Set<string> = new Set();
	private _onDidChangeFileViewedState = new vscode.EventEmitter<FileViewedStateChangeEvent>();
	public onDidChangeFileViewedState = this._onDidChangeFileViewedState.event;

	private _comments: IComment[] | undefined;
	private _onDidChangeComments: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidChangeComments: vscode.Event<void> = this._onDidChangeComments.event;

	// Whether the pull request is currently checked out locally
	public isActive: boolean;
	_telemetry: ITelemetry;

	constructor(
		telemetry: ITelemetry,
		githubRepository: GitHubRepository,
		remote: Remote,
		item: PullRequest,
		isActive?: boolean,
	) {
		super(githubRepository, remote, item, true);

		this._telemetry = telemetry;
		this.isActive = !!isActive;

		this.update(item);
	}

	public clear() {
		this.comments = [];
		this._reviewThreadsCacheInitialized = false;
		this._reviewThreadsCache = [];
	}

	public async initializeReviewThreadCache(): Promise<void> {
		await this.getReviewThreads();
		this._reviewThreadsCacheInitialized = true;
	}

	public get reviewThreadsCache(): IReviewThread[] {
		return this._reviewThreadsCache;
	}

	public get reviewThreadsCacheReady(): boolean {
		return this._reviewThreadsCacheInitialized;
	}

	public get isMerged(): boolean {
		return this.state === GithubItemStateEnum.Merged;
	}

	public get hasPendingReview(): boolean {
		return this._hasPendingReview;
	}

	public set hasPendingReview(hasPendingReview: boolean) {
		if (this._hasPendingReview !== hasPendingReview) {
			this._hasPendingReview = hasPendingReview;
			this._onDidChangePendingReviewState.fire(this._hasPendingReview);
		}
	}

	get comments(): IComment[] {
		return this._comments ?? [];
	}

	set comments(comments: IComment[]) {
		this._comments = comments;
		this._onDidChangeComments.fire();
	}

	get fileChangeViewedState(): FileViewedState {
		return this._fileChangeViewedState;
	}

	public isRemoteHeadDeleted?: boolean;
	public head: GitHubRef | null;
	public isRemoteBaseDeleted?: boolean;
	public base: GitHubRef;

	protected updateState(state: string) {
		if (state.toLowerCase() === 'open') {
			this.state = GithubItemStateEnum.Open;
		} else {
			this.state = this.item.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Closed;
		}
	}

	update(item: PullRequest): void {
		super.update(item);
		this.isDraft = item.isDraft;
		this.suggestedReviewers = item.suggestedReviewers;

		if (item.isRemoteHeadDeleted != null) {
			this.isRemoteHeadDeleted = item.isRemoteHeadDeleted;
		}
		if (item.head) {
			this.head = new GitHubRef(item.head.ref, item.head.label, item.head.sha, item.head.repo.cloneUrl);
		}

		if (item.isRemoteBaseDeleted != null) {
			this.isRemoteBaseDeleted = item.isRemoteBaseDeleted;
		}
		if (item.base) {
			this.base = new GitHubRef(item.base.ref, item.base!.label, item.base!.sha, item.base!.repo.cloneUrl);
		}
	}

	/**
	 * Validate if the pull request has a valid HEAD.
	 * Use only when the method can fail silently, otherwise use `validatePullRequestModel`
	 */
	isResolved(): this is IResolvedPullRequestModel {
		return !!this.head;
	}

	/**
	 * Validate if the pull request has a valid HEAD. Show a warning message to users when the pull request is invalid.
	 * @param message Human readable action execution failure message.
	 */
	validatePullRequestModel(message?: string): this is IResolvedPullRequestModel {
		if (!!this.head) {
			return true;
		}

		const reason = `There is no upstream branch for Pull Request #${this.number}. View it on GitHub for more details`;

		if (message) {
			message += `: ${reason}`;
		} else {
			message = reason;
		}

		vscode.window.showWarningMessage(message, 'Open on GitHub').then(action => {
			if (action && action === 'Open on GitHub') {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(this.html_url));
			}
		});

		return false;
	}

	/**
	 * Approve the pull request.
	 * @param message Optional approval comment text.
	 */
	async approve(message?: string): Promise<CommonReviewEvent> {
		const action: Promise<CommonReviewEvent> = (await this.getPendingReviewId())
			? this.submitReview(ReviewEvent.Approve, message)
			: this.createReview(ReviewEvent.Approve, message);

		return action.then(x => {
			/* __GDPR__
				"pr.approve" : {}
			*/
			this._telemetry.sendTelemetryEvent('pr.approve');
			return x;
		});
	}

	/**
	 * Request changes on the pull request.
	 * @param message Optional comment text to leave with the review.
	 */
	async requestChanges(message?: string): Promise<CommonReviewEvent> {
		const action: Promise<CommonReviewEvent> = (await this.getPendingReviewId())
			? this.submitReview(ReviewEvent.RequestChanges, message)
			: this.createReview(ReviewEvent.RequestChanges, message);

		return action.then(x => {
			/* __GDPR__
					"pr.requestChanges" : {}
				*/
			this._telemetry.sendTelemetryEvent('pr.requestChanges');
			return x;
		});
	}

	/**
	 * Close the pull request.
	 */
	async close(): Promise<PullRequest> {
		const { octokit, remote } = await this.githubRepository.ensure();
		const ret = await octokit.pulls.update({
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: this.number,
			state: 'closed',
		});

		/* __GDPR__
			"pr.close" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.close');

		return convertRESTPullRequestToRawPullRequest(ret.data, this.githubRepository);
	}

	/**
	 * Create a new review.
	 * @param event The type of review to create, an approval, request for changes, or comment.
	 * @param message The summary comment text.
	 */
	private async createReview(event: ReviewEvent, message?: string): Promise<CommonReviewEvent> {
		const { octokit, remote } = await this.githubRepository.ensure();

		const { data } = await octokit.pulls.createReview({
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: this.number,
			event: event,
			body: message,
		});

		return convertRESTReviewEvent(data, this.githubRepository);
	}

	/**
	 * Submit an existing review.
	 * @param event The type of review to create, an approval, request for changes, or comment.
	 * @param body The summary comment text.
	 */
	async submitReview(event?: ReviewEvent, body?: string): Promise<CommonReviewEvent> {
		const pendingReviewId = await this.getPendingReviewId();
		const { mutate, schema } = await this.githubRepository.ensure();

		if (pendingReviewId) {
			const { data } = await mutate<SubmitReviewResponse>({
				mutation: schema.SubmitReview,
				variables: {
					id: pendingReviewId,
					event: event || ReviewEvent.Comment,
					body,
				},
			});

			this.hasPendingReview = false;
			await this.updateDraftModeContext();
			const reviewEvent = parseGraphQLReviewEvent(data!.submitPullRequestReview.pullRequestReview, this.githubRepository);

			const threadWithComment = this._reviewThreadsCache.find(thread =>
				thread.comments.length ? (thread.comments[0].pullRequestReviewId === reviewEvent.id) : undefined,
			);
			if (threadWithComment) {
				threadWithComment.comments = reviewEvent.comments;
				threadWithComment.viewerCanResolve = true;
				this._onDidChangeReviewThreads.fire({ added: [], changed: [threadWithComment], removed: [] });
			}
			return reviewEvent;
		} else {
			throw new Error(`Submitting review failed, no pending review for current pull request: ${this.number}.`);
		}
	}

	async updateMilestone(id: string): Promise<void> {
		const { mutate, schema } = await this.githubRepository.ensure();
		const finalId = id === 'null' ? null : id;

		try {
			await mutate<UpdatePullRequestResponse>({
				mutation: schema.UpdatePullRequest,
				variables: {
					input: {
						pullRequestId: this.item.graphNodeId,
						milestoneId: finalId,
					},
				},
			});
		} catch (err) {
			Logger.appendLine(err);
		}
	}

	async updateAssignees(assignees: string[]): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		await octokit.issues.addAssignees({
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: this.number,
			assignees,
		});
	}

	/**
	 * Query to see if there is an existing review.
	 */
	async getPendingReviewId(): Promise<string | undefined> {
		const { query, schema } = await this.githubRepository.ensure();
		const currentUser = await this.githubRepository.getAuthenticatedUser();
		try {
			const { data } = await query<PendingReviewIdResponse>({
				query: schema.GetPendingReviewId,
				variables: {
					pullRequestId: this.item.graphNodeId,
					author: currentUser,
				},
			});
			return data.node.reviews.nodes.length > 0 ? data.node.reviews.nodes[0].id : undefined;
		} catch (error) {
			return;
		}
	}

	/**
	 * Delete an existing in progress review.
	 */
	async deleteReview(): Promise<{ deletedReviewId: number; deletedReviewComments: IComment[] }> {
		const pendingReviewId = await this.getPendingReviewId();
		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<DeleteReviewResponse>({
			mutation: schema.DeleteReview,
			variables: {
				input: { pullRequestReviewId: pendingReviewId },
			},
		});

		const { comments, databaseId } = data!.deletePullRequestReview.pullRequestReview;

		this.hasPendingReview = false;
		await this.updateDraftModeContext();

		this.getReviewThreads();

		return {
			deletedReviewId: databaseId,
			deletedReviewComments: comments.nodes.map(comment => parseGraphQLComment(comment, false)),
		};
	}

	/**
	 * Start a new review.
	 * @param initialComment The comment text and position information to begin the review with
	 * @param commitId The optional commit id to start the review on. Defaults to using the current head commit.
	 */
	async startReview(commitId?: string): Promise<string> {
		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<StartReviewResponse>({
			mutation: schema.StartReview,
			variables: {
				input: {
					body: '',
					pullRequestId: this.item.graphNodeId,
					commitOID: commitId || this.head?.sha,
				},
			},
		});

		if (!data) {
			throw new Error('Failed to start review');
		}

		return data.addPullRequestReview.pullRequestReview.id;
	}

	/**
	 * Creates a new review thread, either adding it to an existing pending review, or creating
	 * a new review.
	 * @param body The body of the thread's first comment.
	 * @param commentPath The path to the file being commented on.
	 * @param line The line on which to add the comment.
	 * @param side The side the comment should be deleted on, i.e. the original or modified file.
	 * @param suppressDraftModeUpdate If a draft mode change should event should be suppressed. In the
	 * case of a single comment add, the review is created and then immediately submitted, so this prevents
	 * a "Pending" label from flashing on the comment.
	 * @returns The new review thread object.
	 */
	async createReviewThread(
		body: string,
		commentPath: string,
		line: number,
		side: DiffSide,
		suppressDraftModeUpdate?: boolean,
	): Promise<IReviewThread | undefined> {
		if (!this.validatePullRequestModel('Creating comment failed')) {
			return;
		}
		const pendingReviewId = await this.getPendingReviewId();

		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<AddReviewThreadResponse>({
			mutation: schema.AddReviewThread,
			variables: {
				input: {
					path: commentPath,
					body,
					pullRequestId: this.graphNodeId,
					pullRequestReviewId: pendingReviewId,
					line,
					side,
				},
			},
		});

		if (!data) {
			throw new Error('Creating review thread failed.');
		}

		if (!suppressDraftModeUpdate) {
			this.hasPendingReview = true;
			await this.updateDraftModeContext();
		}

		const thread = data.addPullRequestReviewThread.thread;
		const newThread = parseGraphQLReviewThread(thread);
		this._reviewThreadsCache.push(newThread);
		this._onDidChangeReviewThreads.fire({ added: [newThread], changed: [], removed: [] });
		return newThread;
	}

	/**
	 * Creates a new comment in reply to an existing comment
	 * @param body The text of the comment to be created
	 * @param inReplyTo The id of the comment this is in reply to
	 * @param isSingleComment Whether this is a single comment, i.e. one that
	 * will be immediately submitted and so should not show a pending label
	 * @param commitId The commit id the comment was made on
	 * @returns The new comment
	 */
	async createCommentReply(
		body: string,
		inReplyTo: string,
		isSingleComment: boolean,
		commitId?: string,
	): Promise<IComment | undefined> {
		if (!this.validatePullRequestModel('Creating comment failed')) {
			return;
		}

		let pendingReviewId = await this.getPendingReviewId();
		if (!pendingReviewId) {
			pendingReviewId = await this.startReview(commitId);
		}

		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<AddCommentResponse>({
			mutation: schema.AddComment,
			variables: {
				input: {
					pullRequestReviewId: pendingReviewId,
					body,
					inReplyTo,
					commitOID: commitId || this.head?.sha,
				},
			},
		});

		if (!data) {
			throw new Error('Creating comment reply failed.');
		}

		const { comment } = data.addPullRequestReviewComment;
		const newComment = parseGraphQLComment(comment, false);

		if (isSingleComment) {
			newComment.isDraft = false;
		}

		const threadWithComment = this._reviewThreadsCache.find(thread =>
			thread.comments.some(comment => comment.graphNodeId === inReplyTo),
		);
		if (threadWithComment) {
			threadWithComment.comments.push(newComment);
			this._onDidChangeReviewThreads.fire({ added: [], changed: [threadWithComment], removed: [] });
		}

		return newComment;
	}

	/**
	 * Check whether there is an existing pending review and update the context key to control what comment actions are shown.
	 */
	async validateDraftMode(): Promise<boolean> {
		const inDraftMode = !!(await this.getPendingReviewId());
		if (inDraftMode !== this.hasPendingReview) {
			this.hasPendingReview = inDraftMode;
		}

		await this.updateDraftModeContext();

		return inDraftMode;
	}

	private async updateDraftModeContext() {
		if (this.isActive) {
			await vscode.commands.executeCommand('setContext', 'reviewInDraftMode', this.hasPendingReview);
		}
	}

	/**
	 * Edit an existing review comment.
	 * @param comment The comment to edit
	 * @param text The new comment text
	 */
	async editReviewComment(comment: IComment, text: string): Promise<IComment> {
		const { mutate, schema } = await this.githubRepository.ensure();
		let threadWithComment = this._reviewThreadsCache.find(thread =>
			thread.comments.some(c => c.graphNodeId === comment.graphNodeId),
		);

		if (!threadWithComment) {
			return this.editIssueComment(comment, text);
		}

		const { data } = await mutate<EditCommentResponse>({
			mutation: schema.EditComment,
			variables: {
				input: {
					pullRequestReviewCommentId: comment.graphNodeId,
					body: text,
				},
			},
		});

		if (!data) {
			throw new Error('Editing review comment failed.');
		}

		const newComment = parseGraphQLComment(
			data.updatePullRequestReviewComment.pullRequestReviewComment,
			!!comment.isResolved,
		);
		if (threadWithComment) {
			const index = threadWithComment.comments.findIndex(c => c.graphNodeId === comment.graphNodeId);
			threadWithComment.comments.splice(index, 1, newComment);
			this._onDidChangeReviewThreads.fire({ added: [], changed: [threadWithComment], removed: [] });
		}

		return newComment;
	}

	/**
	 * Deletes a review comment.
	 * @param commentId The comment id to delete
	 */
	async deleteReviewComment(commentId: string): Promise<void> {
		try {
			const { octokit, remote } = await this.githubRepository.ensure();
			const id = Number(commentId);
			const threadIndex = this._reviewThreadsCache.findIndex(thread => thread.comments.some(c => c.id === id));

			if (threadIndex === -1) {
				this.deleteIssueComment(commentId);
			} else {
				await octokit.pulls.deleteReviewComment({
					owner: remote.owner,
					repo: remote.repositoryName,
					comment_id: id,
				});

				if (threadIndex > -1) {
					const threadWithComment = this._reviewThreadsCache[threadIndex];
					const index = threadWithComment.comments.findIndex(c => c.id === id);
					threadWithComment.comments.splice(index, 1);
					if (threadWithComment.comments.length === 0) {
						this._reviewThreadsCache.splice(threadIndex, 1);
						this._onDidChangeReviewThreads.fire({ added: [], changed: [], removed: [threadWithComment] });
					} else {
						this._onDidChangeReviewThreads.fire({ added: [], changed: [threadWithComment], removed: [] });
					}
				}
			}
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	/**
	 * Get existing requests to review.
	 */
	async getReviewRequests(): Promise<IAccount[]> {
		const githubRepository = this.githubRepository;
		const { remote, octokit } = await githubRepository.ensure();
		const result = await octokit.pulls.listRequestedReviewers({
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: this.number,
		});

		return result.data.users.map((user: any) => convertRESTUserToAccount(user, githubRepository));
	}

	/**
	 * Add reviewers to a pull request
	 * @param reviewers A list of GitHub logins
	 */
	async requestReview(reviewers: string[]): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		await octokit.pulls.requestReviewers({
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: this.number,
			reviewers,
		});
	}

	/**
	 * Remove a review request that has not yet been completed
	 * @param reviewer A GitHub Login
	 */
	async deleteReviewRequest(reviewer: string): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		await octokit.pulls.removeRequestedReviewers({
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: this.number,
			reviewers: [reviewer],
		});
	}

	async deleteAssignees(assignee: string): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		await octokit.issues.removeAssignees({
			owner: remote.owner,
			repo: remote.repositoryName,
			issue_number: this.number,
			assignees: [assignee],
		});
	}

	private diffThreads(newReviewThreads: IReviewThread[]): void {
		const added: IReviewThread[] = [];
		const changed: IReviewThread[] = [];
		const removed: IReviewThread[] = [];

		newReviewThreads.forEach(thread => {
			const existingThread = this._reviewThreadsCache.find(t => t.id === thread.id);
			if (existingThread) {
				if (!equals(thread, existingThread)) {
					changed.push(thread);
				}
			} else {
				added.push(thread);
			}
		});

		this._reviewThreadsCache.forEach(thread => {
			if (!newReviewThreads.find(t => t.id === thread.id)) {
				removed.push(thread);
			}
		});

		this._onDidChangeReviewThreads.fire({
			added,
			changed,
			removed,
		});
	}

	async getReviewThreads(): Promise<IReviewThread[]> {
		const { remote, query, schema } = await this.githubRepository.ensure();
		try {
			const { data } = await query<PullRequestCommentsResponse>({
				query: schema.PullRequestComments,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: this.number,
				},
			});

			const reviewThreads = data.repository.pullRequest.reviewThreads.nodes.map(node => {
				return parseGraphQLReviewThread(node);
			});

			this.diffThreads(reviewThreads);
			this._reviewThreadsCache = reviewThreads;

			return reviewThreads;
		} catch (e) {
			Logger.appendLine(`Failed to get pull request review comments: ${e}`);
			return [];
		}
	}

	/**
	 * Get all review comments.
	 */
	async initializeReviewComments(): Promise<void> {
		const { remote, query, schema } = await this.githubRepository.ensure();
		try {
			const { data } = await query<PullRequestCommentsResponse>({
				query: schema.PullRequestComments,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: this.number,
				},
			});

			const comments = data.repository.pullRequest.reviewThreads.nodes
				.map(node => node.comments.nodes.map(comment => parseGraphQLComment(comment, node.isResolved), remote))
				.reduce((prev, curr) => prev.concat(curr), [])
				.sort((a: IComment, b: IComment) => {
					return a.createdAt > b.createdAt ? 1 : -1;
				});

			this.comments = comments;
		} catch (e) {
			Logger.appendLine(`Failed to get pull request review comments: ${e}`);
		}
	}

	/**
	 * Get a list of the commits within a pull request.
	 */
	async getCommits(): Promise<OctokitCommon.PullsListCommitsResponseData> {
		try {
			Logger.debug(`Fetch commits of PR #${this.number} - enter`, PullRequestModel.ID);
			const { remote, octokit } = await this.githubRepository.ensure();
			const commitData = await octokit.pulls.listCommits({
				pull_number: this.number,
				owner: remote.owner,
				repo: remote.repositoryName,
			});
			Logger.debug(`Fetch commits of PR #${this.number} - done`, PullRequestModel.ID);

			return commitData.data;
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commits failed: ${formatError(e)}`);
			return [];
		}
	}

	/**
	 * Get all changed files within a commit
	 * @param commit The commit
	 */
	async getCommitChangedFiles(
		commit: OctokitCommon.PullsListCommitsResponseData[0],
	): Promise<OctokitCommon.ReposGetCommitResponseFiles> {
		try {
			Logger.debug(
				`Fetch file changes of commit ${commit.sha} in PR #${this.number} - enter`,
				PullRequestModel.ID,
			);
			const { octokit, remote } = await this.githubRepository.ensure();
			const fullCommit = await octokit.repos.getCommit({
				owner: remote.owner,
				repo: remote.repositoryName,
				ref: commit.sha,
			});
			Logger.debug(
				`Fetch file changes of commit ${commit.sha} in PR #${this.number} - done`,
				PullRequestModel.ID,
			);

			return fullCommit.data.files?.filter(file => !!file.patch) ?? [];
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commit file changes failed: ${formatError(e)}`);
			return [];
		}
	}

	/**
	 * Gets file content for a file at the specified commit
	 * @param filePath The file path
	 * @param commit The commit
	 */
	async getFile(filePath: string, commit: string) {
		const { octokit, remote } = await this.githubRepository.ensure();
		const fileContent = await octokit.repos.getContent({
			owner: remote.owner,
			repo: remote.repositoryName,
			path: filePath,
			ref: commit,
		});

		if (Array.isArray(fileContent.data)) {
			throw new Error(`Unexpected array response when getting file ${filePath}`);
		}

		const contents = (fileContent.data as any).content ?? '';
		const buff = buffer.Buffer.from(contents, (fileContent.data as any).encoding);
		return buff.toString();
	}

	/**
	 * Get the timeline events of a pull request, including comments, reviews, commits, merges, deletes, and assigns.
	 */
	async getTimelineEvents(): Promise<TimelineEvent[]> {
		Logger.debug(`Fetch timeline events of PR #${this.number} - enter`, PullRequestModel.ID);
		const { query, remote, schema } = await this.githubRepository.ensure();

		try {
			const { data } = await query<TimelineEventsResponse>({
				query: schema.TimelineEvents,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: this.number,
				},
			});
			const ret = data.repository.pullRequest.timelineItems.nodes;
			const events = parseGraphQLTimelineEvents(ret, this.githubRepository);
			await this.addReviewTimelineEventComments(events);

			return events;
		} catch (e) {
			console.log(e);
			return [];
		}
	}

	private async addReviewTimelineEventComments(events: TimelineEvent[]): Promise<void> {
		interface CommentNode extends IComment {
			childComments?: CommentNode[];
		}

		const reviewEvents = events.filter(isReviewEvent);
		const reviewThreads = await this.getReviewThreads();
		const reviewComments = reviewThreads.reduce((previous, current) => (previous as IComment[]).concat(current.comments), []);

		const reviewEventsById = reviewEvents.reduce((index, evt) => {
			index[evt.id] = evt;
			evt.comments = [];
			return index;
		}, {} as { [key: number]: CommonReviewEvent });

		const commentsById = reviewComments.reduce((index, evt) => {
			index[evt.id] = evt;
			return index;
		}, {} as { [key: number]: CommentNode });

		const roots: CommentNode[] = [];
		let i = reviewComments.length;
		while (i-- > 0) {
			const c: CommentNode = reviewComments[i];
			if (!c.inReplyToId) {
				roots.unshift(c);
				continue;
			}
			const parent = commentsById[c.inReplyToId];
			parent.childComments = parent.childComments || [];
			parent.childComments = [c, ...(c.childComments || []), ...parent.childComments];
		}

		roots.forEach(c => {
			const review = reviewEventsById[c.pullRequestReviewId!];
			if (review) {
				review.comments = review.comments.concat(c).concat(c.childComments || []);
			}
		});

		const pendingReview = reviewEvents.filter(r => r.state.toLowerCase() === 'pending')[0];
		if (pendingReview) {
			// Ensures that pending comments made in reply to other reviews are included for the pending review
			pendingReview.comments = reviewComments.filter(c => c.isDraft);
		}
	}

	/**
	 * Get the status checks of the pull request, those for the last commit.
	 */
	async getStatusChecks(): Promise<PullRequestChecks> {
		const { query, remote, schema, octokit } = await this.githubRepository.ensure();
		let result;
		try {
			result = await query<GetChecksResponse>({
				query: schema.GetChecks,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: this.number,
				},
			});
		} catch (e) {
			if (e.message?.startsWith('GraphQL error: Resource protected by organization SAML enforcement.')) {
				// There seems to be an issue with fetching status checks if you haven't SAML'd with every org you have
				// Ignore SAML errors here.
				return {
					state: 'pending',
					statuses: [],
				};
			}
		}

		// We always fetch the status checks for only the last commit, so there should only be one node present
		const statusCheckRollup = result.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup;

		if (!statusCheckRollup) {
			return {
				state: 'pending',
				statuses: [],
			};
		}

		const checks: PullRequestChecks = {
			state: statusCheckRollup.state.toLowerCase(),
			statuses: statusCheckRollup.contexts.nodes.map(context => {
				if (isCheckRun(context)) {
					return {
						id: context.id,
						url: context.checkSuite.app?.url,
						avatar_url: context.checkSuite.app?.logoUrl,
						state: context.conclusion?.toLowerCase() || 'pending',
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

		// Fun info: The checks don't include whether a review is required.
		// Also, unless you're an admin on the repo, you can't just do octokit.repos.getBranchProtection
		if (this.item.mergeable === PullRequestMergeability.NotMergeable) {
			const branch = await octokit.repos.getBranch({ branch: this.base.ref, owner: remote.owner, repo: remote.repositoryName });
			if (branch.data.protected && branch.data.protection.required_status_checks.enforcement_level !== 'off') {
				// We need to add the "review required" check manually.
				checks.statuses.unshift({
					id: 'unknown',
					context: 'Branch Protection',
					description: 'Requirements have not been met.',
					state: 'failure',
					target_url: this.html_url
				});
				checks.state = 'failure';
			}
		}

		return checks;
	}

	static async openDiffFromComment(
		folderManager: FolderRepositoryManager,
		pullRequestModel: PullRequestModel,
		comment: IComment,
	): Promise<void> {
		const contentChanges = await pullRequestModel.getFileChangesInfo(folderManager.repository);
		const change = contentChanges.find(
			fileChange => fileChange.fileName === comment.path || fileChange.previousFileName === comment.path,
		);
		if (!change) {
			throw new Error(`Can't find matching file`);
		}

		let headUri, baseUri: vscode.Uri;
		if (!pullRequestModel.equals(folderManager.activePullRequest)) {
			const headCommit = pullRequestModel.head!.sha;
			const parentFileName = change.status === GitChangeType.RENAME ? change.previousFileName! : change.fileName;
			headUri = toPRUri(
				vscode.Uri.file(resolvePath(folderManager.repository.rootUri, change.fileName)),
				pullRequestModel,
				change.baseCommit,
				headCommit,
				change.fileName,
				false,
				change.status,
			);
			baseUri = toPRUri(
				vscode.Uri.file(resolvePath(folderManager.repository.rootUri, parentFileName)),
				pullRequestModel,
				change.baseCommit,
				headCommit,
				change.fileName,
				true,
				change.status,
			);
		} else {
			const uri = vscode.Uri.file(path.resolve(folderManager.repository.rootUri.fsPath, change.fileName));

			headUri =
				change.status === GitChangeType.DELETE
					? toReviewUri(
						uri,
						undefined,
						undefined,
						'',
						false,
						{ base: false },
						folderManager.repository.rootUri,
					)
					: uri;

			const mergeBase = pullRequestModel.mergeBase || pullRequestModel.base.sha;
			baseUri = toReviewUri(
				uri,
				change.status === GitChangeType.RENAME ? change.previousFileName : change.fileName,
				undefined,
				change.status === GitChangeType.ADD ? '' : mergeBase,
				false,
				{ base: true },
				folderManager.repository.rootUri,
			);
		}

		const pathSegments = comment.path!.split('/');
		vscode.commands.executeCommand(
			'vscode.diff',
			baseUri,
			headUri,
			`${pathSegments[pathSegments.length - 1]} (Pull Request)`,
			{},
		);
	}

	private _fileChanges: Map<string, SlimFileChange | InMemFileChange> = new Map();
	get fileChanges(): Map<string, SlimFileChange | InMemFileChange> {
		return this._fileChanges;
	}

	async getFileChangesInfo(repo: Repository) {
		this._fileChanges.clear();
		const data = await this.getRawFileChangesInfo();
		const mergebase = this.mergeBase || this.base.sha;
		const parsed = await parseDiff(data, repo, mergebase);
		parsed.forEach(fileChange => {
			this._fileChanges.set(fileChange.fileName, fileChange);
		});
		return parsed;
	}

	/**
	 * List the changed files in a pull request.
	 */
	private async getRawFileChangesInfo(): Promise<IRawFileChange[]> {
		Logger.debug(
			`Fetch file changes, base, head and merge base of PR #${this.number} - enter`,
			PullRequestModel.ID,
		);
		const githubRepository = this.githubRepository;
		const { octokit, remote } = await githubRepository.ensure();

		if (!this.base) {
			const info = await octokit.pulls.get({
				owner: remote.owner,
				repo: remote.repositoryName,
				pull_number: this.number,
			});
			this.update(convertRESTPullRequestToRawPullRequest(info.data, githubRepository));
		}

		if (this.item.merged) {
			const response = await octokit.pulls.listFiles({
				repo: remote.repositoryName,
				owner: remote.owner,
				pull_number: this.number,
			});

			// Use the original base to compare against for merged PRs
			this.mergeBase = this.base.sha;

			return response.data as IRawFileChange[];
		}

		const { data } = await octokit.repos.compareCommits({
			repo: remote.repositoryName,
			owner: remote.owner,
			base: `${this.base.repositoryCloneUrl.owner}:${this.base.ref}`,
			head: `${this.head!.repositoryCloneUrl.owner}:${this.head!.ref}`,
		});

		this.mergeBase = data.merge_base_commit.sha;

		const MAX_FILE_CHANGES_IN_COMPARE_COMMITS = 300;
		let files: IRawFileChange[] = [];

		if (data.files.length >= MAX_FILE_CHANGES_IN_COMPARE_COMMITS) {
			// compareCommits will return a maximum of 300 changed files
			// If we have (maybe) more than that, we'll need to fetch them with listFiles API call
			Logger.debug(
				`More than ${MAX_FILE_CHANGES_IN_COMPARE_COMMITS} files changed, fetching all file changes of PR #${this.number}`,
				PullRequestModel.ID,
			);
			files = await octokit.paginate(`GET /repos/:owner/:repo/pulls/:pull_number/files`, {
				owner: this.base.repositoryCloneUrl.owner,
				pull_number: this.number,
				repo: remote.repositoryName,
				per_page: 100,
			});
		} else {
			// if we're under the limit, just use the result from compareCommits, don't make additional API calls.
			files = data.files as IRawFileChange[];
		}

		Logger.debug(
			`Fetch file changes and merge base of PR #${this.number} - done, total files ${files.length} `,
			PullRequestModel.ID,
		);
		return files;
	}

	/**
	 * Get the current mergeability of the pull request.
	 */
	async getMergeability(): Promise<PullRequestMergeability> {
		try {
			Logger.debug(`Fetch pull request mergeability ${this.number} - enter`, PullRequestModel.ID);
			const { query, remote, schema } = await this.githubRepository.ensure();

			const { data } = await query<PullRequestMergabilityResponse>({
				query: schema.PullRequestMergeability,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: this.number,
				},
			});
			Logger.debug(`Fetch pull request mergeability ${this.number} - done`, PullRequestModel.ID);
			return parseMergeability(data.repository.pullRequest.mergeable, data.repository.pullRequest.mergeStateStatus);
		} catch (e) {
			Logger.appendLine(`PullRequestModel> Unable to fetch PR Mergeability: ${e}`);
			return PullRequestMergeability.Unknown;
		}
	}

	/**
	 * Set a draft pull request as ready to be reviewed.
	 */
	async setReadyForReview(): Promise<any> {
		try {
			const { mutate, schema } = await this.githubRepository.ensure();

			const { data } = await mutate<MarkPullRequestReadyForReviewResponse>({
				mutation: schema.ReadyForReview,
				variables: {
					input: {
						pullRequestId: this.graphNodeId,
					},
				},
			});

			/* __GDPR__
				"pr.readyForReview.success" : {}
			*/
			this._telemetry.sendTelemetryEvent('pr.readyForReview.success');

			return data!.markPullRequestReadyForReview.pullRequest.isDraft;
		} catch (e) {
			/* __GDPR__
				"pr.readyForReview.failure" : {}
			*/
			this._telemetry.sendTelemetryErrorEvent('pr.readyForReview.failure');
			throw e;
		}
	}

	private updateCommentReactions(graphNodeId: string, reactionGroups: ReactionGroup[]) {
		const reviewThread = this._reviewThreadsCache.find(thread =>
			thread.comments.some(c => c.graphNodeId === graphNodeId),
		);
		if (reviewThread) {
			const updatedComment = reviewThread.comments.find(c => c.graphNodeId === graphNodeId);
			if (updatedComment) {
				updatedComment.reactions = parseGraphQLReaction(reactionGroups);
				this._onDidChangeReviewThreads.fire({ added: [], changed: [reviewThread], removed: [] });
			}
		}
	}

	async addCommentReaction(graphNodeId: string, reaction: vscode.CommentReaction): Promise<AddReactionResponse | undefined> {
		const reactionEmojiToContent = getReactionGroup().reduce((prev, curr) => {
			prev[curr.label] = curr.title;
			return prev;
		}, {} as { [key: string]: string });
		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<AddReactionResponse>({
			mutation: schema.AddReaction,
			variables: {
				input: {
					subjectId: graphNodeId,
					content: reactionEmojiToContent[reaction.label!],
				},
			},
		});

		if (!data) {
			throw new Error('Add comment reaction failed.');
		}

		const reactionGroups = data.addReaction.subject.reactionGroups;
		this.updateCommentReactions(graphNodeId, reactionGroups);

		return data;
	}

	async deleteCommentReaction(
		graphNodeId: string,
		reaction: vscode.CommentReaction,
	): Promise<DeleteReactionResponse | undefined> {
		const reactionEmojiToContent = getReactionGroup().reduce((prev, curr) => {
			prev[curr.label] = curr.title;
			return prev;
		}, {} as { [key: string]: string });
		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<DeleteReactionResponse>({
			mutation: schema.DeleteReaction,
			variables: {
				input: {
					subjectId: graphNodeId,
					content: reactionEmojiToContent[reaction.label!],
				},
			},
		});

		if (!data) {
			throw new Error('Delete comment reaction failed.');
		}

		const reactionGroups = data.removeReaction.subject.reactionGroups;
		this.updateCommentReactions(graphNodeId, reactionGroups);

		return data;
	}

	async resolveReviewThread(threadId: string): Promise<void> {
		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<ResolveReviewThreadResponse>({
			mutation: schema.ResolveReviewThread,
			variables: {
				input: {
					threadId,
				},
			},
		});

		if (!data) {
			throw new Error('Resolve review thread failed.');
		}

		const index = this._reviewThreadsCache.findIndex(thread => thread.id === threadId);
		if (index > -1) {
			const thread = parseGraphQLReviewThread(data.resolveReviewThread.thread);
			this._reviewThreadsCache.splice(index, 1, thread);
			this._onDidChangeReviewThreads.fire({ added: [], changed: [thread], removed: [] });
		}
	}

	async unresolveReviewThread(threadId: string): Promise<void> {
		const { mutate, schema } = await this.githubRepository.ensure();
		const { data } = await mutate<UnresolveReviewThreadResponse>({
			mutation: schema.UnresolveReviewThread,
			variables: {
				input: {
					threadId,
				},
			},
		});

		if (!data) {
			throw new Error('Unresolve review thread failed.');
		}

		const index = this._reviewThreadsCache.findIndex(thread => thread.id === threadId);
		if (index > -1) {
			const thread = parseGraphQLReviewThread(data.unresolveReviewThread.thread);
			this._reviewThreadsCache.splice(index, 1, thread);
			this._onDidChangeReviewThreads.fire({ added: [], changed: [thread], removed: [] });
		}
	}

	async initializePullRequestFileViewState(): Promise<void> {
		const { query, schema, remote } = await this.githubRepository.ensure();

		const changed: { fileName: string, viewed: ViewedState }[] = [];
		let after: string | null = null;
		let hasNextPage = false;

		do {
			const { data } = await query<PullRequestFilesResponse>({
				query: schema.PullRequestFiles,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: this.number,
					after: after,
				},
			});

			data.repository.pullRequest.files.nodes.forEach(n => {
				if (this._fileChangeViewedState[n.path] !== n.viewerViewedState) {
					changed.push({ fileName: n.path, viewed: n.viewerViewedState });
				}

				this.setFileViewedState(n.path, n.viewerViewedState, false);
			});

			hasNextPage = data.repository.pullRequest.files.pageInfo.hasNextPage;
			after = data.repository.pullRequest.files.pageInfo.endCursor;
		} while (hasNextPage);

		if (changed.length) {
			this.setFileViewedContext();
			this._onDidChangeFileViewedState.fire({ changed });
		}
	}

	async markFileAsViewed(filePathOrSubpath: string): Promise<void> {
		const { mutate, schema } = await this.githubRepository.ensure();
		const fileName = filePathOrSubpath.startsWith(this.githubRepository.rootUri.path) ?
			filePathOrSubpath.substring(this.githubRepository.rootUri.path.length + 1) : filePathOrSubpath;
		await mutate<void>({
			mutation: schema.MarkFileAsViewed,
			variables: {
				input: {
					path: fileName,
					pullRequestId: this.graphNodeId,
				},
			},
		});

		this.setFileViewedState(fileName, ViewedState.VIEWED, true);
	}

	async unmarkFileAsViewed(filePathOrSubpath: string): Promise<void> {
		const { mutate, schema } = await this.githubRepository.ensure();
		const fileName = filePathOrSubpath.startsWith(this.githubRepository.rootUri.path) ?
			filePathOrSubpath.substring(this.githubRepository.rootUri.path.length + 1) : filePathOrSubpath;
		await mutate<void>({
			mutation: schema.UnmarkFileAsViewed,
			variables: {
				input: {
					path: fileName,
					pullRequestId: this.graphNodeId,
				},
			},
		});

		this.setFileViewedState(fileName, ViewedState.UNVIEWED, true);
	}

	private setFileViewedState(fileSubpath: string, viewedState: ViewedState, event: boolean) {
		const filePath = vscode.Uri.joinPath(this.githubRepository.rootUri, fileSubpath).fsPath;
		switch (viewedState) {
			case ViewedState.DISMISSED: {
				this._viewedFiles.delete(filePath);
				this._unviewedFiles.delete(filePath);
				break;
			}
			case ViewedState.UNVIEWED: {
				this._viewedFiles.delete(filePath);
				this._unviewedFiles.add(filePath);
				break;
			}
			case ViewedState.VIEWED: {
				this._viewedFiles.add(filePath);
				this._unviewedFiles.delete(filePath);
			}
		}
		this._fileChangeViewedState[fileSubpath] = viewedState;
		if (event) {
			this.setFileViewedContext();
			this._onDidChangeFileViewedState.fire({ changed: [{ fileName: fileSubpath, viewed: viewedState }] });
		}
	}

	private setFileViewedContext() {
		// TODO: only do if this is the active PR.
		commands.setContext(contexts.VIEWED_FILES, Array.from(this._viewedFiles));
		commands.setContext(contexts.UNVIEWED_FILES, Array.from(this._unviewedFiles));
	}
}
