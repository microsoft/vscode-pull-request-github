/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { Overview } from './overview';
import { CheckState, GithubItemStateEnum, PullRequestMergeability } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import { createCheck, createPullRequest, createStack } from '../fixtures/data';
import { defineComponentFixture, defineFixtureGroup, defineThemeVariants, FixtureTheme } from '../fixtures/fixtureUtils';

const renderOverview = (pr: PullRequest) => <Overview {...pr} />;

function overviewFixture(overrides: () => Partial<PullRequest>, defaultTheme = FixtureTheme.Dark) {
	return defineComponentFixture({
		view: 'activityBar', width: 360, height: 650, defaultTheme,
		createPullRequest: () => createPullRequest({ isAuthor: false, ...overrides() }),
		render: renderOverview,
	});
}

export default defineFixtureGroup({ path: 'Views/Activity bar overview' }, {
	Ready: defineThemeVariants(defaultTheme => overviewFixture(() => ({}), defaultTheme)),
	Draft: overviewFixture(() => ({ isDraft: true })),
	FailedChecks: overviewFixture(() => ({
		mergeable: PullRequestMergeability.NotMergeable,
		status: { state: CheckState.Failure, statuses: [createCheck(CheckState.Failure)] },
	})),
	ReviewDraft: overviewFixture(() => ({ hasReviewDraft: true, pendingCommentText: 'Please cover keyboard focus when the stack changes.' })),
	Merged: overviewFixture(() => ({ state: GithubItemStateEnum.Merged })),
	Stacked: overviewFixture(() => ({ stack: createStack() })),
});
