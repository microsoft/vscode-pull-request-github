/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IComment, IReviewThread } from '../common/comment';
import { TimelineEvent } from '../common/timelineEvent';
import { IAccount, IIssueEditData, MergeMethod, PullRequest, PullRequestChecks, PullRequestMergeability, ReviewEventEnum, ReviewState } from '../github/interface';

export interface ProviderCapabilities {
	readonly attachments: boolean;
	readonly projects: boolean;
	readonly milestones: boolean;
	readonly assignees: boolean;
	readonly mergeQueue: boolean;
	readonly stacks: boolean;
	readonly autoMerge: boolean;
}

export interface ProviderSnapshot {
	pullRequest: PullRequest;
	currentUser: IAccount;
	reviewers: ReviewState[];
	threads: IReviewThread[];
	events: TimelineEvent[];
	checks: PullRequestChecks;
}

export interface ProviderCommentReference {
	threadId: string;
	commentId: string;
}

/** Operations at the repository boundary, expressed using the application's existing models. */
export interface PullRequestProvider {
	readonly id: string;
	readonly capabilities: ProviderCapabilities;
	list(): Promise<PullRequest[]>;
	load(number: number): Promise<ProviderSnapshot>;
	create(title: string, body: string, source: string, target: string, draft: boolean): Promise<PullRequest>;
	edit(number: number, update: IIssueEditData): Promise<PullRequest>;
	setDraft(number: number, draft: boolean): Promise<PullRequest>;
	close(number: number): Promise<PullRequest>;
	reopen(number: number): Promise<PullRequest>;
	merge(number: number, method: MergeMethod, expectedHead: string, deleteSourceBranch: boolean): Promise<PullRequest>;
	mergeability(number: number): Promise<PullRequestMergeability>;
	addComment(number: number, body: string, threadId?: string): Promise<IComment>;
	editComment(number: number, reference: ProviderCommentReference, body: string): Promise<IComment>;
	deleteComment(number: number, reference: ProviderCommentReference): Promise<void>;
	resolveThread(number: number, threadId: string, resolved: boolean): Promise<void>;
	submitReview(number: number, event: ReviewEventEnum, body: string, expectedHead: string): Promise<void>;
}
