/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as Github from '@octokit/rest';
import { Comment } from '../common/comment';
import { GitHubRef } from '../common/githubRef';
import { TimelineEvent } from '../common/timelineEvent';
import { Remote } from '../common/remote';
import { Repository, Branch } from '../typings/git';
import { PullRequestsCreateParams } from '@octokit/rest';

export enum PRType {
	RequestReview = 0,
	AssignedToMe = 1,
	Mine = 2,
	Mention = 3,
	All = 4,
	LocalPullRequest = 5
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

export interface IAccount {
	login: string;
	avatarUrl: string;
	htmlUrl: string;
	type: string;
	isUser?: boolean;
	isEnterprise?: boolean;
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

export interface IRawPullRequest {
	url: string;
	number: number;
	state: string;
	body: string;
	title: string;
	assignee: IAccount;
	createdAt: string;
	updatedAt: string;
	head: IGitHubRef;
	base: IGitHubRef;
	user: IAccount;
	labels: ILabel[];
	// comments: number;
	// commits: number;
	merged: boolean;
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

export interface IPullRequestModel {
	remote: Remote;
	prNumber: number;
	title: string;
	html_url: string;
	state: PullRequestStateEnum;
	commentCount: number;
	commitCount: number;
	author: IAccount;
	assignee: IAccount;
	createdAt: string;
	updatedAt: string;
	isOpen: boolean;
	isMerged: boolean;
	head?: GitHubRef;
	base?: GitHubRef;
	mergeBase?: string;
	localBranchName?: string;
	userAvatar: string;
	userAvatarUri: vscode.Uri;
	body: string;
	bodyHTML?: string;
	labels: string[];
	update(prItem: IRawPullRequest): void;
	equals(other: IPullRequestModel): boolean;
}

export interface IPullRequestsPagingOptions {
	fetchNextPage: boolean;
}

export interface IGitHubRepository {
	authenticate(): Promise<boolean>;
}

export interface IPullRequestEditData {
	body?: string;
	title?: string;
}

export interface IPullRequestManager {
	activePullRequest?: IPullRequestModel;
	repository: Repository;
	readonly onDidChangeActivePullRequest: vscode.Event<void>;
	getLocalPullRequests(): Promise<IPullRequestModel[]>;
	deleteLocalPullRequest(pullRequest: IPullRequestModel, force?: boolean): Promise<void>;
	getPullRequests(type: PRType, options?: IPullRequestsPagingOptions): Promise<[IPullRequestModel[], boolean]>;
	getMetadata(remote: string): Promise<any>;
	getGitHubRemotes(): Remote[];
	mayHaveMorePages(): boolean;
	getPullRequestComments(pullRequest: IPullRequestModel): Promise<Comment[]>;
	getPullRequestCommits(pullRequest: IPullRequestModel): Promise<Github.PullRequestsGetCommitsResponseItem[]>;
	getCommitChangedFiles(pullRequest: IPullRequestModel, commit: Github.PullRequestsGetCommitsResponseItem): Promise<Github.ReposGetCommitResponseFilesItem[]>;
	getReviewComments(pullRequest: IPullRequestModel, reviewId: number): Promise<Comment[]>;
	getTimelineEvents(pullRequest: IPullRequestModel): Promise<TimelineEvent[]>;
	getIssueComments(pullRequest: IPullRequestModel): Promise<Github.IssuesGetCommentsResponseItem[]>;
	createIssueComment(pullRequest: IPullRequestModel, text: string): Promise<Comment>;
	createCommentReply(pullRequest: IPullRequestModel, body: string, reply_to: string): Promise<Comment>;
	createComment(pullRequest: IPullRequestModel, body: string, path: string, position: number): Promise<Comment>;
	getPullRequestDefaults(): Promise<PullRequestsCreateParams>;
	createPullRequest(params: PullRequestsCreateParams): Promise<IPullRequestModel>;
	mergePullRequest(pullRequest: IPullRequestModel): Promise<any>;
	editReviewComment(pullRequest: IPullRequestModel, commentId: string, text: string): Promise<Comment>;
	editIssueComment(pullRequest: IPullRequestModel, commentId: string, text: string): Promise<Comment>;
	deleteIssueComment(pullRequest: IPullRequestModel, commentId: string): Promise<void>;
	deleteReviewComment(pullRequest: IPullRequestModel, commentId: string): Promise<void>;
	canEditPullRequest(pullRequest: IPullRequestModel): boolean;
	editPullRequest(pullRequest: IPullRequestModel, toEdit: IPullRequestEditData): Promise<Github.PullRequestsUpdateResponse>;
	closePullRequest(pullRequest: IPullRequestModel): Promise<IRawPullRequest>;
	approvePullRequest(pullRequest: IPullRequestModel, message?: string): Promise<any>;
	requestChanges(pullRequest: IPullRequestModel, message?: string): Promise<any>;
	getPullRequestFileChangesInfo(pullRequest: IPullRequestModel): Promise<IRawFileChange[]>;
	getPullRequestRepositoryDefaultBranch(pullRequest: IPullRequestModel): Promise<string>;
	getStatusChecks(pullRequest: IPullRequestModel): Promise<Github.ReposGetCombinedStatusForRefResponse>;

	/**
	 * Fullfill information for a pull request which we can't fetch with one single api call.
	 * 1. base. This property might not exist in search results
	 * 2. head. This property might not exist in search results
	 * 3. merge base. This is necessary as base might not be the commit that files in Pull Request are being compared to.
	 * @param pullRequest
	 */
	fullfillPullRequestMissingInfo(pullRequest: IPullRequestModel): Promise<void>;
	updateRepositories(): Promise<void>;
	authenticate(): Promise<boolean>;

	/**
	 * git related APIs
	 */

	resolvePullRequest(owner: string, repositoryName: string, pullReuqestNumber: number): Promise<IPullRequestModel>;
	getMatchingPullRequestMetadataForBranch();
	checkoutExistingPullRequestBranch(pullRequest: IPullRequestModel): Promise<boolean>;
	getBranch(remote: Remote, branchName: string): Promise<Branch>;
	checkout(branchName: string): Promise<void>;
	fetchAndCheckout(pullRequest: IPullRequestModel): Promise<void>;
}

export interface ITelemetry {
	on(action: 'startup'): Promise<void>;
	on(action: 'authSuccess'): Promise<void>;
	on(action: 'commentsFromEditor'): Promise<void>;
	on(action: 'commentsFromDescription'): Promise<void>;
	on(action: 'prListExpandLocalPullRequest'): Promise<void>;
	on(action: 'prListExpandRequestReview'): Promise<void>;
	on(action: 'prListExpandAssignedToMe'): Promise<void>;
	on(action: 'prListExpandMine'): Promise<void>;
	on(action: 'prListExpandAll'): Promise<void>;
	on(action: 'prCheckoutFromContext'): Promise<void>;
	on(action: 'prCheckoutFromDescription'): Promise<void>;
	on(action: string): Promise<void>;

	shutdown(): Promise<void>;
}
