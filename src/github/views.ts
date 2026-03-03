/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
	StateReason,
} from './interface';
import { IComment } from '../common/comment';
import { CommentEvent, ReviewEvent, SessionLinkInfo, TimelineEvent } from '../common/timelineEvent';

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
	stateReason?: StateReason;
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
	canRequestCopilotReview: boolean;
	reactions: Reaction[];
	busy?: boolean;
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
	doneCheckoutBranch: string;
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
	loadingCommit?: string;
	generateDescriptionTitle?: string;
}

export interface ProjectItemsReply {
	projectItems: IProjectItem[] | undefined;
}

export interface ChangeAssigneesReply {
	assignees: IAccount[];
	events: TimelineEvent[];
}

export interface ChangeReviewersReply {
	reviewers: ReviewState[];
}

export interface SubmitReviewReply {
	events?: TimelineEvent[];
	reviewedEvent: ReviewEvent | CommentEvent;
	reviewers?: ReviewState[];
}

export interface ReadyForReviewReply {
	isDraft: boolean;
	reviewEvent?: ReviewEvent;
	reviewers?: ReviewState[];
	autoMerge?: boolean;
}

export interface ConvertToDraftReply {
	isDraft: boolean;
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

export interface DeleteReviewResult {
	deletedReviewId: number;
	deletedReviewComments: IComment[];
}

export enum PreReviewState {
	None = 0,
	Available,
	ReviewedWithComments,
	ReviewedWithoutComments
}

export interface ChangeTemplateReply {
	description: string;
}

export interface CancelCodingAgentReply {
	events: TimelineEvent[];
}

export interface BaseContext {
	'preventDefaultContextMenuItems': true;
	owner: string;
	repo: string;
	number: number;
	[key: string]: boolean | string | number;
}

export interface OverviewContext extends BaseContext {
	'github:checkoutMenu': true;
}

export interface ReadyForReviewContext extends BaseContext {
	'github:readyForReviewMenu': true;
}

export interface ReadyForReviewAndMergeContext extends ReadyForReviewContext {
	'github:readyForReviewMenuWithMerge': true;
	mergeMethod: MergeMethod;
}

export interface CodingAgentContext extends SessionLinkInfo {
	'preventDefaultContextMenuItems': true;
	'github:codingAgentMenu': true;
	[key: string]: boolean | string | number | undefined;
}

export interface ReviewCommentContext {
	'preventDefaultContextMenuItems': true;
	'github:reviewCommentMenu': true,
	owner: string;
	repo: string;
	number: number;
	body: string;
	'github:reviewCommentApprove'?: boolean;
	'github:reviewCommentApproveOnDotCom'?: boolean;
	'github:reviewCommentComment'?: boolean;
	'github:reviewCommentCommentEnabled'?: boolean;
	'github:reviewCommentRequestChanges'?: boolean;
	'github:reviewRequestChangesEnabled'?: boolean;
	'github:reviewCommentRequestChangesOnDotCom'?: boolean;
}

export interface ChangeBaseReply {
	base: string;
	events: TimelineEvent[];
}

/**
 * Represents an unresolved PR or issue identity - just enough info to show the overview
 * panel before the full model is loaded.
 */
export interface UnresolvedIdentity {
	owner: string;
	repo: string;
	number: number;
}