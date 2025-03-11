/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ReviewStateValue } from '../common/timelineEvent';

export enum PRType {
	Query,
	All,
	LocalPullRequest,
}

export enum ReviewEvent {
	Approve = 'APPROVE',
	RequestChanges = 'REQUEST_CHANGES',
	Comment = 'COMMENT',
}

export enum GithubItemStateEnum {
	Open,
	Merged,
	Closed,
}

export enum PullRequestMergeability {
	Mergeable,
	NotMergeable,
	Conflict,
	Unknown,
	Behind,
}

export enum MergeQueueState {
	AwaitingChecks,
	Locked,
	Mergeable,
	Queued,
	Unmergeable
}

export interface ReviewState {
	reviewer: IAccount | ITeam;
	state: ReviewStateValue;
}

export interface ReadyForReview {
	isDraft: boolean;
	mergeable: PullRequestMergeability;
	allowAutoMerge: boolean;
}

export interface IActor {
	login: string;
	avatarUrl?: string;
	url: string;
}

export enum AccountType {
	User = 'User',
	Organization = 'Organization',
	Mannequin = 'Mannequin',
	Bot = 'Bot'
}

export function toAccountType(type: string): AccountType {
	switch (type) {
		case 'Organization':
			return AccountType.Organization;
		case 'Mannequin':
			return AccountType.Mannequin;
		case 'Bot':
			return AccountType.Bot;
		default:
			return AccountType.User;
	}
}

export interface IAccount extends IActor {
	login: string;
	id: string;
	name?: string;
	avatarUrl?: string;
	url: string;
	email?: string;
	specialDisplayName?: string;
	accountType: AccountType;
}

export interface ITeam {
	name?: string;
	avatarUrl?: string;
	url: string;
	slug?: string;
	org: string;
	id: string;
}

export interface MergeQueueEntry {
	position: number;
	state: MergeQueueState;
	url: string;
}

export function reviewerId(reviewer: ITeam | IAccount): string {
	return isTeam(reviewer) ? reviewer.id : reviewer.login;
}

export function reviewerLabel(reviewer: ITeam | IAccount | IActor | any): string {
	return isTeam(reviewer) ? (reviewer.name ?? reviewer.slug ?? reviewer.id) : (reviewer.specialDisplayName ?? reviewer.login);
}

export function isTeam(reviewer: ITeam | IAccount | IActor | any): reviewer is ITeam {
	return 'org' in reviewer;
}

export interface ISuggestedReviewer extends IAccount {
	isAuthor: boolean;
	isCommenter: boolean;
}

export function isSuggestedReviewer(
	reviewer: IAccount | ISuggestedReviewer | ITeam
): reviewer is ISuggestedReviewer {
	return 'isAuthor' in reviewer && 'isCommenter' in reviewer;
}

export interface IProject {
	title: string;
	id: string;
}

export interface IProjectItem {
	id: string;
	project: IProject;
}

export interface IMilestone {
	title: string;
	dueOn?: string | null;
	createdAt: string;
	id: string;
	number: number;
}

export interface MergePullRequest {
	sha: string;
	merged: boolean;
	message: string;
	documentation_url: string;
}

export interface IRepository {
	cloneUrl: string;
	isInOrganization: boolean | string;
	owner: string;
	name: string;
}

export interface IGitHubRef {
	label: string;
	ref: string;
	sha: string;
	repo: IRepository;
}

export interface ILabel {
	name: string;
	color: string;
	description?: string;
}

export interface IIssueComment {
	author: IAccount;
	body: string;
	databaseId: number;
	reactionCount: number;
	createdAt: string;
}

export interface Issue {
	id: number;
	graphNodeId: string;
	url: string;
	number: number;
	state: string;
	body: string;
	bodyHTML?: string;
	title: string;
	titleHTML: string;
	assignees?: IAccount[];
	createdAt: string;
	updatedAt: string;
	user: IAccount;
	labels: ILabel[];
	projectItems?: IProjectItem[];
	milestone?: IMilestone;
	repositoryOwner?: string;
	repositoryName?: string;
	repositoryUrl?: string;
	comments?: IIssueComment[];
	commentCount: number;
	reactionCount: number;
}

export interface PullRequest extends Issue {
	isDraft?: boolean;
	isRemoteHeadDeleted?: boolean;
	head?: IGitHubRef;
	isRemoteBaseDeleted?: boolean;
	base?: IGitHubRef;
	commits: {
		message: string;
	}[];
	merged?: boolean;
	mergeable?: PullRequestMergeability;
	mergeQueueEntry?: MergeQueueEntry | null;
	viewerCanUpdate: boolean;
	autoMerge?: boolean;
	autoMergeMethod?: MergeMethod;
	allowAutoMerge?: boolean;
	mergeCommitMeta?: { title: string, description: string };
	squashCommitMeta?: { title: string, description: string };
	suggestedReviewers?: ISuggestedReviewer[];
	hasComments?: boolean;
}

export enum NotificationSubjectType {
	Issue = 'Issue',
	PullRequest = 'PullRequest'
}

export interface Notification {
	owner: string;
	name: string;
	key: string;
	id: string,
	itemID: string;
	subject: {
		title: string;
		type: NotificationSubjectType;
		url: string;
	};
	reason: string;
	unread: boolean;
	updatedAd: Date;
	lastReadAt: Date | undefined;
}

export interface IRawFileChange {
	sha: string;
	filename: string;
	previous_filename?: string | undefined;
	additions: number;
	deletions: number;
	changes: number;
	status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
	raw_url: string;
	blob_url: string;
	contents_url: string;
	patch?: string | undefined;
}

export interface IRawFileContent {
	type: string;
	size: number;
	name: string;
	path: string;
	content?: string | undefined;
	sha: string;
	url: string;
	git_url: string | null;
	html_url: string | null;
	download_url: string | null;
}

export interface IGitTreeItem {
	path: string;
	mode: '100644' | '100755' | '120000';
	// Must contain a content or a sha.
	content?: string;
	sha?: string | null;
}

export interface IPullRequestsPagingOptions {
	fetchNextPage: boolean;
	fetchOnePagePerRepo?: boolean;
}

export interface IPullRequestEditData {
	body?: string;
	title?: string;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export type MergeMethodsAvailability = {
	[method in MergeMethod]: boolean;
};

export type RepoAccessAndMergeMethods = {
	hasWritePermission: boolean;
	mergeMethodsAvailability: MergeMethodsAvailability;
	viewerCanAutoMerge: boolean;
};

export interface User extends IAccount {
	company?: string;
	location?: string;
	bio?: string;
	commitContributions: {
		createdAt: Date;
		repoNameWithOwner: string;
	}[];
}

export enum CheckState {
	Success = 'success',
	Failure = 'failure',
	Neutral = 'neutral',
	Pending = 'pending',
	Unknown = 'unknown'
}

export interface PullRequestCheckStatus {
	id: string;
	url: string | undefined;
	avatarUrl: string | undefined;
	state: CheckState;
	description: string | null;
	targetUrl: string | null;
	context: string; // Job name
	workflowName: string | undefined;
	event: string | undefined;
	isRequired: boolean;
}

export interface PullRequestChecks {
	state: CheckState;
	statuses: PullRequestCheckStatus[];
}

export interface PullRequestReviewRequirement {
	count: number;
	state: CheckState;
	approvals: string[];
	requestedChanges: string[];
}
