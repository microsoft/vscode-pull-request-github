/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export enum PRType {
	Query,
	All,
	LocalPullRequest
}

export enum ReviewEvent {
	Approve = 'APPROVE',
	RequestChanges = 'REQUEST_CHANGES',
	Comment = 'COMMENT'
}

export enum GithubItemStateEnum {
	Open,
	Merged,
	Closed,
}

export enum PullRequestMergeability {
	Mergeable,
	NotMergeable,
	Unknown
}

export interface ReviewState {
	reviewer: IAccount;
	state: string;
}

export interface IAccount {
	login: string;
	name?: string;
	avatarUrl?: string;
	url: string;
	email?: string;
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
	head?: IGitHubRef;
	base?: IGitHubRef;
	merged?: boolean;
	mergeable?: PullRequestMergeability;
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
	mergeMethodsAvailability: MergeMethodsAvailability
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

export interface PullRequestChecks {
	state: string;
	statuses: {
		id: string;
		url?: string;
		avatar_url?: string;
		state?: string;
		description?: string;
		target_url?: string;
		context: string;
	}[];
}