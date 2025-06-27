/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAccount, IActor } from '../github/interface';
import { IComment } from './comment';

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
	CopilotStarted,
	CopilotFinished,
	CopilotFinishedError,
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
	reviewThread?: ReviewResolveInfo
	event: EventType.Reviewed;
	comments: IComment[];
	submittedAt: string;
	body: string;
	bodyHTML?: string;
	htmlUrl: string;
	user: IAccount;
	authorAssociation: string;
	state?: ReviewStateValue;
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

export interface SessionPullInfo {
	host: string;
	owner: string;
	repo: string;
	pullId: number;
}

export interface SessionLinkInfo extends SessionPullInfo {
	sessionIndex: number;
}

export interface CopilotStartedEvent {
	id: string;
	event: EventType.CopilotStarted;
	createdAt: string;
	onBehalfOf: IAccount;
	sessionLink?: SessionLinkInfo;
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

export type TimelineEvent = CommitEvent | ReviewEvent | CommentEvent | NewCommitsSinceReviewEvent | MergedEvent | AssignEvent | UnassignEvent | HeadRefDeleteEvent | CrossReferencedEvent | ClosedEvent | ReopenedEvent | CopilotStartedEvent | CopilotFinishedEvent | CopilotFinishedErrorEvent;
