/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IComment } from './comment';
import { IAccount, IActor, ITeam, MergeMethod, Reaction } from '../github/interface';
import type { DisplayLabel } from '../github/views';

export enum EventType {
	Committed,
	Mentioned,
	Subscribed,
	Commented,
	Reviewed,
	NewCommitsSinceReview,
	Labeled,
	Milestoned,
	Assigned,
	Unassigned,
	HeadRefDeleted,
	Merged,
	CrossReferenced,
	Closed,
	Reopened,
	BaseRefChanged,
	CopilotStarted,
	CopilotFinished,
	CopilotFinishedError,
	CopilotReviewStarted,
	Unlabeled,
	Demilestoned,
	RenamedTitle,
	ReviewRequested,
	ReviewRequestRemoved,
	ReadyForReview,
	ConvertToDraft,
	HeadRefForcePushed,
	HeadRefRestored,
	ReviewDismissed,
	AutoMergeEnabled,
	AutoMergeDisabled,
	AddedToMergeQueue,
	RemovedFromMergeQueue,
	Other,
}

export interface Committer {
	date: string;
	name: string;
	email: string;
}

export interface CommentEvent {
	id: number;
	graphNodeId: string;
	htmlUrl: string;
	body: string;
	bodyHTML?: string;
	user?: IAccount;
	event: EventType.Commented;
	canEdit?: boolean;
	canDelete?: boolean;
	createdAt: string;
	reactions?: Reaction[];
}

export interface ReviewResolveInfo {
	threadId: string;
	canResolve: boolean;
	canUnresolve: boolean;
	isResolved: boolean;
}

export type ReviewStateValue = 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING' | 'REQUESTED';

export interface ReviewEvent {
	id: number;
	/**
	 * Map of review thread GraphQL node id to its resolve info, for all
	 * review threads belonging to this review. A single review can have
	 * comments on multiple threads, so resolve actions must look up the
	 * thread by the comment's `threadId`.
	 */
	reviewThreads?: { [threadId: string]: ReviewResolveInfo };
	event: EventType.Reviewed;
	comments: IComment[];
	submittedAt: string;
	body: string;
	bodyHTML?: string;
	htmlUrl: string;
	user: IAccount;
	authorAssociation: string;
	state?: ReviewStateValue;
	reactions?: Reaction[];
}

export interface CommitEvent {
	id: string;
	author: IAccount;
	event: EventType.Committed;
	sha: string;
	htmlUrl: string;
	message: string;
	bodyHTML?: string;
	committedDate: Date;
	verification?: CommitVerification;
	status?: 'EXPECTED' | 'ERROR' | 'FAILURE' | 'PENDING' | 'SUCCESS';
}

export interface CommitVerification {
	verified: boolean;
	state: string;
	wasSignedByGitHub?: boolean;
	signer?: {
		login: string;
		name?: string;
		avatarUrl?: string;
	};
	keyId?: string;
	keyFingerprint?: string;
	email?: string;
}

export interface NewCommitsSinceReviewEvent {
	id: string;
	event: EventType.NewCommitsSinceReview;
}

export interface MergedEvent {
	id: string;
	graphNodeId: string;
	user: IActor;
	createdAt: string;
	mergeRef: string;
	sha: string;
	commitUrl: string;
	event: EventType.Merged;
	url: string;
}

export interface AssignEvent {
	id: number;
	event: EventType.Assigned;
	assignees: IAccount[];
	actor: IActor;
	createdAt: string;
}

export interface UnassignEvent {
	id: number;
	event: EventType.Unassigned;
	unassignees: IAccount[];
	actor: IActor;
	createdAt: string;
}

export interface HeadRefDeleteEvent {
	id: string;
	event: EventType.HeadRefDeleted;
	actor: IActor;
	createdAt: string;
	headRef: string;
}

export interface CrossReferencedEvent {
	id: string;
	event: EventType.CrossReferenced
	actor: IActor;
	createdAt: string;
	source: {
		number: number;
		url: string;
		extensionUrl: string;
		title: string;
		isIssue: boolean;
		owner: string;
		repo: string;
	};
	willCloseTarget: boolean;
}

export interface ClosedEvent {
	id: string
	event: EventType.Closed;
	actor: IActor;
	createdAt: string;
}

export interface ReopenedEvent {
	id: string;
	event: EventType.Reopened;
	actor: IActor;
	createdAt: string;
}

export interface BaseRefChangedEvent {
	id: string;
	event: EventType.BaseRefChanged;
	actor: IActor;
	createdAt: string;
	currentRefName: string;
	previousRefName: string;
}

export interface LabeledEvent {
	id: string;
	event: EventType.Labeled;
	actor: IActor;
	createdAt: string;
	label: DisplayLabel;
}

export interface UnlabeledEvent {
	id: string;
	event: EventType.Unlabeled;
	actor: IActor;
	createdAt: string;
	label: DisplayLabel;
}

