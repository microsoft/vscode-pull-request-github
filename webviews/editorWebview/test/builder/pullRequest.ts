/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GithubItemStateEnum, PullRequestMergeability } from '../../../../src/github/interface';
import { createBuilderClass } from '../../../../src/test/builders/base';
import { CombinedStatusBuilder } from '../../../../src/test/builders/rest/combinedStatusBuilder';
import { PullRequest } from '../../../common/cache';

import { AccountBuilder } from './account';

export const PullRequestBuilder = createBuilderClass<PullRequest>()({
	number: { default: 1234 },
	title: { default: 'the default title' },
	url: { default: 'https://github.com/owner/name/pulls/1234' },
	createdAt: { default: '2019-01-01T10:00:00Z' },
	body: { default: 'the *default* body' },
	bodyHTML: { default: 'the <b>default</b> body' },
	author: { linked: AccountBuilder },
	state: { default: GithubItemStateEnum.Open },
	events: { default: [] },
	isCurrentlyCheckedOut: { default: true },
	isRemoteBaseDeleted: { default: false },
	base: { default: 'main' },
	isRemoteHeadDeleted: { default: false },
	isLocalHeadDeleted: { default: false },
	head: { default: 'my-fork:my-branch' },
	labels: { default: [] },
	commitsCount: { default: 10 },
	repositoryDefaultBranch: { default: 'main' },
	canEdit: { default: true },
	hasWritePermission: { default: true },
	pendingCommentText: { default: null },
	pendingCommentDrafts: { default: null },
	status: { linked: CombinedStatusBuilder },
	mergeable: { default: PullRequestMergeability.Mergeable },
	defaultMergeMethod: { default: 'merge' },
	mergeMethodsAvailability: { default: { merge: true, squash: true, rebase: true } },
	allowAutoMerge: { default: false },
	reviewers: { default: [] },
	isDraft: { default: false },
	isIssue: { default: false },
	assignees: { default: [] },
	milestone: { default: undefined },
	continueOnGitHub: { default: false },
	currentUserReviewState: { default: 'REQUESTED' },
	isDarkTheme: { default: true }
});
