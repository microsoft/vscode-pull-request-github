/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Comment } from './comment';
import { IAccount } from '../github/interface';

export enum EventType {
	Committed,
	Mentioned,
	Subscribed,
	Commented,
	Reviewed,
	Labeled,
	Milestoned,
	Assigned,
	Merged,
	Other
}

export interface Committer {
	date: string;
	name: string;
	email: string;
}

export interface CommentEvent {
	htmlUrl: string;
	body: string;
	bodyHTML?: string;
	user: IAccount;
	event: EventType;
	canEdit?: boolean;
	canDelete?: boolean;
	id: number;
	createdAt: string;
}

export interface ReviewEvent {
	event: EventType;
	comments: Comment[];
	submittedAt: string;
	body: string;
	bodyHTML?: string;
	htmlUrl: string;
	user: IAccount;
	authorAssociation: string;
	state: 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING' | 'REQUESTED';
	id: number;
}

export interface CommitEvent {
	author: IAccount;
	event: EventType;
	sha: string;
	url: string;
	htmlUrl: string;
	message: string;
	bodyHTML?: string;
}

export interface MergedEvent {
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
	event: EventType;
	user: IAccount;
	actor: IAccount;
}

export type TimelineEvent = CommitEvent | ReviewEvent | CommentEvent | MergedEvent | AssignEvent;

export function isReviewEvent(event: TimelineEvent): event is ReviewEvent {
	return event.event === EventType.Reviewed;
}

export function isCommitEvent(event: TimelineEvent): event is CommitEvent {
	return event.event === EventType.Committed;
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