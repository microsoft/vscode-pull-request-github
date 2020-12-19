/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GitPullRequest } from 'azure-devops-node-api/interfaces/GitInterfaces';

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
	NotSet = 0,
	/**
     * Pull request merge is queued.
     */
	Queued = 1,
	/**
     * Pull request merge failed due to conflicts.
     */
	Conflicts = 2,
	/**
     * Pull request merge succeeded.
     */
	Succeeded = 3,
	/**
     * Pull request merge rejected by policy.
     */
	RejectedByPolicy = 4,
	/**
     * Pull request merge failed.
     */
	Failure = 5
}

export declare enum PullRequestStatus {
	/**
     * Status not set. Default state.
     */
	NotSet = 0,
	/**
     * Pull request is active.
     */
	Active = 1,
	/**
     * Pull request is abandoned.
     */
	Abandoned = 2,
	/**
     * Pull request is completed.
     */
	Completed = 3,
	/**
     * Used in pull request search criteria to include all statuses.
     */
	All = 4
}

export interface ReviewState {
	reviewer: IAccount;
	state: string;
}

export interface IAccount {
	id?: string;
	name?: string;
	avatarUrl?: string;
	url?: string;
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
	ref: string;
	sha: string;
	repo: IRepository;
	exists?: boolean;
}

export interface ILabel {
	name: string;
	color: string;
}

export interface Issue {
	id?: number;
	number?: number;
	url?: string;
	state?: string;
	body?: string;
	bodyHTML?: string;
	title?: string;
	assignees?: IAccount[];
	createdAt?: string;
	user?: IAccount;
	labels?: ILabel[];
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

export enum PullRequestVote {
	NO_VOTE = 0,
	WAITING_FOR_AUTHOR = -5,
	REJECTED = -10,
	APPROVED_WITH_SUGGESTION = 5,
	APPROVED = 10
}

export interface PullRequest extends GitPullRequest {
	head?: IGitHubRef;
	base?: IGitHubRef;
	merged?: boolean;
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

export interface ICommentPermissions {
	canEdit: boolean;
	canDelete: boolean;
}