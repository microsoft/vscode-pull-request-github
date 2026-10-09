/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { Timeline } from './timeline';
import { EventType, TimelineEvent } from '../../src/common/timelineEvent';
import { createAccount, createComment, createCommit, createPullRequest, createReview } from '../fixtures/data';
import { defineComponentFixture, defineFixtureGroup } from '../fixtures/fixtureUtils';

function timelineFixture(events: () => TimelineEvent[], pending = false) {
	return defineComponentFixture({
		width: 820,
		createPullRequest: () => createPullRequest({
			events: events(), isAuthor: false, hasReviewDraft: pending,
			pendingReviewSummaryText: pending ? 'One remaining question about focus restoration.' : undefined,
		}),
		render: pr => <div id="timeline"><Timeline events={pr.events} isIssue={pr.isIssue} /></div>,
	});
}

export default defineFixtureGroup({ path: 'Components/Timeline' }, {
	Discussion: timelineFixture(() => [createComment(), createReview('APPROVED')]),
	Commits: timelineFixture(() => [
		createCommit(),
		createCommit({ id: 'commit-402', sha: 'abcdef1234567890abcdef1234567890abcdef12', message: 'Fix keyboard regression\n\nCover the empty stack.', status: 'FAILURE', verification: { verified: true, state: 'VALID', wasSignedByGitHub: true } }),
		{ id: 'new-commits', event: EventType.NewCommitsSinceReview },
	]),
	PendingReview: timelineFixture(() => [createReview('PENDING', { body: '', bodyHTML: '', submittedAt: '' })], true),
	BranchLifecycle: timelineFixture(() => [
		{ id: 'base-change', event: EventType.BaseRefChanged, actor: createAccount(), createdAt: '2025-01-15T10:00:00Z', previousRefName: 'release', currentRefName: 'main' },
		{ id: 'close', event: EventType.Closed, actor: createAccount(), createdAt: '2025-01-15T10:30:00Z' },
		{ id: 'reopen', event: EventType.Reopened, actor: createAccount(), createdAt: '2025-01-15T11:00:00Z' },
	]),
	Merged: timelineFixture(() => [
		{ id: 'merge', graphNodeId: 'merge-1', event: EventType.Merged, user: createAccount(), createdAt: '2025-01-15T11:00:00Z', mergeRef: 'main', sha: '1234567890abcdef', commitUrl: 'https://github.com/octocat/component-explorer/commit/1234567', url: 'https://github.com/octocat/component-explorer/pull/102' },
		{ id: 'delete', event: EventType.HeadRefDeleted, actor: createAccount(), createdAt: '2025-01-15T11:30:00Z', headRef: 'feature/stack-navigation' },
	]),
	Assignments: timelineFixture(() => [
		{ id: 501, event: EventType.Assigned, actor: createAccount(), createdAt: '2025-01-15T10:00:00Z', assignees: [createAccount('alice'), createAccount('bob')] },
		{ id: 502, event: EventType.Unassigned, actor: createAccount(), createdAt: '2025-01-15T10:05:00Z', unassignees: [createAccount('carol')] },
	]),
	RelatedIssue: timelineFixture(() => [{
		id: 'reference', event: EventType.CrossReferenced, actor: createAccount(), createdAt: '2025-01-15T11:00:00Z', willCloseTarget: true,
		source: { number: 88, url: 'https://github.com/octocat/component-explorer/issues/88', extensionUrl: 'https://github.com/octocat/component-explorer/issues/88', title: 'Keyboard focus is lost after refresh', isIssue: true, owner: 'octocat', repo: 'component-explorer' },
	}]),
	CopilotSession: timelineFixture(() => [
		{ id: 'agent-start', event: EventType.CopilotStarted, createdAt: '2025-01-15T10:00:00Z', onBehalfOf: createAccount(), sessionLink: { id: 1, host: 'github.com', owner: 'octocat', repo: 'component-explorer', pullNumber: 102, sessionIndex: 0 } },
		{ id: 'agent-finish', event: EventType.CopilotFinished, createdAt: '2025-01-15T11:00:00Z', onBehalfOf: createAccount() },
	]),
	CopilotFailed: timelineFixture(() => [{
		id: 'agent-error', event: EventType.CopilotFinishedError, createdAt: '2025-01-15T11:00:00Z', onBehalfOf: createAccount(),
		sessionLink: { id: 1, host: 'github.com', owner: 'octocat', repo: 'component-explorer', pullNumber: 102, sessionIndex: 0 },
	}]),
});
