/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TimelineEvent } from '../common/timelineEvent';
import {
	GithubItemStateEnum,
	IAccount,
	ILabel,
	IMilestone,
	IProjectItem,
	MergeMethod,
	MergeMethodsAvailability,
	MergeQueueState,
	PullRequestChecks,
	PullRequestMergeability,
	PullRequestReviewRequirement,
	ReviewState,
} from './interface';

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
	projectItems: IProjectItem[] | undefined;
	milestone: IMilestone | undefined;
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
	emailForCommit?: string;
	pendingCommentText?: string;
	pendingCommentDrafts?: { [key: string]: string };
	pendingReviewType?: ReviewType;
	status: PullRequestChecks | null;
	reviewRequirement: PullRequestReviewRequirement | null;
	canUpdateBranch: boolean;
	mergeable: PullRequestMergeability;
	defaultMergeMethod: MergeMethod;
	mergeMethodsAvailability: MergeMethodsAvailability;
	autoMerge?: boolean;
	allowAutoMerge: boolean;
	autoMergeMethod?: MergeMethod;
	mergeQueueMethod: MergeMethod | undefined;
	mergeQueueEntry?: {
		url: string;
		position: number;
		state: MergeQueueState;
	};
	mergeCommitMeta?: { title: string, description: string };
	squashCommitMeta?: { title: string, description: string };
	reviewers: ReviewState[];
	isDraft?: boolean;
	isIssue: boolean;
	isAuthor?: boolean;
	continueOnGitHub: boolean;
	currentUserReviewState: string;
	isDarkTheme: boolean;
	isEnterprise: boolean;
	hasReviewDraft: boolean;

	lastReviewType?: ReviewType;
	busy?: boolean;
}

export interface ProjectItemsReply {
	projectItems: IProjectItem[] | undefined;
}

export interface MergeArguments {
	title: string | undefined;
	description: string | undefined;
	method: MergeMethod;
	email?: string;
}