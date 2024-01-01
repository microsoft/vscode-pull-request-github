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
	graphNodeId: string;
	htmlUrl: string;
	body: string;
	bodyHTML?: string;
	user: IAccount;
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
	state: 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING' | 'REQUESTED';
}

export interface CommitEvent {
	id: string;
	author: IAccount;
	event: EventType.Committed;
	sha: string;
	htmlUrl: string;
	message: string;
	bodyHTML?: string;
	authoredDate: Date;
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
	user: IAccount;
	actor: IActor;
}

export interface HeadRefDeleteEvent {
	id: string;
	event: EventType.HeadRefDeleted;
	actor: IActor;
	createdAt: string;
	headRef: string;
}

export type TimelineEvent = CommitEvent | ReviewEvent | CommentEvent | NewCommitsSinceReviewEvent | MergedEvent | AssignEvent | HeadRefDeleteEvent;
