/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { Overview, OverviewPreview } from './overview';
import { CheckState, GithubItemStateEnum, MergeQueueState, PullRequestMergeability } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import { createAccount, createCheck, createComment, createCommit, createPullRequest, createReview, createStack } from '../fixtures/data';
import { defineFixtureGroup, definePullRequestFixture, defineThemeVariants, FixtureTheme } from '../fixtures/fixtureUtils';

const renderOverview = (pr: PullRequest) => <Overview {...pr} />;

function overviewFixture(width: number, defaultTheme: FixtureTheme) {
	return definePullRequestFixture({
		width,
		height: 1000,
		defaultTheme,
		createPullRequest: () => createPullRequest({ stack: createStack() }),
		render: renderOverview,
	});
}

function stateFixture(overrides: () => Partial<PullRequest>) {
	return definePullRequestFixture({
		width: 1100,
		height: 900,
		createPullRequest: () => createPullRequest(overrides()),
		render: renderOverview,
	});
}

export default defineFixtureGroup({ path: 'Views/Pull request overview' }, {
	Desktop: defineThemeVariants(defaultTheme => overviewFixture(1100, defaultTheme)),
	Narrow: defineThemeVariants(defaultTheme => overviewFixture(360, defaultTheme)),
	Scrollable: defineThemeVariants(defaultTheme => definePullRequestFixture({
		width: 900,
		viewportHeight: 420,
		defaultTheme,
		createPullRequest: () => createPullRequest({ stack: createStack() }),
		render: renderOverview,
	})),
	Draft: stateFixture(() => ({ isDraft: true })),
	Conflicts: stateFixture(() => ({ mergeable: PullRequestMergeability.Conflict, canUpdateBranch: true })),
	FailedChecks: stateFixture(() => ({
		mergeable: PullRequestMergeability.NotMergeable,
		status: { state: CheckState.Failure, statuses: [createCheck(CheckState.Failure, { description: '2 tests failed' })] },
	})),
	AwaitingReview: stateFixture(() => ({
		mergeable: PullRequestMergeability.NotMergeable,
		reviewRequirement: { count: 2, state: CheckState.Pending, approvals: [], requestedChanges: [] },
		reviewers: [{ reviewer: createAccount('reviewer'), state: 'REQUESTED' }],
	})),
	ChangesRequested: stateFixture(() => ({
		mergeable: PullRequestMergeability.NotMergeable,
		reviewRequirement: { count: 1, state: CheckState.Failure, approvals: [], requestedChanges: ['reviewer'] },
		reviewers: [{ reviewer: createAccount('reviewer'), state: 'CHANGES_REQUESTED' }],
		events: [createReview('CHANGES_REQUESTED', { body: 'Please add a regression test.', bodyHTML: '<p>Please add a regression test.</p>' })],
	})),
	Queued: stateFixture(() => ({ mergeQueueEntry: { position: 2, state: MergeQueueState.Queued, url: 'https://github.com/octocat/component-explorer/queue/main' } })),
	Merged: stateFixture(() => ({ state: GithubItemStateEnum.Merged, isRemoteHeadDeleted: true, isLocalHeadDeleted: true })),
	Closed: stateFixture(() => ({ state: GithubItemStateEnum.Closed })),
	ReadOnly: stateFixture(() => ({ hasWritePermission: false, canEdit: false, isAuthor: false, isCurrentlyCheckedOut: false })),
	Issue: stateFixture(() => ({ isIssue: true, title: 'Keyboard navigation skips the stack', titleHTML: 'Keyboard navigation skips the stack' })),
	IssueCompleted: stateFixture(() => ({ isIssue: true, state: GithubItemStateEnum.Closed, stateReason: 'COMPLETED' })),
	Discussion: stateFixture(() => ({ events: [createCommit(), createComment(), createReview('APPROVED')] })),
	PendingReview: stateFixture(() => ({
		isAuthor: false, hasReviewDraft: true, pendingReviewSummaryText: 'The navigation works well. One question about focus restoration.',
		events: [createReview('PENDING', { body: '', bodyHTML: '', submittedAt: '' })],
	})),
	ColdLoadPreview: definePullRequestFixture({
		width: 1100,
		height: 600,
		createPullRequest,
		render: pr => <OverviewPreview {...pr} />,
	}),
});
