/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DiffSide, IComment, IReviewThread, ViewedState } from '../common/comment';
import { GitChangeType } from '../common/file';
import { TimelineEvent } from '../common/timelineEvent';
import { IAccount, IIssueEditData, ILabel, IRawFileChange, ITeam, MergeMethod, PullRequest, PullRequestChecks, PullRequestMergeability, ReviewEventEnum, ReviewState } from '../github/interface';

export interface ProviderCapabilities {
	readonly attachments: boolean;
	readonly projects: boolean;
	readonly milestones: boolean;
	readonly assignees: boolean;
	readonly mergeQueue: boolean;
	readonly stacks: boolean;
	readonly autoMerge: boolean;
}

export type ProviderSection<T> = { state: 'loaded'; value: T } | { state: 'error'; message: string };

export interface ProviderRepositoryInfo {
	id: string;
	projectId: string;
	name: string;
	url: string;
	defaultBranch?: string;
	/** The repository this one was forked from, within the same organization or collection. */
	parent?: { project: string; name: string; url: string };
}

export interface ProviderListOptions {
	status?: 'open' | 'closed' | 'merged' | 'all';
	creatorId?: string;
	reviewerId?: string;
	sourceBranch?: string;
	targetBranch?: string;
	cursor?: number;
}

export interface ProviderPage<T> {
	items: T[];
	nextCursor?: number;
}

export const PROVIDER_PAGE_SIZE = 30;

/** Raised when an original GitHub-backed route has no Azure DevOps equivalent. */
export class ProviderUnsupportedError extends Error {
	constructor(feature: string) {
		super(`${feature} is not supported for Azure DevOps repositories.`);
		this.name = 'ProviderUnsupportedError';
	}
}

export interface ProviderRevision {
	iteration: number;
	source: string;
	target: string;
	mergeBase: string;
}

export interface ProviderFileChange {
	path: string;
	previousPath?: string;
	type: GitChangeType;
	trackingId: number;
	/** Source blob ID, absent for deletions. */
	objectId?: string;
}

export interface ProviderCommit {
	sha: string;
	message: string;
	authorName?: string;
	authorEmail?: string;
	authorDate?: string;
}

export interface ProviderDiscussions {
	threads: IReviewThread[];
	events: TimelineEvent[];
}

export interface ProviderSnapshot {
	pullRequest: PullRequest;
	currentUser: IAccount;
	reviewers: ReviewState[];
	discussions: ProviderSection<ProviderDiscussions>;
	labels: ProviderSection<ILabel[]>;
	checks: ProviderSection<PullRequestChecks>;
	commits: ProviderSection<ProviderCommit[]>;
}

export interface ProviderCommentLocation {
	path: string;
	startLine?: number;
	endLine?: number;
	side: DiffSide;
}

/** A new inline thread location, or an existing thread to reply to. */
export type ProviderDraftTarget = { location: ProviderCommentLocation; threadId?: undefined } | { threadId: string; location?: undefined };

export interface ProviderCommentReference {
	threadId: string;
	commentId: string;
}

/** Operations at the repository boundary, expressed using the application's existing models. */
export interface PullRequestProvider {
	readonly id: string;
	readonly capabilities: ProviderCapabilities;
	repository(): Promise<ProviderRepositoryInfo>;
	/** Whether the signed-in identity can contribute to pull requests in this repository. */
	canContribute(): Promise<boolean>;
	reviewerCandidates(): Promise<{ users: IAccount[]; teams: ITeam[] }>;
	compareBranches(base: string, head: string): Promise<{ aheadCount: number; behindCount: number }>;
	currentUser(): Promise<IAccount>;
	list(options?: ProviderListOptions): Promise<ProviderPage<PullRequest>>;
	load(number: number): Promise<ProviderSnapshot>;
	discussions(number: number): Promise<ProviderDiscussions>;
	checks(number: number): Promise<PullRequestChecks>;
	labels(number: number): Promise<ILabel[]>;
	/** Labels already used on recent pull requests; Azure DevOps has no repository label catalogue. */
	labelCandidates(): Promise<ILabel[]>;
	commits(number: number): Promise<ProviderCommit[]>;
	commitChanges(sha: string): Promise<Omit<ProviderFileChange, 'trackingId'>[]>;
	/** Changed files with locally computed hunks between the merge base and source revisions. */
	rawChanges(number: number, revision: ProviderRevision): Promise<IRawFileChange[]>;
	revision(number: number): Promise<ProviderRevision>;
	changes(number: number, revision: ProviderRevision): Promise<ProviderFileChange[]>;
	file(path: string, commit: string): Promise<string>;
	branches(): Promise<string[]>;
	pullRequestTemplates(): Promise<string[]>;
	viewedFiles(number: number): Promise<Record<string, ViewedState>>;
	setViewed(number: number, paths: string[], viewed: boolean): Promise<void>;
	deleteBranch(branch: string, expectedCommit: string): Promise<void>;
	create(title: string, body: string, source: string, target: string, draft: boolean): Promise<PullRequest>;
	edit(number: number, update: IIssueEditData): Promise<PullRequest>;
	setDraft(number: number, draft: boolean): Promise<PullRequest>;
	close(number: number): Promise<PullRequest>;
	reopen(number: number): Promise<PullRequest>;
	merge(number: number, method: MergeMethod, expectedHead: string, deleteSourceBranch: boolean, mergeCommitMessage?: string): Promise<PullRequest>;
	mergeability(number: number): Promise<PullRequestMergeability>;
	setAutoMerge(number: number, method: MergeMethod | undefined, expectedHead: string, deleteSourceBranch: boolean): Promise<PullRequest>;
	setReviewers(number: number, reviewers: (IAccount | ITeam)[]): Promise<void>;
	/** Adds reviewers without touching existing reviewers or their votes. */
	addReviewers(number: number, reviewers: (IAccount | ITeam)[]): Promise<void>;
	removeReviewers(number: number, reviewers: (IAccount | ITeam)[]): Promise<void>;
	setLabels(number: number, labels: string[]): Promise<void>;
	retarget(number: number, branch: string): Promise<PullRequest>;
	addComment(number: number, body: string, threadId?: string): Promise<IComment>;
	editComment(number: number, reference: ProviderCommentReference, body: string): Promise<IComment>;
	deleteComment(number: number, reference: ProviderCommentReference): Promise<void>;
	resolveThread(number: number, threadId: string, resolved: boolean): Promise<void>;
	createThread(number: number, content: string, location: ProviderCommentLocation): Promise<IReviewThread>;
	pendingReview(number: number): Promise<{ commit: string } | undefined>;
	startReview(number: number, commit: string): Promise<void>;
	addDraft(number: number, content: string, target: ProviderDraftTarget): Promise<IComment>;
	editDraft(number: number, id: number, content: string): Promise<IComment>;
	deleteDraft(number: number, id: number): Promise<void>;
	discardReview(number: number): Promise<IComment[]>;
	submitReview(number: number, event: ReviewEventEnum, body: string, expectedHead: string): Promise<void>;
}
