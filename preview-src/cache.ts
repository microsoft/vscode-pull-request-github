/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vscode } from './message';
import { PullRequestStateEnum, IAccount, ReviewState, ILabel, MergeMethod, MergeMethodsAvailability } from '../src/github/interface';
import { TimelineEvent } from '../src/common/timelineEvent';
import { ReposGetCombinedStatusForRefResponse } from '@octokit/rest';

export interface PullRequest {
	number: number;
	title: string;
	url: string;
	createdAt: string;
	body: string;
	bodyHTML?: string;
	author: IAccount;
	state: PullRequestStateEnum;
	events: TimelineEvent[];
	isCurrentlyCheckedOut: boolean;
	base: string;
	head: string;
	labels: ILabel[];
	commitsCount: number;
	repositoryDefaultBranch: any;
	canEdit: boolean;
	/**
	 * Users with push access to repo have rights to merge/close PRs,
	 * edit title/description, assign reviewers/labels etc.
	 */
	hasWritePermission: boolean;
	pendingCommentText?: string;
	pendingCommentDrafts?: { [key: string]: string; };
	status: ReposGetCombinedStatusForRefResponse;
	mergeable: boolean;
	defaultMergeMethod: MergeMethod;
	mergeMethodsAvailability: MergeMethodsAvailability;
	supportsGraphQl: boolean;
	reviewers: ReviewState[];
	isDraft: boolean;
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
