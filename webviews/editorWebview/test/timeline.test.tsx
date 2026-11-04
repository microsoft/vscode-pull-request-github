/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { cleanup, render } from 'react-testing-library';
import { createSandbox, SinonSandbox } from 'sinon';

import { AccountBuilder } from './builder/account';
import { PullRequestBuilder } from './builder/pullRequest';
import { AssignEvent, EventType, TimelineEvent } from '../../../src/common/timelineEvent';
import { ITeam } from '../../../src/github/interface';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { Timeline } from '../../components/timeline';

const alice = new AccountBuilder().login('alice').id('alice-id').url('https://github.com/alice').build();
const bob = new AccountBuilder().login('bob').id('bob-id').url('https://github.com/bob').build();
const carol = new AccountBuilder().login('carol').id('carol-id').url('https://github.com/carol').build();
const team: ITeam = {
	id: 'team-id',
	name: 'Reviewers',
	slug: 'reviewers',
	org: 'octo',
	url: 'https://github.com/orgs/octo/teams/reviewers',
};

const start = '2026-01-01T10:00:00Z';
const oneMinuteLater = '2026-01-01T10:01:00Z';
const anHourLater = '2026-01-01T11:00:00Z';

function label(name: string) {
	return { name, color: 'd73a4a', displayName: name };
}

function renderTimeline(events: TimelineEvent[]) {
	const pr = new PullRequestBuilder().build();
	pr.events = events;
	const context = new PRContext(pr);
	return render(
		<PullRequestContext.Provider value={context}>
			<Timeline events={events} isIssue={false} />
		</PullRequestContext.Provider>
	);
}

function messages(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('.commit-message .message')).map(element => element.textContent!.replace(/\s+/g, ' ').trim());
}

function details(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('.timeline-event-detail')).map(element => element.textContent!);
}

