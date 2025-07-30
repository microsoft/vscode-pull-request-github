/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CommentEvent, ReviewEvent, SessionLinkInfo, TimelineEvent } from '../common/timelineEvent';
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
	Reaction,
	ReviewState,
} from './interface';

export enum ReviewType {
	Comment = 'comment',
	Approve = 'approve',
	RequestChanges = 'requestChanges',
}

export interface DisplayLabel extends ILabel {
	displayName: string;
}

export interface Issue {
	owner: string;
	repo: string;
	number: number;
	title: string;
	titleHTML: string;
	url: string;
	createdAt: string;
	body: string;
	bodyHTML?: string;
	author: IAccount;
	state: GithubItemStateEnum; // TODO: don't allow merged
	events: TimelineEvent[];
	labels: DisplayLabel[];
	assignees: IAccount[];
	projectItems: IProjectItem[] | undefined;
	milestone: IMilestone | undefined;
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
	isIssue: boolean;
	isAuthor: boolean;
	continueOnGitHub: boolean;
	isDarkTheme: boolean;
	isEnterprise: boolean;
	canAssignCopilot: boolean;
	reactions: Reaction[];
	busy?: boolean;
	loadingCommit?: string;
}

export interface PullRequest extends Issue {
	isCopilotOnMyBehalf: boolean;
	isCurrentlyCheckedOut: boolean;
	isRemoteBaseDeleted?: boolean;
	base: string;
	isRemoteHeadDeleted?: boolean;
	isLocalHeadDeleted?: boolean;
	head: string;
	commitsCount: number;
	projectItems: IProjectItem[] | undefined;
	repositoryDefaultBranch: string;
	emailForCommit?: string;
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
	currentUserReviewState?: string;
	hasReviewDraft: boolean;
	lastReviewType?: ReviewType;
	revertable?: boolean;
	busy?: boolean;
}

export interface ProjectItemsReply {
	projectItems: IProjectItem[] | undefined;
}

export interface ChangeAssigneesReply {
	assignees: IAccount[];
	events: TimelineEvent[];
}

export interface SubmitReviewReply {
	events?: TimelineEvent[];
	reviewedEvent: ReviewEvent | CommentEvent;
	reviewers?: ReviewState[];
}

export interface MergeArguments {
	title: string | undefined;
	description: string | undefined;
	method: MergeMethod;
	email?: string;
}

export interface MergeResult {
	state: GithubItemStateEnum;
	revertable: boolean;
	events?: TimelineEvent[];
}

export enum PreReviewState {
	None = 0,
	Available,
	ReviewedWithComments,
	ReviewedWithoutComments
}

export interface CancelCodingAgentReply {
	events: TimelineEvent[];
}

export interface OverviewContext {
	'preventDefaultContextMenuItems': true;
	owner: string;
	repo: string;
	number: number;
}

export interface CodingAgentContext extends SessionLinkInfo {
	'preventDefaultContextMenuItems': true;
}