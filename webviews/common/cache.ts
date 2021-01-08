/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vscode } from './message';
import { IAccount, ReviewState, ILabel, MergeMethod, MergeMethodsAvailability, PullRequestMergeability, PullRequestChecks } from '../../src/azdo/interface';
import { TimelineEvent } from '../../src/common/timelineEvent';
import { GitCommitRef, GitPullRequestCommentThread, PullRequestStatus } from 'azure-devops-node-api/interfaces/GitInterfaces';

export enum ReviewType {
	Comment = 'comment',
	Approve = 'approve',
	RequestChanges = 'requestChanges'
}

export interface PullRequest {
	number: number;
	title: string;
	url: string;
	createdAt: string;
	body: string;
	bodyHTML?: string;
	author: IAccount;
	state: PullRequestStatus;
	events: TimelineEvent[];
	isCurrentlyCheckedOut: boolean;
	base: string;
	head: string;
	labels: ILabel[];
	commitsCount: number;
	repositoryDefaultBranch: any;
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
	pendingCommentDrafts?: { [key: string]: string; };
	pendingReviewType?: ReviewType;
	status: PullRequestChecks;
	mergeable: PullRequestMergeability;
	defaultMergeMethod: MergeMethod;
	mergeMethodsAvailability: MergeMethodsAvailability;
	reviewers: ReviewState[];
	isDraft?: boolean;
	isIssue: boolean;

	isAuthor?: boolean;
	threads?: GitPullRequestCommentThread[];
	commits: GitCommitRef[];
}

export function getState(): PullRequest {
	return vscode.getState();
}

export function setState(pullRequest: PullRequest): void {
	const oldPullRequest = getState();

	if (oldPullRequest &&
		oldPullRequest.number && oldPullRequest.number === pullRequest.number) {
		pullRequest.pendingCommentText = oldPullRequest.pendingCommentText;
	}

	if (pullRequest) { vscode.setState(pullRequest); }
}

export function updateState(data: Partial<PullRequest>): void {
	const pullRequest = vscode.getState();
	vscode.setState(Object.assign(pullRequest, data));
}