export interface MilestonedEvent {
	id: string;
	event: EventType.Milestoned;
	actor: IActor;
	createdAt: string;
	milestoneTitle: string;
}

export interface DemilestonedEvent {
	id: string;
	event: EventType.Demilestoned;
	actor: IActor;
	createdAt: string;
	milestoneTitle: string;
}

export interface RenamedTitleEvent {
	id: string;
	event: EventType.RenamedTitle;
	actor: IActor;
	createdAt: string;
	previousTitle: string;
	currentTitle: string;
}

export interface ReviewRequestedEvent {
	id: string;
	event: EventType.ReviewRequested;
	actor: IActor;
	createdAt: string;
	reviewer: IAccount | ITeam;
}

export interface ReviewRequestRemovedEvent {
	id: string;
	event: EventType.ReviewRequestRemoved;
	actor: IActor;
	createdAt: string;
	reviewer: IAccount | ITeam;
}

export interface ReadyForReviewEvent {
	id: string;
	event: EventType.ReadyForReview;
	actor: IActor;
	createdAt: string;
}

export interface ConvertToDraftEvent {
	id: string;
	event: EventType.ConvertToDraft;
	actor: IActor;
	createdAt: string;
}

export interface ForcePushedCommit {
	sha: string;
	url: string;
}

export interface HeadRefForcePushedEvent {
	id: string;
	event: EventType.HeadRefForcePushed;
	actor: IActor;
	createdAt: string;
	headRef: string;
	/** Can be undefined when the commit is no longer available (e.g. it was garbage collected). */
	beforeCommit?: ForcePushedCommit;
	afterCommit?: ForcePushedCommit;
}

export interface HeadRefRestoredEvent {
	id: string;
	event: EventType.HeadRefRestored;
	actor: IActor;
	createdAt: string;
	headRef: string;
}

export interface ReviewDismissedEvent {
	id: string;
	event: EventType.ReviewDismissed;
	actor: IActor;
	createdAt: string;
	reviewAuthor?: IAccount;
	dismissalMessage?: string;
}

export interface AutoMergeEnabledEvent {
	id: string;
	event: EventType.AutoMergeEnabled;
	actor: IActor;
	createdAt: string;
	/** Only known when auto-merge was enabled with the squash or rebase method. */
	mergeMethod?: MergeMethod;
}

export interface AutoMergeDisabledEvent {
	id: string;
	event: EventType.AutoMergeDisabled;
	actor: IActor;
	createdAt: string;
	reason?: string;
}

export interface AddedToMergeQueueEvent {
	id: string;
	event: EventType.AddedToMergeQueue;
	actor: IActor;
	createdAt: string;
}

export interface RemovedFromMergeQueueEvent {
	id: string;
	event: EventType.RemovedFromMergeQueue;
	actor: IActor;
	createdAt: string;
	reason?: string;
}

export interface SessionPullInfo {
	id: number;
	host: string;
	owner: string;
	repo: string;
	pullNumber: number;
}

export interface SessionLinkInfo extends SessionPullInfo {
	sessionIndex: number;
	openToTheSide?: boolean;
}

export interface CopilotStartedEvent {
	id: string;
	event: EventType.CopilotStarted;
	createdAt: string;
	onBehalfOf: IAccount;
	sessionLink: SessionLinkInfo;
}

export interface CopilotFinishedEvent {
	id: string;
	event: EventType.CopilotFinished;
	createdAt: string;
	onBehalfOf: IAccount;
}

export interface CopilotFinishedErrorEvent {
	id: string;
	event: EventType.CopilotFinishedError;
	createdAt: string;
	onBehalfOf: IAccount;
	sessionLink: SessionLinkInfo;
}

export interface CopilotReviewStartedEvent {
	id: string;
	event: EventType.CopilotReviewStarted;
	createdAt: string;
}

export type TimelineEvent = CommitEvent | ReviewEvent | CommentEvent | NewCommitsSinceReviewEvent | MergedEvent | AssignEvent | UnassignEvent | HeadRefDeleteEvent | CrossReferencedEvent | ClosedEvent | ReopenedEvent | BaseRefChangedEvent | CopilotStartedEvent | CopilotFinishedEvent | CopilotFinishedErrorEvent | CopilotReviewStartedEvent
	| LabeledEvent | UnlabeledEvent | MilestonedEvent | DemilestonedEvent | RenamedTitleEvent | ReviewRequestedEvent | ReviewRequestRemovedEvent
	| ReadyForReviewEvent | ConvertToDraftEvent | HeadRefForcePushedEvent | HeadRefRestoredEvent | ReviewDismissedEvent
	| AutoMergeEnabledEvent | AutoMergeDisabledEvent | AddedToMergeQueueEvent | RemovedFromMergeQueueEvent;
