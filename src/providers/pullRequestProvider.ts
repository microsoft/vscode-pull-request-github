/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IComment, IReviewThread } from '../common/comment';
import { GitChangeType } from '../common/file';
import { TimelineEvent } from '../common/timelineEvent';
import { IAccount, IIssueEditData, ILabel, MergeMethod, PullRequest, PullRequestChecks, PullRequestMergeability, ReviewEventEnum, ReviewState } from '../github/interface';

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
	commits: ProviderSection<{ sha: string; message: string }[]>;
}

export interface ProviderCommentReference {
	threadId: string;
	commentId: string;
}

/** Operations at the repository boundary, expressed using the application's existing models. */
export interface PullRequestProvider {
	readonly id: string;
	readonly capabilities: ProviderCapabilities;
	repository(): Promise<ProviderRepositoryInfo>;
	currentUser(): Promise<IAccount>;
	list(options?: ProviderListOptions): Promise<ProviderPage<PullRequest>>;
	load(number: number): Promise<ProviderSnapshot>;
	discussions(number: number): Promise<ProviderDiscussions>;
	checks(number: number): Promise<PullRequestChecks>;
	labels(number: number): Promise<ILabel[]>;
	commits(number: number): Promise<{ sha: string; message: string }[]>;
	revision(number: number): Promise<ProviderRevision>;
	changes(number: number, revision: ProviderRevision): Promise<ProviderFileChange[]>;
	file(path: string, commit: string): Promise<string>;
	branches(): Promise<string[]>;
	create(title: string, body: string, source: string, target: string, draft: boolean): Promise<PullRequest>;
	edit(number: number, update: IIssueEditData): Promise<PullRequest>;
	setDraft(number: number, draft: boolean): Promise<PullRequest>;
	close(number: number): Promise<PullRequest>;
	reopen(number: number): Promise<PullRequest>;
	merge(number: number, method: MergeMethod, expectedHead: string, deleteSourceBranch: boolean): Promise<PullRequest>;
	mergeability(number: number): Promise<PullRequestMergeability>;
	setAutoMerge(number: number, method: MergeMethod | undefined, expectedHead: string, deleteSourceBranch: boolean): Promise<PullRequest>;
	setReviewers(number: number, reviewers: IAccount[]): Promise<void>;
	setLabels(number: number, labels: string[]): Promise<void>;
	retarget(number: number, branch: string): Promise<PullRequest>;
	addComment(number: number, body: string, threadId?: string): Promise<IComment>;
	editComment(number: number, reference: ProviderCommentReference, body: string): Promise<IComment>;
	deleteComment(number: number, reference: ProviderCommentReference): Promise<void>;
	resolveThread(number: number, threadId: string, resolved: boolean): Promise<void>;
	submitReview(number: number, event: ReviewEventEnum, body: string, expectedHead: string): Promise<void>;
}
