/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TimelineEvent } from '../../src/common/timelineEvent';
import {
	GithubItemStateEnum,
	IAccount,
	ILabel,
	IMilestone,
	MergeMethod,
	MergeMethodsAvailability,
	PullRequestChecks,
	PullRequestMergeability,
	ReviewState,
} from '../../src/github/interface';
import { vscode } from './message';

export enum ReviewType {
	Comment = 'comment',
	Approve = 'approve',
	RequestChanges = 'requestChanges',
}

export interface PullRequest {
	number: number;
	title: string;
	titleHTML: string;
	url: string;
	createdAt: string;
	body: string;
	bodyHTML?: string;
	author: IAccount;
	state: GithubItemStateEnum;
	events: TimelineEvent[];
	isCurrentlyCheckedOut: boolean;
	isRemoteBaseDeleted?: boolean;
	base: string;
	isRemoteHeadDeleted?: boolean;
	isLocalHeadDeleted?: boolean;
	head: string;
	labels: ILabel[];
	assignees: IAccount[];
	commitsCount: number;
	milestone: IMilestone;
	repositoryDefaultBranch: string;
	/**
	 * User can edit PR title and description (author or user with push access)
	 */
	canEdit: boolean;
	/**
	 * Users with push access to repo have rights to merge/close PRs,
	 * edit title/description, assign reviewers/labels etc.
	 */
	hasWritePermission: boolean;
	pendingCommentText?: string;
	pendingCommentDrafts?: { [key: string]: string };
	pendingReviewType?: ReviewType;
	status: PullRequestChecks;
	mergeable: PullRequestMergeability;
	defaultMergeMethod: MergeMethod;
	mergeMethodsAvailability: MergeMethodsAvailability;
	autoMerge?: boolean;
	allowAutoMerge: boolean;
	autoMergeMethod?: MergeMethod;
	reviewers: ReviewState[];
	isDraft?: boolean;
	isIssue: boolean;
	isAuthor?: boolean;
	continueOnGitHub: boolean;
	currentUserReviewState: string;
	isDarkTheme: boolean;
}

export function getState(): PullRequest {
	return vscode.getState();
}

export function setState(pullRequest: PullRequest): void {
	const oldPullRequest = getState();

	if (oldPullRequest && oldPullRequest.number && oldPullRequest.number === pullRequest.number) {
		pullRequest.pendingCommentText = oldPullRequest.pendingCommentText;
	}

	if (pullRequest) {
		vscode.setState(pullRequest);
	}
}

export function updateState(data: Partial<PullRequest>): void {
	const pullRequest = vscode.getState();
	vscode.setState(Object.assign(pullRequest, data));
}
