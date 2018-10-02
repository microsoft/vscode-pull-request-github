/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Github from '@octokit/rest';
import { Comment } from './comment';

type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

export enum EventType {
	Committed,
	Mentioned,
	Subscribed,
	Commented,
	Reviewed,
	Other
}

export interface MentionEvent extends Github.IssuesGetEventsTimelineResponseItem {
	eventType: EventType;
}

export interface SubscribeEvent extends Github.IssuesGetEventsTimelineResponseItem {
	eventType: EventType;
}

export interface CommentEvent extends Omit<Github.IssuesGetEventsTimelineResponseItem, 'commit_id' | 'commit_url'> {
	html_url: string;
	issue_url: string;
	body: string;
	author_association: string;
	updated_at: string;
	user: Github.IssuesGetEventsTimelineResponseItem['actor'];
	canEdit?: boolean;
	canDelete?: boolean;
	eventType: EventType;
}

export interface ReviewEvent extends Github.PullRequestsCreateReviewResponse {
	author_association: string;
	event: string;
	eventType: EventType;
	comments: Comment[];
	submitted_at: string;
}

export interface CommitEvent extends Github.ReposCreateFileResponseCommit {
	author: Github.ReposCreateFileResponseCommit['author'] & {
		login: string;
		avatar_url: string;
		html_url: string;
	};
	event: string;
	eventType: EventType;
}

export type TimelineEvent = CommitEvent | ReviewEvent | SubscribeEvent | CommentEvent | MentionEvent;
