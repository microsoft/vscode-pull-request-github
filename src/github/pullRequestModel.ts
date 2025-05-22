/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as buffer from 'buffer';
import * as path from 'path';
import equals from 'fast-deep-equal';
import gql from 'graphql-tag';
import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { COPILOT_ACCOUNTS, DiffSide, IComment, IReviewThread, SubjectType, ViewedState } from '../common/comment';
import { getModifiedContentFromDiffHunk, parseDiff } from '../common/diffHunk';
import { GitChangeType, InMemFileChange, SlimFileChange } from '../common/file';
import { GitHubRef } from '../common/githubRef';
import Logger from '../common/logger';
import { Remote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { ClosedEvent, EventType, ReviewEvent, TimelineEvent } from '../common/timelineEvent';
import { resolvePath, Schemes, toPRUri, toReviewUri } from '../common/uri';
import { formatError, isDescendant } from '../common/utils';
import { InMemFileChangeModel, RemoteFileChangeModel } from '../view/fileChangeModel';
import { OctokitCommon } from './common';
import { ConflictResolutionModel } from './conflictResolutionModel';
import { CredentialStore } from './credentials';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GitHubRepository } from './githubRepository';
import {
	AddCommentResponse,
	AddReactionResponse,
	AddReviewThreadResponse,
	DeleteReactionResponse,
	DeleteReviewResponse,
	DequeuePullRequestResponse,
	EditCommentResponse,
	EnqueuePullRequestResponse,
	FileContentResponse,
	GetReviewRequestsResponse,
	LatestReviewCommitResponse,
	MarkPullRequestReadyForReviewResponse,
	PendingReviewIdResponse,
	PullRequestCommentsResponse,
	PullRequestFilesResponse,
	PullRequestMergabilityResponse,
	ReactionGroup,
	ResolveReviewThreadResponse,
	ReviewThread,
	StartReviewResponse,
	SubmitReviewResponse,
	TimelineEventsResponse,
	UnresolveReviewThreadResponse,
} from './graphql';
import {
	AccountType,
	GithubItemStateEnum,
	IAccount,
	IGitTreeItem,
	IRawFileChange,
	IRawFileContent,
	ISuggestedReviewer,
	ITeam,
	MergeMethod,
	MergeQueueEntry,
	PullRequest,
	PullRequestChecks,
	PullRequestMergeability,
	PullRequestReviewRequirement,
	ReadyForReview,
	ReviewEventEnum,
} from './interface';
import { IssueModel } from './issueModel';
import { compareCommits } from './loggingOctokit';
import {
	convertRESTPullRequestToRawPullRequest,
	convertRESTReviewEvent,
	getReactionGroup,
	insertNewCommitsSinceReview,
	parseAccount,
	parseCombinedTimelineEvents,
	parseGraphQLComment,
	parseGraphQLReaction,
	parseGraphQLReviewers,
	parseGraphQLReviewEvent,
	parseGraphQLReviewThread,
	parseMergeability,
	parseMergeQueueEntry,
	RestAccount,
	restPaginate,
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

const BATCH_SIZE = 100;

export class PullRequestModel extends IssueModel<PullRequest> implements IPullRequestModel {
	static override ID = 'PullRequestModel';

	public isDraft?: boolean;
	public localBranchName?: string;
	public mergeBase?: string;
	public mergeQueueEntry?: MergeQueueEntry;
	public conflicts?: string[];
	public suggestedReviewers?: ISuggestedReviewer[];
	public hasChangesSinceLastReview?: boolean;
	private _showChangesSinceReview: boolean;
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

	private _onDidChangeChangesSinceReview = new vscode.EventEmitter<void>();
	public onDidChangeChangesSinceReview = this._onDidChangeChangesSinceReview.event;

	private _hasComments: boolean;
	private _comments: readonly IComment[] | undefined;
	private _onDidChangeComments: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidChangeComments: vscode.Event<void> = this._onDidChangeComments.event;

	// Whether the pull request is currently checked out locally
	private _isActive: boolean;
	public get isActive(): boolean {
		return this._isActive;
	}
	public set isActive(isActive: boolean) {
		this._isActive = isActive;
	}

	_telemetry: ITelemetry;

	constructor(
		private readonly credentialStore: CredentialStore,
		telemetry: ITelemetry,
		githubRepository: GitHubRepository,
		remote: Remote,
		item: PullRequest,
		isActive?: boolean,
	) {
		super(githubRepository, remote, item, true);

		this._telemetry = telemetry;
		this.isActive = !!isActive;

		this._showChangesSinceReview = false;

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

	public get hasPendingReview(): boolean {
		return this._hasPendingReview;
	}

	public set hasPendingReview(hasPendingReview: boolean) {
		if (this._hasPendingReview !== hasPendingReview) {
			this._hasPendingReview = hasPendingReview;
			this._onDidChangePendingReviewState.fire(this._hasPendingReview);
		}
	}

	public get showChangesSinceReview() {
		return this._showChangesSinceReview;
	}

	public set showChangesSinceReview(isChangesSinceReview: boolean) {
		if (this._showChangesSinceReview !== isChangesSinceReview) {
			this._showChangesSinceReview = isChangesSinceReview;
			this._fileChanges.clear();
			this._onDidChangeChangesSinceReview.fire();
		}
	}

	get comments(): readonly IComment[] {
		return this._comments ?? [];
	}

	set comments(comments: readonly IComment[]) {
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

	protected override updateState(state: string) {
		if (state.toLowerCase() === 'open') {
			this.state = GithubItemStateEnum.Open;
		} else if (state.toLowerCase() === 'merged' || this.item.merged) {
			this.state = GithubItemStateEnum.Merged;
		} else {
			this.state = GithubItemStateEnum.Closed;
		}
	}

	override update(item: PullRequest): void {
		super.update(item);
		this.isDraft = item.isDraft;
		this.suggestedReviewers = item.suggestedReviewers;

		if (item.isRemoteHeadDeleted != null) {
			this.isRemoteHeadDeleted = item.isRemoteHeadDeleted;
		}
		if (item.head) {
			this.head = new GitHubRef(item.head.ref, item.head.label, item.head.sha, item.head.repo.cloneUrl, item.head.repo.owner, item.head.repo.name, item.head.repo.isInOrganization);
		}

		if (item.isRemoteBaseDeleted != null) {
			this.isRemoteBaseDeleted = item.isRemoteBaseDeleted;
		}
		if (item.base) {
			this.base = new GitHubRef(item.base.ref, item.base!.label, item.base!.sha, item.base!.repo.cloneUrl, item.base.repo.owner, item.base.repo.name, item.base.repo.isInOrganization);
		}
		if (item.mergeQueueEntry !== undefined) {
			this.mergeQueueEntry = item.mergeQueueEntry ?? undefined;
		}
		if (item.hasComments !== undefined) {
			this._hasComments = item.hasComments;
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

		const reason = vscode.l10n.t('There is no upstream branch for Pull Request #{0}. View it on GitHub for more details', this.number);

		if (message) {
			message += `: ${reason}`;
		} else {
			message = reason;
		}

		const openString = vscode.l10n.t('Open on GitHub');
		vscode.window.showWarningMessage(message, openString).then(action => {
			if (action && action === openString) {
				vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(this.html_url));
			}
		});

		return false;
	}

	protected override updateIssueInput(id: string): Object {
		return {
			pullRequestId: id,
		};
	}

	protected override updateIssueSchema(schema: any): any {
		return schema.UpdatePullRequest;
	}

	/**
	 * Approve the pull request.
	 * @param message Optional approval comment text.
	 */
	async approve(repository: Repository, message?: string): Promise<ReviewEvent> {
		// Check that the remote head of the PR branch matches the local head of the PR branch
		let remoteHead: string | undefined;
		let localHead: string | undefined;
		let rejectMessage: string | undefined;
		if (this.isActive) {
			localHead = repository.state.HEAD?.commit;
			remoteHead = (await this.githubRepository.getPullRequest(this.number))?.head?.sha;
			rejectMessage = vscode.l10n.t('The remote head of the PR branch has changed. Please pull the latest changes from the remote branch before approving.');
		} else {
			localHead = this.head?.sha;
			remoteHead = (await this.githubRepository.getPullRequest(this.number))?.head?.sha;
			rejectMessage = vscode.l10n.t('The remote head of the PR branch has changed. Please refresh the pull request before approving.');
		}

		if (!remoteHead || remoteHead !== localHead) {
			return Promise.reject(rejectMessage);
		}

		const action: Promise<ReviewEvent> = (await this.getPendingReviewId())
			? this.submitReview(ReviewEventEnum.Approve, message)
			: this.createReview(ReviewEventEnum.Approve, message);

		return action.then(x => {
			/* __GDPR__
				"pr.approve" : {}
			*/
			this._telemetry.sendTelemetryEvent('pr.approve');
			this._onDidChangeComments.fire();
			return x;
		});
	}

	/**
	 * Request changes on the pull request.
	 * @param message Optional comment text to leave with the review.
	 */
	async requestChanges(message?: string): Promise<ReviewEvent> {
		const action: Promise<ReviewEvent> = (await this.getPendingReviewId())
			? this.submitReview(ReviewEventEnum.RequestChanges, message)
			: this.createReview(ReviewEventEnum.RequestChanges, message);

		return action.then(x => {
			/* __GDPR__
					"pr.requestChanges" : {}
				*/
			this._telemetry.sendTelemetryEvent('pr.requestChanges');
			this._onDidChangeComments.fire();
			return x;
		});
	}

	/**
	 * Close the pull request.
	 */
	override async close(): Promise<{ item: PullRequest; closedEvent: ClosedEvent }> {
		const { octokit, remote } = await this.githubRepository.ensure();
		const ret = await octokit.call(octokit.api.pulls.update, {
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: this.number,
			state: 'closed',
		});

		/* __GDPR__
			"pr.close" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.close');
		const user = await this.githubRepository.getAuthenticatedUser();
		return {
			item: convertRESTPullRequestToRawPullRequest(ret.data, this.githubRepository),
			closedEvent: {
				createdAt: ret.data.closed_at ?? '',
				event: EventType.Closed,
				id: `${ret.data.id}`,
				actor: {
					login: user.login,
					avatarUrl: user.avatarUrl,
					url: user.url
				}
			}
		};
	}

	/**
	 * Create a new review.
	 * @param event The type of review to create, an approval, request for changes, or comment.
	 * @param message The summary comment text.
	 */
	private async createReview(event: ReviewEventEnum, message?: string): Promise<ReviewEvent> {
		const { octokit, remote } = await this.githubRepository.ensure();

		const { data } = await octokit.call(octokit.api.pulls.createReview, {
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
	async submitReview(event?: ReviewEventEnum, body?: string): Promise<ReviewEvent> {
		let pendingReviewId = await this.getPendingReviewId();
		const { mutate, schema } = await this.githubRepository.ensure();

		if (!pendingReviewId && (event === ReviewEventEnum.Comment)) {
			// Create a new review so that we can comment on it.
			pendingReviewId = await this.startReview();
		}

		if (pendingReviewId) {
			const { data } = await mutate<SubmitReviewResponse>({
				mutation: schema.SubmitReview,
				variables: {
					id: pendingReviewId,
					event: event || ReviewEventEnum.Comment,
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

	/**
	 * Query to see if there is an existing review.
	 */
	async getPendingReviewId(): Promise<string | undefined> {
		const { query, schema } = await this.githubRepository.ensure();
		const currentUser = (await this.githubRepository.getAuthenticatedUser()).login;
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

	async getViewerLatestReviewCommit(): Promise<{ sha: string } | undefined> {
		Logger.debug(`Fetch viewers latest review commit`, IssueModel.ID);
		const { query, remote, schema } = await this.githubRepository.ensure();

		try {
			const { data } = await query<LatestReviewCommitResponse>({
				query: schema.LatestReviewCommit,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: this.number,
				},
			});

			if (data.repository === null) {
				Logger.error('Unexpected null repository while getting last review commit', PullRequestModel.ID);
			}

			return data.repository?.pullRequest.viewerLatestReview ? {
				sha: data.repository?.pullRequest.viewerLatestReview.commit.oid,
			} : undefined;
		}
		catch (e) {
			return undefined;
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
			deletedReviewComments: comments.nodes.map(comment => parseGraphQLComment(comment, false, this.githubRepository)),
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
		this.hasPendingReview = true;
		this._onDidChangeComments.fire();
		return data.addPullRequestReview.pullRequestReview.id;
	}

	/**
	 * Creates a new review thread, either adding it to an existing pending review, or creating
	 * a new review.
	 * @param body The body of the thread's first comment.
	 * @param commentPath The path to the file being commented on.
	 * @param startLine The start line on which to add the comment.
	 * @param endLine The end line on which to add the comment.
	 * @param side The side the comment should be deleted on, i.e. the original or modified file.
	 * @param suppressDraftModeUpdate If a draft mode change should event should be suppressed. In the
	 * case of a single comment add, the review is created and then immediately submitted, so this prevents
	 * a "Pending" label from flashing on the comment.
	 * @returns The new review thread object.
	 */
	async createReviewThread(
		body: string,
		commentPath: string,
		startLine: number | undefined,
		endLine: number | undefined,
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
					startLine: startLine === endLine ? undefined : startLine,
					line: (endLine === undefined) ? 0 : endLine,
					side,
					subjectType: (startLine === undefined || endLine === undefined) ? SubjectType.FILE : SubjectType.LINE
				}
			}
		}, { mutation: schema.LegacyAddReviewThread, deleteProps: ['subjectType'] });

		if (!data) {
			throw new Error('Creating review thread failed.');
		}

		if (!data.addPullRequestReviewThread.thread) {
			throw new Error('File has been deleted.');
		}

		if (!suppressDraftModeUpdate) {
			this.hasPendingReview = true;
			await this.updateDraftModeContext();
		}

		const thread = data.addPullRequestReviewThread.thread;
		const newThread = parseGraphQLReviewThread(thread, this.githubRepository);
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
		const newComment = parseGraphQLComment(comment, false, this.githubRepository);

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
			this.githubRepository
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
				await octokit.call(octokit.api.pulls.deleteReviewComment, {
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

	private async getFileContent(owner: string, sha: string, file: string): Promise<string | undefined> {
		Logger.debug(`Fetch file content - enter`, GitHubRepository.ID);
		const { query, remote, schema } = await this.githubRepository.ensure();
		const { data } = await query<FileContentResponse>({
			query: schema.GetFileContent,
			variables: {
				owner,
				name: remote.repositoryName,
				expression: `${sha}:${file}`
			}
		});

		if (!data.repository?.object.text) {
			return undefined;
		}

		Logger.debug(`Fetch file content - end`, GitHubRepository.ID);

		return data.repository.object.text;
	}

	public async compareBaseBranchForMerge(headOwner: string, headRef: string, baseOwner: string, baseRef: string): Promise<IRawFileChange[]> {
		const { octokit, remote } = await this.githubRepository.ensure();

		// Get the files that would change as part of the merge
		const compareData = await octokit.call(octokit.api.repos.compareCommits, {
			repo: remote.repositoryName,
			owner: headOwner,
			base: `${headOwner}:${headRef}`, // flip base and head because we are comparing for a merge to update the PR
			head: `${baseOwner}:${baseRef}`,
		});

		return compareData?.data?.files?.filter<IRawFileChange>((change): change is IRawFileChange => change !== undefined) ?? [];
	}

	private async getUpdateBranchFiles(baseCommitSha: string, headTreeSha: string, model: ConflictResolutionModel): Promise<IGitTreeItem[]> {
		if (this.item.mergeable === PullRequestMergeability.Conflict && (!model.resolvedConflicts || model.resolvedConflicts.size === 0)) {
			throw new Error('Pull Request has conflicts but no resolutions were provided.');
		}
		const { octokit } = await this.githubRepository.ensure();

		// Get the files that would change as part of the merge
		const compareData = await this.compareBaseBranchForMerge(model.prHeadOwner, model.prHeadBranchName, model.prBaseOwner, baseCommitSha);
		const baseTreeSha = (await octokit.call(octokit.api.repos.getCommit, { owner: model.prBaseOwner, repo: model.repositoryName, ref: baseCommitSha })).data.commit.tree.sha;
		const baseTree = await octokit.call(octokit.api.git.getTree, { owner: model.prBaseOwner, repo: model.repositoryName, tree_sha: baseTreeSha, recursive: 'true' });

		const files: IGitTreeItem[] = (await Promise.all(compareData.map(async (file) => {
			if (!file) {
				return;
			}

			const baseTreeData = baseTree.data.tree.find(f => f.path === file.filename);
			const baseMode: '100644' | '100755' | '120000' = baseTreeData?.mode as any ?? '100644';

			const headTree = await octokit.call(octokit.api.git.getTree, { owner: model.prHeadOwner, repo: model.repositoryName, tree_sha: headTreeSha, recursive: 'true' });
			const headTreeData = headTree.data.tree.find(f => f.path === file.filename);
			const headMode: '100644' | '100755' | '120000' = headTreeData?.mode as any ?? '100644';

			if (file.status === 'removed') {
				// The file was removed so we use a null sha to indicate that (per GitHub's API).
				// If we've made it this far, we already know that there are no conflicts in the file and it's safe to delete.
				return { path: file.filename, sha: null, mode: headTreeData?.mode ?? '100644' };
			}

			const treeItem: IGitTreeItem = {
				path: file.filename,
				mode: baseMode
			};

			const resolvedConflict = model.resolvedConflicts.get(file.filename);
			if (resolvedConflict?.resolvedContents !== undefined) {
				if (file.status !== 'modified') {
					throw new Error(`Only modified file are supported for conflict resolution ${file.filename}: ${file.status}`);
				}

				if (baseMode !== headMode) {
					throw new Error(`Conflict resolution not supported for file with different modes ${file.filename}: ${baseMode} -> ${headMode}`);
				}

				if (file.previous_filename) {
					throw new Error('Conflict resolution not supported for renamed files');
				}
				treeItem.content = resolvedConflict.resolvedContents;
				return treeItem;
			}

			if ((!file.previous_filename || !this._fileChanges.has(file.previous_filename)) && !this._fileChanges.has(file.filename)) {
				// File is not part of the PR, so we don't need to bother getting any content and can just use the sha
				treeItem.sha = file.sha;
				return treeItem;
			}

			// File is part of the PR. We have to apply the patch of the base to the head content.
			const { data: headData }: { data: IRawFileContent } = await octokit.call(octokit.api.repos.getContent, {
				owner: model.prHeadOwner,
				repo: model.repositoryName,
				path: file?.previous_filename ?? file.filename,
				ref: model.prHeadBranchName
			}) as { data: IRawFileContent };

			if (file.status === 'modified' && file.patch && headData.content) {
				const buff = buffer.Buffer.from(headData.content, 'base64');
				const asString = new TextDecoder().decode(buff);
				treeItem.content = getModifiedContentFromDiffHunk(asString, file.patch);
			} else {
				// binary file or file that otherwise doesn't have a patch
				// This cannot be resolved by us and must manually be resolved by the user
				Logger.error(`File ${file.filename} has status ${file.status} and can't be merged.`, GitHubRepository.ID);
				// We don't want to commit something that's going to break, so throw
				throw new Error(`File ${file.filename} has status ${file.status} and can't be merged,`);
			}
			return treeItem;

		}))).filter<IGitTreeItem>((file): file is IGitTreeItem => file !== undefined);
		return files;
	}

	async getLatestBaseCommitSha(): Promise<string> {
		const base = this.base;
		if (!base) {
			throw new Error('Base branch not yet set.');
		}
		const { octokit, remote } = await this.githubRepository.ensure();
		return (await octokit.call(octokit.api.repos.getBranch, { owner: remote.owner, repo: remote.repositoryName, branch: this.base.ref })).data.commit.sha;
	}

	async updateBranch(model: ConflictResolutionModel): Promise<boolean> {
		if (this.item.mergeable === PullRequestMergeability.Conflict && (!model.resolvedConflicts || model.resolvedConflicts.size === 0)) {
			throw new Error('Pull Request has conflicts but no resolutions were provided.');
		}

		Logger.debug(`Updating branch ${model.prHeadBranchName} to ${model.prBaseBranchName} - enter`, GitHubRepository.ID);
		try {
			const { octokit } = await this.githubRepository.ensure();

			const lastCommitSha = (await octokit.call(octokit.api.repos.getBranch, { owner: model.prHeadOwner, repo: model.repositoryName, branch: model.prHeadBranchName })).data.commit.sha;
			const lastTreeSha = (await octokit.call(octokit.api.repos.getCommit, { owner: model.prHeadOwner, repo: model.repositoryName, ref: lastCommitSha })).data.commit.tree.sha;

			const treeItems: IGitTreeItem[] = await this.getUpdateBranchFiles(model.latestPrBaseSha, lastTreeSha, model);

			const newTreeSha = (await octokit.call(octokit.api.git.createTree, { owner: model.prHeadOwner, repo: model.repositoryName, base_tree: lastTreeSha, tree: treeItems })).data.sha;
			let message: string;
			if (model.prBaseOwner === model.prHeadOwner) {
				message = `Merge branch \`${model.prBaseBranchName}\` into ${model.prHeadBranchName}`;
			} else {
				message = `Merge branch \`${model.prBaseOwner}:${model.prBaseBranchName}\` into ${model.prHeadBranchName}`;
			}
			const newCommitSha = (await octokit.call(octokit.api.git.createCommit, { owner: model.prHeadOwner, repo: model.repositoryName, message, tree: newTreeSha, parents: [lastCommitSha, model.latestPrBaseSha] })).data.sha;
			await octokit.call(octokit.api.git.updateRef, { owner: model.prHeadOwner, repo: model.repositoryName, ref: `heads/${model.prHeadBranchName}`, sha: newCommitSha });

		} catch (e) {
			Logger.error(`Updating branch ${model.prHeadBranchName} to ${model.prBaseBranchName} failed: ${e}`, GitHubRepository.ID);
			return false;
		}
		Logger.debug(`Updating branch ${model.prHeadBranchName} to ${model.prBaseBranchName} - done`, GitHubRepository.ID);
		return true;
	}

	/**
	 * Get existing requests to review.
	 */
	async getReviewRequests(): Promise<(IAccount | ITeam)[]> {
		Logger.debug('Get Review Requests - enter', PullRequestModel.ID);

		const githubRepository = this.githubRepository;
		const { remote, query, schema } = await githubRepository.ensure();

		const { data } = await query<GetReviewRequestsResponse>({
			query: this.credentialStore.isAuthenticatedWithAdditionalScopes(githubRepository.remote.authProviderId) ? schema.GetReviewRequestsAdditionalScopes : schema.GetReviewRequests,
			variables: {
				number: this.number,
				owner: remote.owner,
				name: remote.repositoryName
			},
		});

		if (data.repository === null) {
			Logger.error('Unexpected null repository while getting review requests', PullRequestModel.ID);
			return [];
		}

		const reviewers: (IAccount | ITeam)[] = parseGraphQLReviewers(data, githubRepository);
		Logger.debug('Get Review Requests - done', PullRequestModel.ID);
		return reviewers;
	}

	/**
	 * Add reviewers to a pull request
	 * @param reviewers A list of GitHub logins
	 */
	async requestReview(reviewers: IAccount[], teamReviewers: ITeam[], union: boolean = false): Promise<void> {
		const { mutate, schema } = await this.githubRepository.ensure();
		await mutate({
			mutation: schema.AddReviewers,
			variables: {
				input: {
					pullRequestId: this.graphNodeId,
					teamIds: teamReviewers.map(t => t.id),
					userIds: reviewers.filter(r => r.accountType !== AccountType.Bot).map(r => r.id),
					union
				},
			},
		});
	}

	/**
	 * Remove a review request that has not yet been completed
	 * @param reviewer A GitHub Login
	 */
	async deleteReviewRequest(reviewers: IAccount[], teamReviewers: ITeam[]): Promise<void> {
		const { octokit, remote } = await this.githubRepository.ensure();
		await octokit.call(octokit.api.pulls.removeRequestedReviewers, {
			owner: remote.owner,
			repo: remote.repositoryName,
			pull_number: this.number,
			reviewers: reviewers.filter(r => r.accountType !== AccountType.Bot).map(r => r.id),
			team_reviewers: teamReviewers.map(t => t.id)
		});
	}

	private diffThreads(oldReviewThreads: IReviewThread[], newReviewThreads: IReviewThread[]): void {
		const added: IReviewThread[] = [];
		const changed: IReviewThread[] = [];
		const removed: IReviewThread[] = [];

		newReviewThreads.forEach(thread => {
			const existingThread = oldReviewThreads.find(t => t.id === thread.id);
			if (existingThread) {
				if (!equals(thread, existingThread)) {
					changed.push(thread);
				}
			} else {
				added.push(thread);
			}
		});

		oldReviewThreads.forEach(thread => {
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

	async initializeReviewThreadCacheAndReviewComments(): Promise<void> {
		const { remote } = await this.githubRepository.ensure();
		const raw = await this.getRawReviewComments();

		this.setReviewThreadCacheFromRaw(raw);

		this.comments = raw.map(node => node.comments.nodes.map(comment => parseGraphQLComment(comment, node.isResolved, this.githubRepository), remote))
			.reduce((prev, curr) => prev.concat(curr), [])
			.sort((a: IComment, b: IComment) => {
				return a.createdAt > b.createdAt ? 1 : -1;
			});
	}

	private setReviewThreadCacheFromRaw(raw: ReviewThread[]): IReviewThread[] {
		const reviewThreads: IReviewThread[] = raw.map(thread => parseGraphQLReviewThread(thread, this.githubRepository));
		const oldReviewThreads = this._reviewThreadsCache;
		this._reviewThreadsCache = reviewThreads;
		this.diffThreads(oldReviewThreads, reviewThreads);
		return reviewThreads;
	}

	private async getRawReviewComments(): Promise<ReviewThread[]> {
		const { remote, query, schema } = await this.githubRepository.ensure();
		let after: string | null = null;
		let hasNextPage = false;
		const reviewThreads: ReviewThread[] = [];
		try {
			do {
				const { data } = await query<PullRequestCommentsResponse>({
					query: schema.PullRequestComments,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						number: this.number,
						after
					},
				}, false, { query: schema.LegacyPullRequestComments });

				reviewThreads.push(...data.repository.pullRequest.reviewThreads.nodes);

				hasNextPage = data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage;
				after = data.repository.pullRequest.reviewThreads.pageInfo.endCursor;
			} while (hasNextPage && reviewThreads.length < 1000);

			return reviewThreads;
		} catch (e) {
			Logger.error(`Failed to get pull request review comments: ${e}`, PullRequestModel.ID);
			return [];
		}
	}

	async getReviewThreads(): Promise<IReviewThread[]> {
		const raw = await this.getRawReviewComments();
		return this.setReviewThreadCacheFromRaw(raw);
	}

	/**
	 * Get a list of the commits within a pull request.
	 */
	async getCommits(): Promise<OctokitCommon.PullsListCommitsResponseData> {
		try {
			Logger.debug(`Fetch commits of PR #${this.number} - enter`, PullRequestModel.ID);
			const { remote, octokit } = await this.githubRepository.ensure();
			const commitData = await restPaginate<typeof octokit.api.pulls.listCommits, OctokitCommon.PullsListCommitsResponseData[0]>(octokit.api.pulls.listCommits, {
				pull_number: this.number,
				owner: remote.owner,
				repo: remote.repositoryName,
			});
			Logger.debug(`Fetch commits of PR #${this.number} - done`, PullRequestModel.ID);

			return commitData;
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
			const fullCommit = await octokit.call(octokit.api.repos.getCommit, {
				owner: remote.owner,
				repo: remote.repositoryName,
				ref: commit.sha,
			});
			Logger.debug(
				`Fetch file changes of commit ${commit.sha} in PR #${this.number} - done`,
				PullRequestModel.ID,
			);

			return fullCommit.data.files ?? [];
		} catch (e) {
			vscode.window.showErrorMessage(`Fetching commit file changes failed: ${formatError(e)}`);
			return [];
		}
	}

	async getCoAuthors(): Promise<IAccount[]> {
		// To save time, we only do for Copilot now as that's where we need it
		if (!COPILOT_ACCOUNTS[this.item.user.login]) {
			return [];
		}
		const { octokit, remote } = await this.githubRepository.ensure();
		const timeline = await octokit.call(octokit.api.issues.listEventsForTimeline, {
			issue_number: this.number,
			owner: remote.owner,
			repo: remote.repositoryName,
			per_page: 100
		});
		const workStartedInitiator = (timeline.data.find(event => event.event === 'copilot_work_started') as { actor: RestAccount } | undefined)?.actor;
		return workStartedInitiator ? [parseAccount(workStartedInitiator, this.githubRepository)] : [];
	}

	/**
	 * Get the timeline events of a pull request, including comments, reviews, commits, merges, deletes, and assigns.
	 */
	async getTimelineEvents(): Promise<TimelineEvent[]> {
		const getTimelineEvents = async () => {
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

				if (data.repository === null) {
					Logger.error('Unexpected null repository when fetching timeline', PullRequestModel.ID);
				}
				return data;
			} catch (e) {
				Logger.error(`Failed to get pull request timeline events: ${e}`, PullRequestModel.ID);
				console.log(e);
				return undefined;
			}
		};

		const [data, latestReviewCommitInfo, currentUser, reviewThreads] = await Promise.all([
			getTimelineEvents(),
			this.getViewerLatestReviewCommit(),
			(await this.githubRepository.getAuthenticatedUser()).login,
			this.getReviewThreads()
		]);


		const ret = data?.repository?.pullRequest.timelineItems.nodes ?? [];
		const events = await parseCombinedTimelineEvents(ret, await this.getRestOnlyTimelineEvents(), this.githubRepository);

		this.addReviewTimelineEventComments(events, reviewThreads);
		insertNewCommitsSinceReview(events, latestReviewCommitInfo?.sha, currentUser, this.head);
		Logger.debug(`Fetch timeline events of PR #${this.number} - done`, PullRequestModel.ID);
		return events;
	}

	protected override getUpdatesQuery(schema: any): any {
		return schema.LatestUpdates;
	}

	private addReviewTimelineEventComments(events: TimelineEvent[], reviewThreads: IReviewThread[]): void {
		interface CommentNode extends IComment {
			childComments?: CommentNode[];
		}

		const reviewEvents = events.filter((e): e is ReviewEvent => e.event === EventType.Reviewed);
		const reviewComments = reviewThreads.reduce((previous, current) => (previous as IComment[]).concat(current.comments), []);

		const reviewEventsById = reviewEvents.reduce((index, evt) => {
			index[evt.id] = evt;
			evt.comments = [];
			return index;
		}, {} as { [key: number]: ReviewEvent });

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

		reviewThreads.forEach(thread => {
			if (!thread.prReviewDatabaseId || !reviewEventsById[thread.prReviewDatabaseId]) {
				return;
			}
			const prReviewThreadEvent = reviewEventsById[thread.prReviewDatabaseId];
			prReviewThreadEvent.reviewThread = {
				threadId: thread.id,
				canResolve: thread.viewerCanResolve,
				canUnresolve: thread.viewerCanUnresolve,
				isResolved: thread.isResolved
			};

		});

		const pendingReview = reviewEvents.filter(r => r.state?.toLowerCase() === 'pending')[0];
		if (pendingReview) {
			// Ensures that pending comments made in reply to other reviews are included for the pending review
			pendingReview.comments = reviewComments.filter(c => c.isDraft);
		}
	}

	/**
	 * Get the status checks of the pull request, those for the last commit.
	 */
	async getStatusChecks(): Promise<[PullRequestChecks | null, PullRequestReviewRequirement | null]> {
		return this.githubRepository.getStatusChecks(this.number);
	}

	static async openChanges(folderManager: FolderRepositoryManager, pullRequestModel: PullRequestModel) {
		const changeModels = await PullRequestModel.getChangeModels(folderManager, pullRequestModel);
		const args: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
		for (const changeModel of changeModels) {
			args.push([changeModel.filePath, changeModel.parentFilePath, changeModel.filePath]);
		}

		/* __GDPR__
			"pr.openChanges" : {}
		*/
		folderManager.telemetry.sendTelemetryEvent('pr.openChanges');
		return vscode.commands.executeCommand('vscode.changes', vscode.l10n.t('Changes in Pull Request #{0}', pullRequestModel.number), args);
	}

	static async openDiffFromComment(
		folderManager: FolderRepositoryManager,
		pullRequestModel: PullRequestModel,
		comment: IComment,
	): Promise<void> {
		const contentChanges = await pullRequestModel.getFileChangesInfo();
		const change = contentChanges.find(
			fileChange => fileChange.fileName === comment.path || fileChange.previousFileName === comment.path,
		);
		if (!change) {
			throw new Error(`Can't find matching file`);
		}

		const pathSegments = comment.path!.split('/');
		const line = (comment.diffHunks && comment.diffHunks.length > 0) ? comment.diffHunks[0].newLineNumber : undefined;
		this.openDiff(folderManager, pullRequestModel, change, pathSegments[pathSegments.length - 1], line);
	}

	static async openFirstDiff(
		folderManager: FolderRepositoryManager,
		pullRequestModel: PullRequestModel,
	) {
		const contentChanges = await pullRequestModel.getFileChangesInfo();
		if (!contentChanges.length) {
			return;
		}

		const firstChange = contentChanges[0];
		this.openDiff(folderManager, pullRequestModel, firstChange, firstChange.fileName);
	}

	static async openDiff(
		folderManager: FolderRepositoryManager,
		pullRequestModel: PullRequestModel,
		change: SlimFileChange | InMemFileChange,
		diffTitle: string,
		line?: number
	): Promise<void> {
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
				change.previousFileName
			);
			baseUri = toPRUri(
				vscode.Uri.file(resolvePath(folderManager.repository.rootUri, parentFileName)),
				pullRequestModel,
				change.baseCommit,
				headCommit,
				change.fileName,
				true,
				change.status,
				change.previousFileName
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

		vscode.commands.executeCommand(
			'vscode.diff',
			baseUri,
			headUri,
			`${diffTitle} (Pull Request)`,
			line ? { selection: { start: { line, character: 0 }, end: { line, character: 0 } } } : {},
		);
	}

	private _fileChanges: Map<string, SlimFileChange | InMemFileChange> = new Map();
	get fileChanges(): Map<string, SlimFileChange | InMemFileChange> {
		return this._fileChanges;
	}

	async getFileChangesInfo() {
		this._fileChanges.clear();
		const data = await this.getRawFileChangesInfo();
		const mergebase = this.mergeBase || this.base.sha;
		const parsed = await parseDiff(data, mergebase);
		parsed.forEach(fileChange => {
			this._fileChanges.set(fileChange.fileName, fileChange);
		});
		return parsed;
	}

	public static async getChangeModels(folderManager: FolderRepositoryManager, pullRequestModel: PullRequestModel): Promise<(RemoteFileChangeModel | InMemFileChangeModel)[]> {
		const isCurrentPR = folderManager.activePullRequest?.number === pullRequestModel.number;
		const changes = pullRequestModel.fileChanges.size > 0 ? pullRequestModel.fileChanges.values() : await pullRequestModel.getFileChangesInfo();
		const changeModels: (RemoteFileChangeModel | InMemFileChangeModel)[] = [];
		for (const change of changes) {
			let changeModel;
			if (change instanceof SlimFileChange) {
				changeModel = new RemoteFileChangeModel(folderManager, change, pullRequestModel);
			} else {
				changeModel = new InMemFileChangeModel(folderManager, pullRequestModel as (PullRequestModel & IResolvedPullRequestModel), change, isCurrentPR, pullRequestModel.mergeBase!);
			}
			changeModels.push(changeModel);
		}
		return changeModels;
	}

	/**
	 * List the changed files in a pull request.
	 */
	private async getRawFileChangesInfo(): Promise<IRawFileChange[]> {
		Logger.debug(`Fetch file changes, base, head and merge base of PR #${this.number} - enter`, PullRequestModel.ID);

		const githubRepository = this.githubRepository;
		const { octokit, remote } = await githubRepository.ensure();

		if (!this.base) {
			Logger.appendLine('No base branch found for PR, fetching it now', PullRequestModel.ID);
			const info = await octokit.call(octokit.api.pulls.get, {
				owner: remote.owner,
				repo: remote.repositoryName,
				pull_number: this.number,
			});
			this.update(convertRESTPullRequestToRawPullRequest(info.data, githubRepository));
		}

		let compareWithBaseRef = this.base.sha;
		const latestReview = await this.getViewerLatestReviewCommit();
		const oldHasChangesSinceReview = this.hasChangesSinceLastReview;
		this.hasChangesSinceLastReview = latestReview !== undefined && this.head?.sha !== latestReview.sha;

		if (this._showChangesSinceReview && this.hasChangesSinceLastReview && latestReview != undefined) {
			compareWithBaseRef = latestReview.sha;
		}

		if (this.item.merged) {
			Logger.appendLine('PR is merged, fetching all file changes', PullRequestModel.ID);
			const response = await restPaginate<typeof octokit.api.pulls.listFiles, IRawFileChange>(octokit.api.pulls.listFiles, {
				repo: remote.repositoryName,
				owner: remote.owner,
				pull_number: this.number,
			});

			// Use the original base to compare against for merged PRs
			this.mergeBase = this.base.sha;

			return response;
		}

		Logger.debug(`Comparing commits for ${remote.owner}/${remote.repositoryName} with base ${this.base.repositoryCloneUrl.owner}:${compareWithBaseRef} and head ${this.head!.repositoryCloneUrl.owner}:${this.head!.sha}`, PullRequestModel.ID);
		const { files, mergeBaseSha } = await compareCommits(remote, octokit, this.base, this.head!, compareWithBaseRef, this.number, PullRequestModel.ID);
		this.mergeBase = mergeBaseSha;

		if (oldHasChangesSinceReview !== undefined && oldHasChangesSinceReview !== this.hasChangesSinceLastReview && this.hasChangesSinceLastReview && this._showChangesSinceReview) {
			this._onDidChangeChangesSinceReview.fire();
		}

		Logger.debug(
			`Fetch file changes and merge base of PR #${this.number} - done, total files ${files.length} `,
			PullRequestModel.ID,
		);
		return files;
	}

	get autoMerge(): boolean {
		return !!this.item.autoMerge;
	}

	get autoMergeMethod(): MergeMethod | undefined {
		return this.item.autoMergeMethod;
	}

	get allowAutoMerge(): boolean {
		return !!this.item.allowAutoMerge;
	}

	get mergeCommitMeta(): { title: string; description: string } | undefined {
		return this.item.mergeCommitMeta;
	}

	get squashCommitMeta(): { title: string; description: string } | undefined {
		return this.item.squashCommitMeta;
	}

	get hasComments(): boolean {
		return this._hasComments;
	}

	/**
	 * Get the current mergeability of the pull request.
	 */
	async getMergeability(): Promise<{ mergeability: PullRequestMergeability, conflicts?: string[] }> {
		try {
			Logger.debug(`Fetch pull request mergeability ${this.number} - enter`, PullRequestModel.ID);
			const { query, remote, schema } = await this.githubRepository.ensure();

			// hard code the users for selfhost purposes
			const { data } = (schema.PullRequestMergeabilityMergeRequirements && ((await this.credentialStore.getCurrentUser(this.remote.authProviderId))?.login === 'alexr00')) ? await query<PullRequestMergabilityResponse>({
				query: schema.PullRequestMergeabilityMergeRequirements,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: this.number,
				},
				context: {
					headers: {
						'GraphQL-Features': 'pull_request_merge_requirements_api' // This flag allows specific users to test a private field.
					}
				}
			}) : await query<PullRequestMergabilityResponse>({
				query: schema.PullRequestMergeability,
				variables: {
					owner: remote.owner,
					name: remote.repositoryName,
					number: this.number,
				}
			});
			if (data.repository === null) {
				Logger.error('Unexpected null repository while getting mergeability', PullRequestModel.ID);
			}

			Logger.debug(`Fetch pull request mergeability ${this.number} - done`, PullRequestModel.ID);
			const mergeability = parseMergeability(data.repository?.pullRequest.mergeable, data.repository?.pullRequest.mergeStateStatus);
			this.item.mergeable = mergeability;
			this.conflicts = data.repository?.pullRequest.mergeRequirements?.conditions.find(condition => condition.__typename === 'PullRequestMergeConflictStateCondition')?.conflicts;
			this.update(this.item);
			return { mergeability, conflicts: this.conflicts };
		} catch (e) {
			Logger.error(`Unable to fetch PR Mergeability: ${e}`, PullRequestModel.ID);
			return { mergeability: PullRequestMergeability.Unknown };
		}
	}

	/**
	 * Set a draft pull request as ready to be reviewed.
	 */
	async setReadyForReview(): Promise<ReadyForReview> {
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

			const result: ReadyForReview = {
				isDraft: data!.markPullRequestReadyForReview.pullRequest.isDraft,
				mergeable: parseMergeability(data!.markPullRequestReadyForReview.pullRequest.mergeable, data!.markPullRequestReadyForReview.pullRequest.mergeStateStatus),
				allowAutoMerge: data!.markPullRequestReadyForReview.pullRequest.viewerCanEnableAutoMerge || data!.markPullRequestReadyForReview.pullRequest.viewerCanDisableAutoMerge
			};
			this.item.isDraft = result.isDraft;
			this.item.mergeable = result.mergeable;
			this.item.allowAutoMerge = result.allowAutoMerge;
			return result;
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

	private undoOptimisticResolveState(oldThread: IReviewThread | undefined) {
		if (oldThread) {
			oldThread.isResolved = !oldThread.isResolved;
			oldThread.viewerCanResolve = !oldThread.viewerCanResolve;
			oldThread.viewerCanUnresolve = !oldThread.viewerCanUnresolve;
			this._onDidChangeReviewThreads.fire({ added: [], changed: [oldThread], removed: [] });
		}
	}

	async resolveReviewThread(threadId: string): Promise<void> {
		const oldThread = this._reviewThreadsCache.find(thread => thread.id === threadId);

		try {
			Logger.debug(`Resolve review thread - enter`, PullRequestModel.ID);

			const { mutate, schema } = await this.githubRepository.ensure();

			// optimistically update
			if (oldThread && oldThread.viewerCanResolve) {
				oldThread.isResolved = true;
				oldThread.viewerCanResolve = false;
				oldThread.viewerCanUnresolve = true;
				this._onDidChangeReviewThreads.fire({ added: [], changed: [oldThread], removed: [] });
			}

			const { data } = await mutate<ResolveReviewThreadResponse>({
				mutation: schema.ResolveReviewThread,
				variables: {
					input: {
						threadId,
					},
				},
			}, { mutation: schema.LegacyResolveReviewThread, deleteProps: [] });

			if (!data) {
				this.undoOptimisticResolveState(oldThread);
				throw new Error('Resolve review thread failed.');
			}

			const index = this._reviewThreadsCache.findIndex(thread => thread.id === threadId);
			if (index > -1) {
				const thread = parseGraphQLReviewThread(data.resolveReviewThread.thread, this.githubRepository);
				this._reviewThreadsCache.splice(index, 1, thread);
				this._onDidChangeReviewThreads.fire({ added: [], changed: [thread], removed: [] });
			}
			Logger.debug(`Resolve review thread - done`, PullRequestModel.ID);
		} catch (e) {
			Logger.error(`Resolve review thread failed: ${e}`, PullRequestModel.ID);
			this.undoOptimisticResolveState(oldThread);
		}
	}

	async unresolveReviewThread(threadId: string): Promise<void> {
		const oldThread = this._reviewThreadsCache.find(thread => thread.id === threadId);

		try {
			Logger.debug(`Unresolve review thread - enter`, PullRequestModel.ID);

			const { mutate, schema } = await this.githubRepository.ensure();

			// optimistically update
			if (oldThread && oldThread.viewerCanUnresolve) {
				oldThread.isResolved = false;
				oldThread.viewerCanUnresolve = false;
				oldThread.viewerCanResolve = true;
				this._onDidChangeReviewThreads.fire({ added: [], changed: [oldThread], removed: [] });
			}

			const { data } = await mutate<UnresolveReviewThreadResponse>({
				mutation: schema.UnresolveReviewThread,
				variables: {
					input: {
						threadId,
					},
				},
			}, { mutation: schema.LegacyUnresolveReviewThread, deleteProps: [] });

			if (!data) {
				this.undoOptimisticResolveState(oldThread);
				throw new Error('Unresolve review thread failed.');
			}

			const index = this._reviewThreadsCache.findIndex(thread => thread.id === threadId);
			if (index > -1) {
				const thread = parseGraphQLReviewThread(data.unresolveReviewThread.thread, this.githubRepository);
				this._reviewThreadsCache.splice(index, 1, thread);
				this._onDidChangeReviewThreads.fire({ added: [], changed: [thread], removed: [] });
			}
			Logger.debug(`Unresolve review thread - done`, PullRequestModel.ID);
		} catch (e) {
			Logger.error(`Unresolve review thread failed: ${e}`, PullRequestModel.ID);
			this.undoOptimisticResolveState(oldThread);
		}
	}

	async enableAutoMerge(mergeMethod: MergeMethod): Promise<void> {
		try {
			const { mutate, schema } = await this.githubRepository.ensure();
			const { data } = await mutate({
				mutation: schema.EnablePullRequestAutoMerge,
				variables: {
					input: {
						mergeMethod: mergeMethod.toUpperCase(),
						pullRequestId: this.graphNodeId
					}
				}
			});

			if (!data) {
				throw new Error('Enable auto-merge failed.');
			}
			this.item.autoMerge = true;
			this.item.autoMergeMethod = mergeMethod;
		} catch (e) {
			if (e.message === 'GraphQL error: ["Pull request Pull request is in clean status"]') {
				vscode.window.showWarningMessage(vscode.l10n.t('Unable to enable auto-merge. Pull request status checks are already green.'));
			} else {
				throw e;
			}
		}
	}

	async disableAutoMerge(): Promise<void> {
		try {
			const { mutate, schema } = await this.githubRepository.ensure();
			const { data } = await mutate({
				mutation: schema.DisablePullRequestAutoMerge,
				variables: {
					input: {
						pullRequestId: this.graphNodeId
					}
				}
			});

			if (!data) {
				throw new Error('Disable auto-merge failed.');
			}
			this.item.autoMerge = false;
		} catch (e) {
			if (e.message === 'GraphQL error: ["Pull request Pull request is in clean status"]') {
				vscode.window.showWarningMessage(vscode.l10n.t('Unable to enable auto-merge. Pull request status checks are already green.'));
			} else {
				throw e;
			}
		}
	}

	async dequeuePullRequest(): Promise<boolean> {
		Logger.debug(`Dequeue pull request ${this.number} - enter`, GitHubRepository.ID);
		const { mutate, schema } = await this.githubRepository.ensure();
		if (!schema.DequeuePullRequest) {
			return false;
		}
		try {
			await mutate<DequeuePullRequestResponse>({
				mutation: schema.DequeuePullRequest,
				variables: {
					input: {
						id: this.graphNodeId
					}
				}
			});

			Logger.debug(`Dequeue pull request ${this.number} - done`, GitHubRepository.ID);
			this.mergeQueueEntry = undefined;
			return true;
		} catch (e) {
			Logger.error(`Dequeueing pull request failed: ${e}`, GitHubRepository.ID);
			return false;
		}
	}

	async enqueuePullRequest(): Promise<MergeQueueEntry | undefined> {
		Logger.debug(`Enqueue pull request ${this.number} - enter`, GitHubRepository.ID);
		const { mutate, schema } = await this.githubRepository.ensure();
		if (!schema.EnqueuePullRequest) {
			return;
		}
		try {
			const { data } = await mutate<EnqueuePullRequestResponse>({
				mutation: schema.EnqueuePullRequest,
				variables: {
					input: {
						pullRequestId: this.graphNodeId
					}
				}
			});

			Logger.debug(`Enqueue pull request ${this.number} - done`, GitHubRepository.ID);
			const temp = parseMergeQueueEntry(data?.enqueuePullRequest.mergeQueueEntry) ?? undefined;
			return temp;
		} catch (e) {
			Logger.error(`Enqueuing pull request failed: ${e}`, GitHubRepository.ID);
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
				// No event for setting the file viewed state here.
				// Instead, wait until all the changes have been made and set the context at the end.
				this.setFileViewedState(n.path, n.viewerViewedState, false);
			});

			hasNextPage = data.repository.pullRequest.files.pageInfo.hasNextPage;
			after = data.repository.pullRequest.files.pageInfo.endCursor;
		} while (hasNextPage);

		if (changed.length) {
			this._onDidChangeFileViewedState.fire({ changed });
		}
	}

	private markFilesInProgressRefCount: Map<string, number> = new Map();
	private updateMarkFilesInProgressRefCount(filePathOrSubpaths: string[], direction: 'increment' | 'decrement'): string[] {
		const completed: string[] = [];
		for (const f of filePathOrSubpaths) {
			let count = this.markFilesInProgressRefCount.get(f) || 0;
			if (direction === 'increment') {
				count++;
			} else {
				count--;
			}
			if (count === 0) {
				this.markFilesInProgressRefCount.delete(f);
				completed.push(f);
			} else {
				this.markFilesInProgressRefCount.set(f, count);
			}
		}
		return completed;
	}

	async markFiles(filePathOrSubpaths: string[], event: boolean, state: 'viewed' | 'unviewed'): Promise<void> {
		const allFilenames = filePathOrSubpaths
			.map((f) =>
				isDescendant(this.githubRepository.rootUri.path, f, '/')
					? f.substring(this.githubRepository.rootUri.path.length + 1)
					: f
			);

		this.updateMarkFilesInProgressRefCount(allFilenames, 'increment');

		const { mutate } = await this.githubRepository.ensure();
		const pullRequestId = this.graphNodeId;

		const mutationName = state === 'viewed'
			? 'markFileAsViewed'
			: 'unmarkFileAsViewed';

		// We only ever send 100 mutations at once. Any more than this and
		// we risk a timeout from GitHub.
		for (let i = 0; i < allFilenames.length; i += BATCH_SIZE) {
			const batch = allFilenames.slice(i, i + BATCH_SIZE);
			// See below for an example of what a mutation produced by this
			// will look like
			const mutation = gql`mutation Batch${mutationName}{
				${batch.map((filename, i) =>
				`alias${i}: ${mutationName}(
						input: {path: "${filename}", pullRequestId: "${pullRequestId}"}
					) { clientMutationId }
					`
			)}
			}`;
			await mutate<void>({ mutation });
		}

		// mutation BatchUnmarkFileAsViewedInline {
		// 	alias0: unmarkFileAsViewed(
		// 	  input: { path: "some_folder/subfolder/A.txt", pullRequestId: "PR_someid" }
		// 	) {
		// 	  clientMutationId
		// 	}
		// 	alias1: unmarkFileAsViewed(
		// 	  input: { path: "some_folder/subfolder/B.txt", pullRequestId: "PR_someid" }
		// 	) {
		// 	  clientMutationId
		// 	}
		// }

		// We keep a ref count of the files who's states are in the process of being modified so that we don't have UI flickering
		const completed = this.updateMarkFilesInProgressRefCount(allFilenames, 'decrement');
		completed.forEach(path => this.setFileViewedState(path, state === 'viewed' ? ViewedState.VIEWED : ViewedState.UNVIEWED, event));
	}

	async unmarkAllFilesAsViewed(): Promise<void> {
		return this.markFiles(Array.from(this.fileChanges.keys()), true, 'unviewed');
	}

	private setFileViewedState(fileSubpath: string, viewedState: ViewedState, event: boolean) {
		const uri = vscode.Uri.joinPath(this.githubRepository.rootUri, fileSubpath);
		const filePath = (this.githubRepository.rootUri.scheme === Schemes.VscodeVfs) ? uri.path : uri.fsPath;
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
			this._onDidChangeFileViewedState.fire({ changed: [{ fileName: fileSubpath, viewed: viewedState }] });
		}
	}

	public getViewedFileStates() {
		return {
			viewed: this._viewedFiles,
			unviewed: this._unviewedFiles
		};
	}
}
