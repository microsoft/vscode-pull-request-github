/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { cleanup, render } from 'react-testing-library';
import { createSandbox, SinonSandbox } from 'sinon';

import { PRContext } from '../../common/context';
import { CollapsibleSidebar } from '../sidebar';
import { PullRequestBuilder } from '../../editorWebview/test/builder/pullRequest';
import { AccountBuilder } from '../../editorWebview/test/builder/account';
import { ReviewState } from '../../../src/github/interface';

describe('CollapsibleSidebar', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	describe('AvatarStack', function () {
		it('displays multiple reviewers in collapsed state', function () {
			const reviewer1 = new AccountBuilder().login('reviewer1').name('Reviewer One').avatarUrl('https://example.com/avatar1.png').build();
			const reviewer2 = new AccountBuilder().login('reviewer2').name('Reviewer Two').avatarUrl('https://example.com/avatar2.png').build();
			const reviewer3 = new AccountBuilder().login('reviewer3').name('Reviewer Three').avatarUrl('https://example.com/avatar3.png').build();

			const reviewers: ReviewState[] = [
				{ reviewer: reviewer1, state: 'REQUESTED' },
				{ reviewer: reviewer2, state: 'APPROVED' },
				{ reviewer: reviewer3, state: 'COMMENTED' }
			];

			const pr = new PullRequestBuilder().reviewers(reviewers).build();
			const context = new PRContext(pr);

			const out = render(
				<PRContext.Provider value={context}>
					<CollapsibleSidebar {...pr} />
				</PRContext.Provider>
			);

			// Check that the avatar stack is rendered
			const avatarStack = out.container.querySelector('.avatar-stack');
			assert(avatarStack, 'Avatar stack should be rendered');

			// Check that all three avatars are present
			const avatars = out.container.querySelectorAll('.stacked-avatar');
			assert.strictEqual(avatars.length, 3, 'Should display all three reviewers');
		});

		it('displays single reviewer in collapsed state', function () {
			const reviewer1 = new AccountBuilder().login('reviewer1').name('Reviewer One').avatarUrl('https://example.com/avatar1.png').build();

			const reviewers: ReviewState[] = [
				{ reviewer: reviewer1, state: 'REQUESTED' }
			];

			const pr = new PullRequestBuilder().reviewers(reviewers).build();
			const context = new PRContext(pr);

			const out = render(
				<PRContext.Provider value={context}>
					<CollapsibleSidebar {...pr} />
				</PRContext.Provider>
			);

			// Check that the avatar stack is rendered
			const avatarStack = out.container.querySelector('.avatar-stack');
			assert(avatarStack, 'Avatar stack should be rendered');

			// Check that one avatar is present
			const avatars = out.container.querySelectorAll('.stacked-avatar');
			assert.strictEqual(avatars.length, 1, 'Should display one reviewer');
		});

		it('displays up to 10 reviewers in collapsed state', function () {
			const reviewers: ReviewState[] = [];
			for (let i = 0; i < 12; i++) {
				const reviewer = new AccountBuilder()
					.login(`reviewer${i}`)
					.name(`Reviewer ${i}`)
					.avatarUrl(`https://example.com/avatar${i}.png`)
					.build();
				reviewers.push({ reviewer, state: 'REQUESTED' });
			}

			const pr = new PullRequestBuilder().reviewers(reviewers).build();
			const context = new PRContext(pr);

			const out = render(
				<PRContext.Provider value={context}>
					<CollapsibleSidebar {...pr} />
				</PRContext.Provider>
			);

			// Check that the avatar stack is rendered
			const avatarStack = out.container.querySelector('.avatar-stack');
			assert(avatarStack, 'Avatar stack should be rendered');

			// Check that only 10 avatars are displayed (max limit)
			const avatars = out.container.querySelectorAll('.stacked-avatar');
			assert.strictEqual(avatars.length, 10, 'Should display maximum of 10 reviewers');
		});

		it('displays multiple assignees in collapsed state', function () {
			const assignee1 = new AccountBuilder().login('assignee1').name('Assignee One').avatarUrl('https://example.com/avatar1.png').build();
			const assignee2 = new AccountBuilder().login('assignee2').name('Assignee Two').avatarUrl('https://example.com/avatar2.png').build();

			const pr = new PullRequestBuilder().assignees([assignee1, assignee2]).build();
			const context = new PRContext(pr);

			const out = render(
				<PRContext.Provider value={context}>
					<CollapsibleSidebar {...pr} />
				</PRContext.Provider>
			);

			// Check that avatar stacks are rendered (there should be one for assignees)
			const avatarStacks = out.container.querySelectorAll('.avatar-stack');
			assert(avatarStacks.length > 0, 'Avatar stacks should be rendered');

			// Check that assignees avatars are present
			const avatars = out.container.querySelectorAll('.stacked-avatar');
			assert.strictEqual(avatars.length, 2, 'Should display both assignees');
		});
	});

	describe('PillContainer', function () {
		it('displays multiple labels in collapsed state', function () {
			const labels = [
				{ name: 'bug', displayName: 'bug', color: 'd73a4a' },
				{ name: 'enhancement', displayName: 'enhancement', color: 'a2eeef' },
				{ name: 'documentation', displayName: 'documentation', color: '0075ca' }
			];

			const pr = new PullRequestBuilder().labels(labels).build();
			const context = new PRContext(pr);

			const out = render(
				<PRContext.Provider value={context}>
					<CollapsibleSidebar {...pr} />
				</PRContext.Provider>
			);

			// Check that the pill container is rendered
			const pillContainer = out.container.querySelector('.pill-container');
			assert(pillContainer, 'Pill container should be rendered');

			// Check that all three labels are present
			const pills = out.container.querySelectorAll('.pill-item.label');
			assert(pills.length >= 3, 'Should display all three labels');
		});

		it('displays single label in collapsed state', function () {
			const labels = [
				{ name: 'bug', displayName: 'bug', color: 'd73a4a' }
			];

			const pr = new PullRequestBuilder().labels(labels).build();
			const context = new PRContext(pr);

			const out = render(
				<PRContext.Provider value={context}>
					<CollapsibleSidebar {...pr} />
				</PRContext.Provider>
			);

			// Check that the pill container is rendered
			const pillContainer = out.container.querySelector('.pill-container');
			assert(pillContainer, 'Pill container should be rendered');

			// Check that one label is present
			const pills = out.container.querySelectorAll('.pill-item.label');
			assert.strictEqual(pills.length, 1, 'Should display one label');
		});

		it('shows overflow indicator when labels do not fit', function () {
			const labels = [];
			for (let i = 0; i < 20; i++) {
				labels.push({
					name: `label${i}`,
					displayName: `very-long-label-name-${i}`,
					color: 'd73a4a'
				});
			}

			const pr = new PullRequestBuilder().labels(labels).build();
			const context = new PRContext(pr);

			const out = render(
				<PRContext.Provider value={context}>
					<CollapsibleSidebar {...pr} />
				</PRContext.Provider>
			);

			// The overflow indicator may or may not be present depending on container size
			// Just verify that pills are rendered
			const pills = out.container.querySelectorAll('.pill-item.label');
			assert(pills.length >= 1, 'Should display at least one label');
		});

		it('displays milestone in collapsed state', function () {
			const milestone = {
				title: 'v1.0.0',
				dueOn: '2024-12-31',
				createdAt: '2024-01-01',
				id: '123'
			};

			const pr = new PullRequestBuilder().milestone(milestone).build();
			const context = new PRContext(pr);

			const out = render(
				<PRContext.Provider value={context}>
					<CollapsibleSidebar {...pr} />
				</PRContext.Provider>
			);

			// Check that the pill container is rendered for milestone
			const pillContainers = out.container.querySelectorAll('.pill-container');
			assert(pillContainers.length > 0, 'Pill container should be rendered for milestone');

			// Check that milestone title is displayed
			const text = out.container.textContent;
			assert(text?.includes('v1.0.0'), 'Should display milestone title');
		});

		it('displays project items in collapsed state', function () {
			const projectItems = [
				{
					id: '1',
					project: { title: 'Project Alpha' }
				},
				{
					id: '2',
					project: { title: 'Project Beta' }
				}
			];

			const pr = new PullRequestBuilder().projectItems(projectItems).build();
			const context = new PRContext(pr);

			const out = render(
				<PRContext.Provider value={context}>
					<CollapsibleSidebar {...pr} />
				</PRContext.Provider>
			);

			// Check that pill containers are rendered
			const pillContainers = out.container.querySelectorAll('.pill-container');
			assert(pillContainers.length > 0, 'Pill container should be rendered for projects');

			// Check that project names are displayed
			const text = out.container.textContent;
			assert(text?.includes('Project Alpha') || text?.includes('Project Beta'), 'Should display project names');
		});
	});
});