describe('Timeline', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	it('combines consecutive label changes by the same actor', function () {
		const view = renderTimeline([
			{ id: '1', event: EventType.Labeled, actor: alice, createdAt: start, label: label('bug') },
			{ id: '2', event: EventType.Labeled, actor: alice, createdAt: oneMinuteLater, label: label('feature') },
			{ id: '3', event: EventType.Unlabeled, actor: alice, createdAt: oneMinuteLater, label: label('question') },
			{ id: '4', event: EventType.Labeled, actor: bob, createdAt: oneMinuteLater, label: label('docs') },
		]);

		assert.deepStrictEqual(messages(view.container), [
			'added bug feature and removed question labels',
			'added the docs label',
		]);
		assert.strictEqual(view.container.querySelectorAll('.timeline-label').length, 4);
	});

	it('does not combine label changes that are far apart', function () {
		const view = renderTimeline([
			{ id: '1', event: EventType.Labeled, actor: alice, createdAt: start, label: label('bug') },
			{ id: '2', event: EventType.Unlabeled, actor: alice, createdAt: anHourLater, label: label('bug') },
		]);

		assert.deepStrictEqual(messages(view.container), [
			'added the bug label',
			'removed the bug label',
		]);
	});

	it('combines review request changes and shows teams', function () {
		const view = renderTimeline([
			{ id: '1', event: EventType.ReviewRequested, actor: alice, createdAt: start, reviewer: bob },
			{ id: '2', event: EventType.ReviewRequested, actor: alice, createdAt: start, reviewer: team },
			{ id: '3', event: EventType.ReviewRequestRemoved, actor: alice, createdAt: oneMinuteLater, reviewer: carol },
			{ id: '4', event: EventType.ReviewRequested, actor: alice, createdAt: anHourLater, reviewer: alice },
		]);

		assert.deepStrictEqual(messages(view.container), [
			'requested reviews from bob and Reviewers and removed the request for review from carol',
			'self-requested a review',
		]);
	});

	it('lists three or more reviewers without React key warnings', function () {
		const consoleError = sinon.spy(console, 'error');

		const view = renderTimeline([
			{ id: '1', event: EventType.ReviewRequested, actor: alice, createdAt: start, reviewer: bob },
			{ id: '2', event: EventType.ReviewRequested, actor: alice, createdAt: start, reviewer: carol },
			{ id: '3', event: EventType.ReviewRequested, actor: alice, createdAt: start, reviewer: team },
		]);

		assert.deepStrictEqual(messages(view.container), ['requested reviews from bob, carol, and Reviewers']);
		sinon.assert.notCalled(consoleError);
	});

	it('still combines assignment changes without mutating the events', function () {
		const firstAssignment: AssignEvent = { id: 1, event: EventType.Assigned, actor: alice, createdAt: start, assignees: [bob] };
		const view = renderTimeline([
			firstAssignment,
			{ id: 2, event: EventType.Assigned, actor: alice, createdAt: oneMinuteLater, assignees: [carol] },
		]);

		assert.deepStrictEqual(messages(view.container), ['assigned bob and carol']);
		assert.deepStrictEqual(firstAssignment.assignees.map(assignee => assignee.login), ['bob']);
	});

	it('renders title, milestone, draft, and branch events', function () {
		const view = renderTimeline([
			{ id: '1', event: EventType.RenamedTitle, actor: alice, createdAt: start, previousTitle: 'Old title', currentTitle: 'New title' },
			{ id: '2', event: EventType.Milestoned, actor: alice, createdAt: start, milestoneTitle: 'October 2026' },
			{ id: '3', event: EventType.Demilestoned, actor: alice, createdAt: start, milestoneTitle: 'September 2026' },
			{ id: '4', event: EventType.ConvertToDraft, actor: alice, createdAt: start },
			{ id: '5', event: EventType.ReadyForReview, actor: alice, createdAt: start },
			{
				id: '6',
				event: EventType.HeadRefForcePushed,
				actor: alice,
				createdAt: start,
				headRef: 'my-branch',
				beforeCommit: { sha: '1234567890', url: 'https://github.com/octo/repo/commit/1234567890' },
				afterCommit: { sha: 'abcdef0123', url: 'https://github.com/octo/repo/commit/abcdef0123' },
			},
			{ id: '7', event: EventType.HeadRefForcePushed, actor: alice, createdAt: start, headRef: 'my-branch' },
			{ id: '8', event: EventType.HeadRefRestored, actor: alice, createdAt: start, headRef: 'my-branch' },
		]);

		assert.deepStrictEqual(messages(view.container), [
			'changed the title Old title New title',
			'added this to the October 2026 milestone',
			'removed this from the September 2026 milestone',
			'marked this pull request as draft',
			'marked this pull request as ready for review',
			'force-pushed the my-branch branch from 1234567 to abcdef0',
			'force-pushed the my-branch branch',
			'restored the my-branch branch',
		]);
		assert.strictEqual(view.container.querySelector('.previous-title')!.textContent, 'Old title');
		assert.strictEqual(view.container.querySelector('.current-title')!.textContent, 'New title');
		const commitLinks = Array.from(view.container.querySelectorAll('.message a.sha')).map(link => link.getAttribute('href'));
		assert.deepStrictEqual(commitLinks, [
			'https://github.com/octo/repo/commit/1234567890',
			'https://github.com/octo/repo/commit/abcdef0123',
		]);
	});

	it('renders review dismissal, auto-merge, and merge queue events with their reasons', function () {
		const view = renderTimeline([
			{ id: '1', event: EventType.ReviewDismissed, actor: alice, createdAt: start, reviewAuthor: bob, dismissalMessage: 'Outdated feedback' },
			{ id: '2', event: EventType.ReviewDismissed, actor: alice, createdAt: start },
			{ id: '3', event: EventType.AutoMergeEnabled, actor: alice, createdAt: start, mergeMethod: 'squash' },
			{ id: '4', event: EventType.AutoMergeEnabled, actor: alice, createdAt: start },
			{ id: '5', event: EventType.AutoMergeDisabled, actor: alice, createdAt: start, reason: 'Pull request was converted to draft' },
			{ id: '6', event: EventType.AddedToMergeQueue, actor: alice, createdAt: start },
			{ id: '7', event: EventType.RemovedFromMergeQueue, actor: alice, createdAt: start, reason: 'Checks failed' },
		]);

		assert.deepStrictEqual(messages(view.container), [
			'dismissed bob\'s review',
			'dismissed a review',
			'enabled auto-merge (squash)',
			'enabled auto-merge',
			'disabled auto-merge',
			'added this pull request to the merge queue',
			'removed this pull request from the merge queue',
		]);
		assert.deepStrictEqual(details(view.container), [
			'Outdated feedback',
			'Pull request was converted to draft',
			'Checks failed',
		]);
	});
});
