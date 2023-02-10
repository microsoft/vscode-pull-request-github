/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
}

export interface ReviewState {
	reviewer: IAccount | ITeam;
	state: string;
}

export interface IAccount {
	login: string;
	name?: string;
	avatarUrl?: string;
	url: string;
	email?: string;
}

export interface ITeam {
	name: string;
	avatarUrl?: string;
	url: string;
	slug: string;
	org: string;
	id: string;
}

export function reviewerId(reviewer: ITeam | IAccount): string {
	return (reviewer as ITeam).id || (reviewer as IAccount).login;
}

export function reviewerLabel(reviewer: ITeam | IAccount): string {
	return (reviewer as ITeam).name || (reviewer as IAccount).login;
}

export function isTeam(reviewer: ITeam | IAccount): reviewer is ITeam {
	return (reviewer as ITeam).id !== undefined;
}

export interface ISuggestedReviewer extends IAccount {
	isAuthor: boolean;
	isCommenter: boolean;
}

export interface IMilestone {
	title: string;
	dueOn?: string | null;
	createdAt: string;
	id: string;
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
	milestone?: IMilestone;
	repositoryOwner?: string;
	repositoryName?: string;
	repositoryUrl?: string;
	comments?: {
		author: IAccount;
		body: string;
		databaseId: number;
	}[];
}

export interface PullRequest extends Issue {
	isDraft?: boolean;
	isRemoteHeadDeleted?: boolean;
	head?: IGitHubRef;
	isRemoteBaseDeleted?: boolean;
	base?: IGitHubRef;
	merged?: boolean;
	mergeable?: PullRequestMergeability;
	autoMerge?: boolean;
	autoMergeMethod?: MergeMethod;
	allowAutoMerge?: boolean;
	suggestedReviewers?: ISuggestedReviewer[];
}

export interface IRawFileChange {
	filename: string;
	previous_filename?: string;
	additions: number;
	deletions: number;
	changes: number;
	status: string;
	raw_url: string;
	blob_url: string;
	patch: string;
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

export interface PullRequestChecks {
	state: CheckState;
	statuses: {
		id: string;
		url?: string;
		avatar_url?: string;
		state?: CheckState;
		description?: string;
		target_url?: string;
		context: string;
	}[];
}
