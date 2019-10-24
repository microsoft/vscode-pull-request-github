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

export enum PullRequestStateEnum {
	Open,
	Merged,
	Closed,
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
}

export interface PullRequest {
	id: number;
	graphNodeId: string;
	url: string;
	number: number;
	state: string;
	body: string;
	bodyHTML?: string;
	title: string;
	assignee?: IAccount;
	createdAt: string;
	updatedAt: string;
	head?: IGitHubRef;
	base?: IGitHubRef;
	user: IAccount;
	labels: ILabel[];
	merged: boolean;
	mergeable?: boolean;
	isDraft: boolean;
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
