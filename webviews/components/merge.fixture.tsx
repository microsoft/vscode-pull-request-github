/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { MergeStatus, PrActions, StatusChecksSection } from './merge';
import { CheckState, GithubItemStateEnum, MergeQueueState, PullRequestMergeability } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import { createCheck, createPullRequest } from '../fixtures/data';
import { clickFixtureElement, defineComponentFixture, defineFixtureGroup, defineThemeVariants, FixtureTheme } from '../fixtures/fixtureUtils';

const renderChecks = (pr: PullRequest) => <StatusChecksSection pr={pr} isSimple={false} />;

function checksFixture(overrides: () => Partial<PullRequest>, expanded = true, defaultTheme = FixtureTheme.Dark) {
	return defineComponentFixture({
		defaultTheme,
		createPullRequest: () => createPullRequest(overrides()),
		render: renderChecks,
		prepare: expanded ? async container => {
			if (container.querySelector('#status-checks-display-button[aria-expanded="false"]')) {
				await clickFixtureElement('#status-checks-display-button')(container);
			}
		} : undefined,
	});
}

function actionFixture(overrides: () => Partial<PullRequest>, confirm = false) {
	return defineComponentFixture({
		createPullRequest: () => createPullRequest(overrides()),
		render: pr => <div id="status-checks"><PrActions pr={pr} isSimple={false} /></div>,
		prepare: confirm ? clickFixtureElement('.automerge-section > button') : undefined,
	});
}

function mergeStatusFixture(mergeable: PullRequestMergeability) {
	return defineComponentFixture({
		render: () => <MergeStatus mergeable={mergeable} isSimple={false} canUpdateBranch={true} canUpdateWithMergeCommit={true} />,
	});
}

const checks = defineFixtureGroup({
	Successful: checksFixture(() => ({})),
	Failed: defineThemeVariants(defaultTheme => checksFixture(() => ({
		mergeable: PullRequestMergeability.NotMergeable,
		status: { state: CheckState.Failure, statuses: [createCheck(CheckState.Failure, { description: 'Unit tests failed on Windows' })] },
	}), true, defaultTheme)),
	Pending: checksFixture(() => ({
		mergeable: PullRequestMergeability.Unknown,
		status: { state: CheckState.Pending, statuses: [createCheck(CheckState.Pending, { description: 'Waiting for a runner' })] },
	})),
	MixedWorkflows: checksFixture(() => ({
		status: { state: CheckState.Failure, statuses: [
			createCheck(CheckState.Success, { id: 'lint', context: 'Lint', workflowName: 'Quality' }),
			createCheck(CheckState.Failure, { id: 'windows', context: 'Windows tests', description: '3 tests failed' }),
			createCheck(CheckState.Pending, { id: 'linux', context: 'Linux tests', description: 'Running' }),
			createCheck(CheckState.Neutral, { id: 'preview', context: 'Deploy preview', workflowName: 'Preview', isRequired: false, description: 'Skipped for draft pull requests' }),
		] },
	})),
	NoDetailsOrLogs: checksFixture(() => ({
		status: { state: CheckState.Failure, statuses: [createCheck(CheckState.Failure, { targetUrl: null, databaseId: null, isCheckRun: false })] },
	})),
	NoChecks: checksFixture(() => ({ status: null })),
	ReviewsRequired: checksFixture(() => ({
		reviewRequirement: { count: 2, state: CheckState.Pending, approvals: ['alice'], requestedChanges: [] },
	})),
	ChangesRequested: checksFixture(() => ({
		reviewRequirement: { count: 1, state: CheckState.Failure, approvals: [], requestedChanges: ['reviewer'] },
	})),
	Approved: checksFixture(() => ({
		reviewRequirement: { count: 1, state: CheckState.Success, approvals: ['reviewer'], requestedChanges: [] },
	})),
	MergedBranchCleanup: checksFixture(() => ({ state: GithubItemStateEnum.Merged })),
});

const mergeStatus = defineFixtureGroup({
	Mergeable: mergeStatusFixture(PullRequestMergeability.Mergeable),
	Conflicting: mergeStatusFixture(PullRequestMergeability.Conflict),
	Behind: mergeStatusFixture(PullRequestMergeability.Behind),
	Protected: mergeStatusFixture(PullRequestMergeability.NotMergeable),
	Checking: mergeStatusFixture(PullRequestMergeability.Unknown),
});

const mergeActions = defineFixtureGroup({
	Ready: actionFixture(() => ({})),
	ConfirmMerge: actionFixture(() => ({}), true),
	ConfirmSquash: actionFixture(() => ({ defaultMergeMethod: 'squash', squashCommitMeta: { title: 'Add keyboard navigation', description: 'Keep focus stable while changing stacks.' } }), true),
	Draft: actionFixture(() => ({ isDraft: true })),
	DraftBusy: actionFixture(() => ({ isDraft: true, busy: true })),
	AutoMergeOff: actionFixture(() => ({ mergeable: PullRequestMergeability.NotMergeable, allowAutoMerge: true, autoMerge: false })),
	AutoMergeOn: actionFixture(() => ({ mergeable: PullRequestMergeability.NotMergeable, allowAutoMerge: true, autoMerge: true, autoMergeMethod: 'squash' })),
	MergeWhenReady: actionFixture(() => ({ mergeable: PullRequestMergeability.NotMergeable, allowAutoMerge: true, autoMerge: true, mergeQueueMethod: 'squash' })),
	AddToQueue: actionFixture(() => ({ mergeQueueMethod: 'squash' })),
	QueueHead: actionFixture(() => ({ mergeQueueEntry: { position: 1, state: MergeQueueState.AwaitingChecks, url: 'https://github.com/octocat/component-explorer/queue/main' } })),
	QueueBlocked: actionFixture(() => ({ mergeQueueEntry: { position: 2, state: MergeQueueState.Locked, url: 'https://github.com/octocat/component-explorer/queue/main' } })),
	QueueConflicting: actionFixture(() => ({ mergeQueueEntry: { position: 2, state: MergeQueueState.Unmergeable, url: 'https://github.com/octocat/component-explorer/queue/main' } })),
});

export default defineFixtureGroup({ path: 'Components/Merge' }, {
	Checks: checks,
	Status: mergeStatus,
	Actions: mergeActions,
});
