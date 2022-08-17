/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAccount } from '../github/interface';
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
	HeadRefDeleted,
	Merged,
	Other,
}

export interface Committer {
	date: string;
	name: string;
	email: string;
}

export interface CommentEvent {
	id: number;
	htmlUrl: string;
	body: string;
	bodyHTML?: string;
	user: IAccount;
	event: EventType;
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

export interface ReviewEvent {
	id: number;
	reviewThread?: ReviewResolveInfo
	event: EventType;
	comments: IComment[];
	submittedAt: string;
	body: string;
	bodyHTML?: string;
	htmlUrl: string;
	user: IAccount;
	authorAssociation: string;
	state: 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING' | 'REQUESTED';
}

export interface CommitEvent {
	id: string;
	author: IAccount;
	event: EventType;
	sha: string;
	htmlUrl: string;
	message: string;
	bodyHTML?: string;
	authoredDate: Date;
}

export interface NewCommitsSinceReviewEvent {
	id: string;
	event: EventType;
}

export interface MergedEvent {
	id: string;
	graphNodeId: string;
	user: IAccount;
	createdAt: string;
	mergeRef: string;
	sha: string;
	commitUrl: string;
	event: EventType;
	url: string;
}

export interface AssignEvent {
	id: number;
	event: EventType;
	user: IAccount;
	actor: IAccount;
}

export interface HeadRefDeleteEvent {
	id: string;
	event: EventType;
	actor: IAccount;
	createdAt: string;
	headRef: string;
}

export type TimelineEvent = CommitEvent | ReviewEvent | CommentEvent | NewCommitsSinceReviewEvent | MergedEvent | AssignEvent | HeadRefDeleteEvent;

export function isReviewEvent(event: TimelineEvent): event is ReviewEvent {
	return event.event === EventType.Reviewed;
}

export function isCommitEvent(event: TimelineEvent): event is CommitEvent {
	return event.event === EventType.Committed;
}

export function isNewCommitsSinceReviewEvent(event: TimelineEvent): event is NewCommitsSinceReviewEvent {
	return event.event === EventType.NewCommitsSinceReview;
}

export function isCommentEvent(event: TimelineEvent): event is CommentEvent {
	return event.event === EventType.Commented;
}

export function isMergedEvent(event: TimelineEvent): event is MergedEvent {
	return event.event === EventType.Merged;
}

export function isAssignEvent(event: TimelineEvent): event is AssignEvent {
	return event.event === EventType.Assigned;
}

export function isHeadDeleteEvent(event: TimelineEvent): event is HeadRefDeleteEvent {
	return event.event === EventType.HeadRefDeleted;
}
