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
	event: string;
	comments: Comment[];
	submittedAt: string;
	body: string;
	htmlUrl: string;
	user: IAccount;
	authorAssociation: string;
	state: string;
	id: number;
}

export interface CommitEvent {
	author: IAccount;
	event: string;
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
	event: string;
	url: string;
}

export type TimelineEvent = CommitEvent | ReviewEvent | CommentEvent | MergedEvent;

export function isReviewEvent(event: TimelineEvent): event is ReviewEvent {
	return Number(event.event) === EventType.Reviewed;
}

export function isCommitEvent(event: TimelineEvent): event is CommitEvent {
	return Number(event.event) === EventType.Committed;
}

export function isCommentEvent(event: TimelineEvent): event is CommentEvent {
	return Number(event.event) === EventType.Commented;
}

export function isMergedEvent(event: TimelineEvent): event is MergedEvent {
	return Number(event.event) === EventType.Merged;
}