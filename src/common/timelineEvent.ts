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
	eventKind: 'comment';
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

export interface ReviewEvent {
	eventKind: 'review';
	id: number;
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
	eventKind: 'commit';
	id: string;
	author: IAccount;
	event: EventType;
	sha: string;
	htmlUrl: string;
	message: string;
	bodyHTML?: string;
	authoredDate: Date;
}

export interface MergedEvent {
	eventKind: 'merged';
	id: number;
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
	eventKind: 'assign';
	id: number;
	event: EventType;
	user: IAccount;
	actor: IAccount;
}

export interface HeadRefDeleteEvent {
	eventKind: 'head-ref-delete'
	id: string;
	event: EventType;
	actor: IAccount;
	createdAt: string;
	headRef: string;
}

export type TimelineEvent = CommitEvent | ReviewEvent | CommentEvent | MergedEvent | AssignEvent | HeadRefDeleteEvent;
