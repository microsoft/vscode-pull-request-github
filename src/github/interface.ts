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

export enum ReviewEventEnum {
	Approve = 'APPROVE',
	RequestChanges = 'REQUEST_CHANGES',
	Comment = 'COMMENT',
}

export enum GithubItemStateEnum {
	Open = 'OPEN',
	Merged = 'MERGED',
	Closed = 'CLOSED',
}

export interface PullRequestStack {
	position: number;
	size: number;
	base: string;
	needsUpdate?: boolean;
	pullRequests: {
		position: number;
		number: number;
		title: string;
		url: string;
		head: string;
		state: GithubItemStateEnum;
		isDraft: boolean;
		isQueued?: boolean;
		mergeable: PullRequestMergeability;
	}[];
}

/** Open pull requests that could form a stack with a pull request that is not in one yet. */
export interface PullRequestStackRecommendation {
	/** The stack the pull requests would form, in the same shape as an existing stack. */
	stack: PullRequestStack;
	/** The size of the existing stack that the pull requests would be added to, if they extend one. */
	existingStackSize?: number;
}

/** An open pull request whose branches line up with another pull request, so they could be stacked. */
export interface StackablePullRequest {
	number: number;
	title: string;
	url: string;
	base: string;
	head: string;
	isDraft: boolean;
	isQueued: boolean;
	mergeable: PullRequestMergeability;
	/** Where the pull request is in its stack, if it is already in one. */
	stackEntry?: { position: number; size: number };
}

export enum PullRequestMergeability {
	Mergeable,
	NotMergeable,
	Conflict,
	Unknown,
	Behind,
}

export interface PullRequestMergeabilityResult {
	mergeability: PullRequestMergeability;
	conflicts?: string[];
}

export function getUpdatableStackEntries(stack: PullRequestStack): PullRequestStack['pullRequests'] | undefined {
	if (stack.pullRequests.length !== stack.size) {
		return;
	}
	const firstClosed = stack.pullRequests.findIndex(entry => entry.state === GithubItemStateEnum.Closed);
	const entries = firstClosed < 0 ? stack.pullRequests : stack.pullRequests.slice(0, firstClosed);
	if (!entries.length || entries.some(entry => entry.state !== GithubItemStateEnum.Open || entry.isQueued)
		|| stack.pullRequests.slice(entries.length).some(entry => entry.state !== GithubItemStateEnum.Closed)) {
		return;
	}
	return entries;
}

export function isStackUpdatable(stack: PullRequestStack): boolean {
	return !!stack.needsUpdate && !!getUpdatableStackEntries(stack);
}

/**
 * Whether an open pull request in the stack has conflicts. Updating such a stack needs a local rebase, where the user
 * can resolve them; GitHub can rebase other stacks itself. Closed pull requests are skipped when updating a stack.
 */
export function hasConflictingStackEntry(stack: PullRequestStack | null | undefined): boolean {
	return !!stack?.pullRequests.some(entry =>
		entry.state === GithubItemStateEnum.Open && entry.mergeable === PullRequestMergeability.Conflict);
}

/** Whether a pull request and the open pull requests below it in its stack are all ready to be merged together. */
export function isStackMergeable(stack: PullRequestStack, number: number): boolean {
	const target = stack.pullRequests.find(entry => entry.number === number);
	return target?.state === GithubItemStateEnum.Open && stack.pullRequests.every(entry =>
		entry.position > target.position ||
		entry.state === GithubItemStateEnum.Merged ||
		(entry.state === GithubItemStateEnum.Open && !entry.isDraft && entry.mergeable === PullRequestMergeability.Mergeable)
	);
}

/**
 * Gets the open pull request at the top of the stack if it is above the given pull request and every open pull request
 * in the stack is ready to be merged. Merging the top pull request merges all of them.
 */
export function getStackMergeAllTarget(stack: PullRequestStack, number: number): PullRequestStack['pullRequests'][number] | undefined {
	const current = stack.pullRequests.find(entry => entry.number === number);
	const top = stack.pullRequests.reduce<PullRequestStack['pullRequests'][number] | undefined>((highest, entry) =>
		entry.state === GithubItemStateEnum.Open && (!highest || entry.position > highest.position) ? entry : highest, undefined);
	return current && top && top.position > current.position && isStackMergeable(stack, top.number) ? top : undefined;
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

export interface ConvertToDraft {
	isDraft: boolean;
	mergeable: PullRequestMergeability;
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
	// We can literally get different login values for copilot depending on where it's coming from (already assignee vs suggested assingee)
	return isITeam(reviewer) ? reviewer.id : (reviewer.specialDisplayName ?? reviewer.login);
}

export function reviewerLabel(reviewer: ITeam | IAccount | IActor | any): string {
	return isITeam(reviewer) ? (reviewer.name ?? reviewer.slug ?? reviewer.id) : (reviewer.specialDisplayName ?? reviewer.login);
}

export function isITeam(reviewer: ITeam | IAccount | IActor | any): reviewer is ITeam {
	const asITeam = reviewer as Partial<ITeam>;
	return !!asITeam.org;
}

export interface ISuggestedReviewer extends IAccount {
	isAuthor: boolean;
	isCommenter: boolean;
}

export function isISuggestedReviewer(
	reviewer: IAccount | ISuggestedReviewer | ITeam
): reviewer is ISuggestedReviewer {
	const asISuggestedReviewer = reviewer as Partial<ISuggestedReviewer>;
	return !!asISuggestedReviewer.isAuthor && !!asISuggestedReviewer.isCommenter;
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
	isInOrganization: boolean;
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

export interface Reaction {
	label: string;
	count: number;
	icon?: string;
	viewerHasReacted: boolean;
	reactors: readonly string[];
}

export type StateReason = 'REOPENED' | 'NOT_PLANNED' | 'COMPLETED' | 'DUPLICATE';

export interface Issue {
	id: number;
	graphNodeId: string;
	url: string;
	number: number;
	state: string;
	stateReason?: StateReason;
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
	reactions: Reaction[];
	issueType?: string;
}

export interface IssueReference {
	id: number;
	number: number;
	title: string;
	state: GithubItemStateEnum;
	url: string;
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
	/** Undefined when the pull request was loaded through the REST API, which doesn't report it. */
	viewerCanUpdate?: boolean;
	autoMerge?: boolean;
	autoMergeMethod?: MergeMethod;
	allowAutoMerge?: boolean;
	mergeCommitMeta?: { title: string, description: string };
	squashCommitMeta?: { title: string, description: string };
	suggestedReviewers?: ISuggestedReviewer[];
	closingIssues?: IssueReference[];
	hasComments?: boolean;
	additions?: number;
	deletions?: number;
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
	updatedAt: Date;
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

export interface IIssueEditData {
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
	databaseId: number | null | undefined;
	url: string | undefined;
	avatarUrl: string | undefined;
	state: CheckState;
	description: string | null;
	targetUrl: string | null;
	context: string; // Job name
	workflowName: string | undefined;
	event: string | undefined;
	isRequired: boolean;
	isCheckRun: boolean;
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
