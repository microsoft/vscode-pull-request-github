/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as React from 'react';
import { cleanup, fireEvent, render, wait, waitForElement } from 'react-testing-library';
import { createSandbox, SinonSandbox } from 'sinon';

import { PullRequestBuilder } from './builder/pullRequest';
import { CheckState, GithubItemStateEnum, PullRequestCheckStatus, PullRequestMergeability } from '../../../src/github/interface';
import { createTestHost } from '../../../src/test/webviews/testHost';
import { Overview as ActivityBarOverview } from '../../activityBarView/overview';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { Overview } from '../overview';

describe('Overview', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	it('renders the PR header with title', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(createTestHost(pr));

		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert(out.container.querySelector('.title'));
		assert(out.container.querySelector('.overview-title'));
	});

	it('opens PR number links on GitHub', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(createTestHost(pr));
		const openOnGitHub = sinon.stub(context, 'openOnGitHub');

		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		const numberLinks = out.container.querySelectorAll('.overview-title a, .sticky-header-number');
		assert.strictEqual(numberLinks.length, 2);
		numberLinks.forEach(link => {
			const contextData = JSON.parse(link.getAttribute('data-vscode-context')!);
			assert.strictEqual(contextData.url, pr.url);
			fireEvent.click(link);
		});
		assert.strictEqual(openOnGitHub.callCount, 2);
	});

	it('reserves details and log action slots for every status check', async function () {
		const cases: Pick<PullRequestCheckStatus, 'state' | 'isCheckRun' | 'databaseId'>[] = [
			{ state: CheckState.Failure, isCheckRun: false, databaseId: undefined },
			{ state: CheckState.Failure, isCheckRun: true, databaseId: 1 },
			{ state: CheckState.Pending, isCheckRun: true, databaseId: 2 },
			{ state: CheckState.Success, isCheckRun: true, databaseId: 3 },
			{ state: CheckState.Neutral, isCheckRun: true, databaseId: 4 },
			{ state: CheckState.Unknown, isCheckRun: true, databaseId: 5 },
			{ state: CheckState.Failure, isCheckRun: true, databaseId: null },
			{ state: CheckState.Failure, isCheckRun: true, databaseId: undefined },
			{ state: CheckState.Failure, isCheckRun: true, databaseId: 0 },
		];
		const statuses: PullRequestCheckStatus[] = cases.map((check, index) => ({
			...check,
			id: `check-${index}`,
			context: `Check ${index}`,
			description: null,
			workflowName: undefined,
			event: undefined,
			url: undefined,
			avatarUrl: undefined,
			targetUrl: index === cases.length - 1 ? null : `https://example.com/checks/${index}`,
			isRequired: index % 2 === 0,
		}));
		const pr = new PullRequestBuilder().status(status => status.state(CheckState.Failure).statuses(statuses)).build();
		const context = new PRContext(createTestHost(pr));
		const viewCheckLogs = sinon.stub(context, 'viewCheckLogs').resolves();
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		const rows = out.container.querySelectorAll('.status-check');
		assert.strictEqual(rows.length, statuses.length);
		for (const status of statuses) {
			const row = [...rows].find(row => row.querySelector('.status-check-detail-text')?.textContent?.trim() === status.context);
			assert(row);
			const actions = row.lastElementChild;
			assert(actions);
			assert.strictEqual(actions.querySelector('.label')?.textContent ?? null, status.isRequired ? 'Required' : null);
			assert.strictEqual(actions.querySelector('a')?.getAttribute('href') ?? null, status.targetUrl);
			const linkPlaceholder = actions.querySelector('.status-check-link-placeholder');
			if (status.targetUrl) {
				assert.strictEqual(linkPlaceholder, null);
			} else {
				assert(linkPlaceholder);
				assert.strictEqual(linkPlaceholder.textContent, 'Details');
				assert.strictEqual(linkPlaceholder.getAttribute('aria-hidden'), 'true');
			}
			const slot = actions.lastElementChild;
			assert(slot);
			if (status.isCheckRun && status.databaseId && status.state === CheckState.Failure) {
				assert.strictEqual(slot.getAttribute('title'), 'View Logs');
				assert.strictEqual(actions.querySelector('.view-check-logs-placeholder'), null);
				fireEvent.click(slot);
				await wait(() => assert(viewCheckLogs.calledOnceWithExactly(status)));
			} else {
				assert(slot.classList.contains('view-check-logs-placeholder'));
				assert.strictEqual(slot.getAttribute('aria-hidden'), 'true');
				assert.strictEqual(actions.querySelector('button'), null);
			}
		}
		assert.strictEqual(viewCheckLogs.callCount, 1);
	});

	it('keeps Details placeholders invisible in both PR overviews using shared styles', function () {
		const status: PullRequestCheckStatus = {
			id: 'missing-details', state: CheckState.Failure, context: 'Check without details',
			description: null, targetUrl: null, workflowName: undefined, event: undefined,
			url: undefined, avatarUrl: undefined, isRequired: false, isCheckRun: false, databaseId: undefined,
		};
		const pr = new PullRequestBuilder().status(checks => checks.state(CheckState.Failure).statuses([status])).build();
		const sharedCss = readFileSync(path.resolve('webviews', 'common', 'common.css'), 'utf8');
		const placeholderRule = /^\.status-check-link-placeholder\s*\{[^}]*\}/m.exec(sharedCss);
		assert(placeholderRule);
		const sharedStyles = document.createElement('style');
		sharedStyles.textContent = placeholderRule[0];
		document.head.appendChild(sharedStyles);
		try {
			for (const Component of [Overview, ActivityBarOverview]) {
				const out = render(
					<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
						<Component {...pr} />
					</PullRequestContext.Provider>,
				);
				const placeholder = out.container.querySelector('.status-check-link-placeholder');
				assert(placeholder);
				assert.strictEqual(placeholder.textContent, 'Details');
				assert.strictEqual(placeholder.getAttribute('aria-hidden'), 'true');
				const style = window.getComputedStyle(placeholder);
				assert.strictEqual(style.visibility, 'hidden');
				assert.notStrictEqual(style.display, 'none');
				out.unmount();
			}
		} finally {
			sharedStyles.remove();
		}
	});

	it('shows the stack position and ordered pull requests in the merge section', async function () {
		const pr = new PullRequestBuilder().number(794).stack({
			position: 2,
			size: 3,
			base: 'main',
			pullRequests: [
				{ position: 1, number: 793, title: 'First Change', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 2, number: 794, title: 'Second Change', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 3, number: 795, title: 'Third Change', head: 'D3', url: 'https://example.com/795', state: GithubItemStateEnum.Open, isDraft: true, mergeable: PullRequestMergeability.Mergeable },
			],
		}).build();
		const context = new PRContext(createTestHost(pr));
		context.setPR(pr);
		const mergeStack = sinon.stub(context, 'mergeStack').resolves({ status: 'merged', state: GithubItemStateEnum.Merged });
		const openOnGitHub = sinon.stub(context, 'openOnGitHub');

		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		const badge = out.container.querySelector('.stack-badge');
		assert.strictEqual(badge?.getAttribute('href'), '#pull-request-stack');
		assert.strictEqual(badge?.getAttribute('title'), 'View pull request stack (2 of 3)');
		assert.strictEqual(badge?.textContent?.trim(), '2/3');
		const section = out.container.querySelector('#pull-request-stack');
		assert(section?.hasAttribute('open'));
		assert(section.textContent?.includes('also merge 1 pull request below it.'));
		assert.deepStrictEqual([...section.querySelectorAll('.stack-entry')].map(entry => entry.querySelector('.stack-entry-details')?.textContent), [
			'Third Change#795 - D3',
			'Second Change#794 - D2',
			'First Change#793 - D1',
		]);
		assert.deepStrictEqual([...section.querySelectorAll('.stack-entry-readiness')].map(entry => [entry.classList[1], entry.getAttribute('aria-label')]), [
			['draft', 'Draft pull request cannot be merged'],
			['ready', 'Ready to merge'],
			['ready', 'Ready to merge'],
		]);
		assert.deepStrictEqual([...section.querySelectorAll('.stack-entry-readiness')].map(entry => entry.getAttribute('title')), [
			'Draft pull request cannot be merged',
			'Ready to merge',
			'Ready to merge',
		]);
		assert.strictEqual(section.querySelector('.stack-entry-state'), null);
		assert.strictEqual(section.querySelectorAll('.stack-entry').length, 3);
		assert.strictEqual(section.querySelectorAll('.stack-entry-readiness svg').length, 3);
		assert.strictEqual(section.querySelector('.stack-base-marker')?.getAttribute('aria-hidden'), 'true');
		assert.strictEqual(section.querySelector('.stack-entries')?.lastElementChild?.className, 'stack-base');
		assert.strictEqual(section.querySelector('.stack-entries')?.getAttribute('aria-label'), 'Pull requests merging down into main');
		assert.strictEqual(section.querySelector('.stack-entry.current')?.getAttribute('aria-current'), 'step');
		assert.strictEqual(section.querySelector('.stack-entry.current a'), null);
		assert.strictEqual(section.querySelector('a[href="https://example.com/793"]')?.textContent, 'First Change');
		assert.strictEqual(section.querySelector('.stack-base')?.textContent, 'main');
		assert.strictEqual(out.container.querySelector('#merge-comment-form'), null);
		assert(out.container.querySelector('.stack-merge .stack-merge-method select'));
		const mergeButton = out.getByText('Merge stack (2 pull requests)');
		fireEvent.change(out.getByLabelText('Select merge method'), { target: { value: 'squash' } });
		fireEvent.click(mergeButton);
		assert(out.getByText('Merge this pull request and 1 open pull request below it?'));
		fireEvent.click(out.getByText('Merge stack (2 pull requests)'));
		await wait(() => assert.strictEqual(context.pr?.state, GithubItemStateEnum.Merged));
		assert(mergeStack.calledOnceWithExactly('squash'));
		assert(openOnGitHub.notCalled);
	});

	it('shows a behind base as waiting and withholds stack merging for it and PRs above it', function () {
		for (const [number, position] of [[794, 2], [795, 3]]) {
			const pr = new PullRequestBuilder().number(number).stack({
				position,
				size: 4,
				base: 'main',
				pullRequests: [
					{ position: 1, number: 793, title: 'First', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
					{ position: 2, number: 794, title: 'Second', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
					{ position: 3, number: 795, title: 'Third', head: 'D3', url: 'https://example.com/795', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
					{ position: 4, number: 798, title: 'Closed', head: 'D4', url: 'https://example.com/798', state: GithubItemStateEnum.Closed, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				],
			}).build();
			const out = render(
				<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
					<Overview {...pr} />
				</PullRequestContext.Provider>,
			);

			assert.deepStrictEqual([...out.container.querySelectorAll('.stack-entry-readiness')].map(readiness => [
				readiness.getAttribute('aria-label'), readiness.classList[1],
			]), [
				['Closed pull request cannot be merged', 'blocked'],
				['A pull request below is behind its base', 'waiting'],
				['Branch is behind its base', 'waiting'],
				['Ready to merge', 'ready'],
			]);
			assert.strictEqual(out.container.querySelector('.stack-merge'), null);
			assert.strictEqual(out.queryByText('Merge Pull Request'), null);
			out.unmount();
		}
	});

	it('shows stack state icons appropriate to each pull request and its position', function () {
		const states = [
			{ state: GithubItemStateEnum.Merged, isDraft: false, mergeable: PullRequestMergeability.Unknown },
			{ state: GithubItemStateEnum.Closed, isDraft: false, mergeable: PullRequestMergeability.Unknown },
			{ state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			{ state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			{ state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			{ state: GithubItemStateEnum.Open, isDraft: true, mergeable: PullRequestMergeability.Mergeable },
			{ state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Conflict },
			{ state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.NotMergeable },
			{ state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
			{ state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Unknown },
		];
		const pr = new PullRequestBuilder().number(4).stack({
			position: 4, size: states.length, base: 'main',
			pullRequests: states.map((state, index) => ({
				...state, position: index + 1, number: index + 1, title: `PR ${index + 1}`,
				head: `D${index + 1}`, url: `https://example.com/${index + 1}`,
			})),
		}).build();
		const out = render(
			<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);
		const iconPath = (svg: string) => {
			const element = document.createElement('div');
			element.innerHTML = svg;
			return element.querySelector('path')?.getAttribute('d');
		};
		const dot = iconPath(require('../../../resources/icons/codicons/circle-filled.svg'));
		const pass = iconPath(require('../../../resources/icons/codicons/pass.svg'));
		assert.deepStrictEqual([...out.container.querySelectorAll('.stack-entry-readiness')].map(entry => [
			entry.getAttribute('aria-label'), entry.classList[1], entry.querySelector('svg path')?.getAttribute('d'),
		]), [
			['Mergeability is being checked', 'waiting', dot],
			['Branch is behind its base', 'waiting', dot],
			['Merge requirements not met', 'waiting', dot],
			['Merge conflicts', 'waiting', dot],
			['Draft pull request cannot be merged', 'draft', iconPath(require('../../../resources/icons/codicons/git-pull-request-draft.svg'))],
			['Ready to merge', 'ready', dot],
			['Ready to merge', 'ready', pass],
			['Ready to merge', 'ready', pass],
			['Closed pull request cannot be merged', 'blocked', iconPath(require('../../../resources/icons/codicons/skip.svg'))],
			['Already merged', 'merged', iconPath(require('../../../resources/icons/codicons/git-merge.svg'))],
		]);
	});

	it('does not show a stack badge or section for an unstacked pull request', function () {
		const pr = new PullRequestBuilder().build();
		const out = render(
			<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert.strictEqual(out.container.querySelector('.stack-badge'), null);
		assert.strictEqual(out.container.querySelector('#pull-request-stack'), null);
		assert(out.getByText('Merge Pull Request'));
	});

	it('offers Unstack all for an eligible stack without showing it to users without write permission', function () {
		const stack = {
			position: 2, size: 2, base: 'main',
			pullRequests: [
				{ position: 1, number: 794, title: 'First', head: 'D1', url: 'https://example.com/794', state: GithubItemStateEnum.Merged, isDraft: false, mergeable: PullRequestMergeability.Unknown },
				{ position: 2, number: 795, title: 'Second', head: 'D2', url: 'https://example.com/795', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		};
		const pr = new PullRequestBuilder().number(795).stack(stack).build();
		const context = new PRContext(createTestHost(pr));
		const unstackAll = sinon.stub(context, 'unstackAll').resolves({ cancelled: false, remainingPullRequests: [794] });
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);
		const button = out.getByText('Unstack all');
		const section = button.closest('#pull-request-stack');
		assert(section);
		assert.strictEqual(section.children[0].tagName, 'SUMMARY');
		assert.strictEqual(button.closest('summary'), null);
		assert.strictEqual(section.children[1], button.parentElement);
		assert.strictEqual(section.children[0].lastElementChild?.className, 'stack-chevron');
		assert.strictEqual(fireEvent.click(button), true);
		assert(unstackAll.calledOnce);
		assert(section.hasAttribute('open'));

		out.rerender(
			<PullRequestContext.Provider value={new PRContext(createTestHost({ ...pr, hasWritePermission: false }))}>
				<Overview {...pr} hasWritePermission={false} />
			</PullRequestContext.Provider>,
		);
		assert.strictEqual(out.queryByText('Unstack all'), null);
		out.rerender(
			<PullRequestContext.Provider value={new PRContext(createTestHost({ ...pr, stack: { ...stack, pullRequests: [stack.pullRequests[0]] } }))}>
				<Overview {...pr} stack={{ ...stack, pullRequests: [stack.pullRequests[0]] }} />
			</PullRequestContext.Provider>,
		);
		assert.strictEqual(out.queryByText('Unstack all'), null);
	});

	it('shows an inline error when unstacking fails', async function () {
		const pr = new PullRequestBuilder().stack({
			position: 1, size: 1, base: 'main',
			pullRequests: [
				{ position: 1, number: 1234, title: 'First', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		}).build();
		const context = new PRContext(createTestHost(pr));
		sinon.stub(context, 'unstackAll').rejects(new Error('Stack is locked'));
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);
		fireEvent.click(out.getByText('Unstack all'));
		const alert = await waitForElement(() => out.container.querySelector('.stack-action-error[role="alert"]'));
		assert.strictEqual(alert?.textContent, 'Unable to unstack pull requests: Stack is locked');
		assert.strictEqual((out.getByText('Unstack all') as HTMLButtonElement).disabled, false);
	});

	it('uses singular wording for single-member stacks, including a retained merged PR', function () {
		for (const state of [GithubItemStateEnum.Open, GithubItemStateEnum.Closed, GithubItemStateEnum.Merged]) {
			const pr = new PullRequestBuilder().number(793).state(state).stack({
				position: 1, size: 1, base: 'main',
				pullRequests: [{
					position: 1, number: 793, title: 'First Change', head: 'D1', url: 'https://example.com/793',
					state, isDraft: false, mergeable: PullRequestMergeability.Unknown,
				}],
			}).build();
			const out = render(
				<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
					<Overview {...pr} />
				</PullRequestContext.Provider>,
			);

			assert.strictEqual(out.container.querySelector('.stack-description')?.textContent, '1 pull request in this stack.');
			assert.strictEqual(out.container.querySelector('.stack-badge')?.textContent?.trim(), '1/1');
			out.unmount();
		}
	});

	it('offers Update stack for an open, conflict-free stack without collapsing the heading', async function () {
		const stack = {
			position: 2, size: 2, base: 'main',
			pullRequests: [
				{ position: 1, number: 1233, title: 'First', head: 'D1', url: 'https://example.com/1233', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
				{ position: 2, number: 1234, title: 'Second', head: 'D2', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.NotMergeable },
			],
		};
		const pr = new PullRequestBuilder().stack(stack).canUpdateStack(true).build();
		const context = new PRContext(createTestHost(pr));
		const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [1233, 1234] });
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);
		const button = out.getByText('Update stack');
		const section = button.closest('#pull-request-stack');
		assert.strictEqual(button.closest('summary'), null);
		assert.strictEqual(section?.children[1], button.parentElement);
		assert.strictEqual(fireEvent.click(button), true);
		assert(updateStack.calledOnce);
		assert(section?.hasAttribute('open'));
	});

	it('does not offer Update stack when the host rejects eligibility or stack details are unavailable', function () {
		const entry = { position: 1, number: 1234, title: 'First', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable };
		const stack = { position: 1, size: 1, base: 'main', pullRequests: [entry] };
		const pr = new PullRequestBuilder().stack(stack).canUpdateStack(true).build();
		const context = new PRContext(createTestHost(pr));
		const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);
		assert(out.getByText('Update stack'));
		for (const change of [
			{ canUpdateStack: false },
			{ stackLoaded: false },
			{ stackLoadError: true },
			{ stack: undefined },
		]) {
			out.rerender(<PullRequestContext.Provider value={context}><Overview {...pr} {...change} /></PullRequestContext.Provider>);
			assert.strictEqual(out.queryByText('Update stack'), null);
		}
	});

	it('shows a recoverable inline error when updating the stack fails', async function () {
		const pr = new PullRequestBuilder().canUpdateStack(true).stack({
			position: 1, size: 1, base: 'main',
			pullRequests: [{ position: 1, number: 1234, title: 'First', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable }],
		}).build();
		const context = new PRContext(createTestHost(pr));
		sinon.stub(context, 'updateStack').rejects(new Error('Branch changed on GitHub'));
		const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);
		fireEvent.click(out.getByText('Update stack'));
		const alert = await waitForElement(() => out.container.querySelector('.stack-action-error[role="alert"]'));
		assert.strictEqual(alert?.textContent, 'Unable to update the stack: Branch changed on GitHub');
		assert.strictEqual((out.getByText('Update stack') as HTMLButtonElement).disabled, false);
	});

	['update', 'unstack'].forEach(firstAction => {
		it(`clears the previous ${firstAction} error when the other stack action starts`, async function () {
			const pr = new PullRequestBuilder().canUpdateStack(true).stack({
				position: 1, size: 1, base: 'main',
				pullRequests: [{
					position: 1, number: 1234, title: 'First', head: 'D1', url: 'https://example.com/1234',
					state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind,
				}],
			}).build();
			const context = new PRContext(createTestHost(pr));
			const failure = new Error('Previous action failed');
			const update = sinon.stub(context, 'updateStack');
			const unstack = sinon.stub(context, 'unstackAll');
			let finish!: () => void;
			const pending = new Promise<void>(resolve => { finish = resolve; });
			if (firstAction === 'update') {
				update.rejects(failure);
				unstack.callsFake(async () => {
					await pending;
					return { cancelled: false, remainingPullRequests: [] };
				});
			} else {
				unstack.rejects(failure);
				update.callsFake(async () => {
					await pending;
					return { updatedPullRequests: [1234] };
				});
			}
			const out = render(
				<PullRequestContext.Provider value={context}>
					<Overview {...pr} />
				</PullRequestContext.Provider>,
			);
			fireEvent.click(out.getByText(firstAction === 'update' ? 'Update stack' : 'Unstack all'));
			const alert = await waitForElement(() => out.container.querySelector('.stack-action-error[role="alert"]'));
			assert(alert?.textContent?.includes('Previous action failed'));

			fireEvent.click(out.getByText(firstAction === 'update' ? 'Unstack all' : 'Update stack'));
			assert.strictEqual(out.container.querySelector('.stack-action-error'), null);
			assert(out.getByText(firstAction === 'update' ? 'Unstacking...' : 'Updating...'));
			finish();
			await waitForElement(() => out.getByText(firstAction === 'update' ? 'Unstack all' : 'Update stack'));
			assert.strictEqual(out.container.querySelector('.stack-action-error'), null);
		});
	});

	it('shows a closed stack without suggesting it can be merged', function () {
		const pr = new PullRequestBuilder().state(GithubItemStateEnum.Closed).stack({
			position: 1,
			size: 2,
			base: 'main',
			pullRequests: [
				{ position: 1, number: 1234, title: 'First Change', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Closed, isDraft: false, mergeable: PullRequestMergeability.Unknown },
				{ position: 2, number: 1235, title: 'Second Change', head: 'D2', url: 'https://example.com/1235', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Unknown },
			],
		}).build();
		const out = render(
			<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert.strictEqual(out.container.querySelector('.stack-description')?.textContent, '2 pull requests in this stack.');
		assert.deepStrictEqual([...out.container.querySelectorAll('.stack-entry-readiness')].map(entry => entry.getAttribute('aria-label')), [
			'Mergeability is being checked',
			'Closed pull request cannot be merged',
		]);
		assert(out.container.querySelector('.stack-entry-readiness.blocked .icon.skip'));
		assert.strictEqual(out.container.querySelector('#status-checks > .stacked-delete-branch-container button')?.textContent?.trim(), 'Delete Branch...');
		assert.strictEqual(out.container.querySelector('.automerge-section'), null);
	});

	it('keeps the original Delete Branch placement outside stacks', function () {
		const pr = new PullRequestBuilder().state(GithubItemStateEnum.Closed).build();
		const out = render(
			<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert.strictEqual(out.container.querySelector('#pull-request-stack'), null);
		assert.strictEqual(out.container.querySelector('#status-checks > .branch-status-container:not(.stacked-delete-branch-container) button')?.textContent?.trim(), 'Delete Branch...');
	});

	it('does not count already merged pull requests in the merge impact', function () {
		const pr = new PullRequestBuilder().number(795).stack({
			position: 3,
			size: 3,
			base: 'main',
			pullRequests: [
				{ position: 1, number: 793, title: 'First Change', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Merged, isDraft: false, mergeable: PullRequestMergeability.Unknown },
				{ position: 2, number: 794, title: 'Second Change', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Unknown },
				{ position: 3, number: 795, title: 'Third Change', head: 'D3', url: 'https://example.com/795', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
			],
		}).build();
		const out = render(
			<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert(out.container.querySelector('#pull-request-stack')?.textContent?.includes('also merge 1 pull request below it.'));
		assert.deepStrictEqual([...out.container.querySelectorAll('.stack-entry-readiness')].map(entry => entry.getAttribute('aria-label')), [
			'Branch is behind its base',
			'Mergeability is being checked',
			'Already merged',
		]);
		assert.strictEqual(out.container.querySelector('.stack-merge'), null);
	});

	it('never offers an update with a merge commit for stacked PRs', function () {
		const stack = {
			position: 2, size: 2, base: 'main',
			pullRequests: [
				{ position: 1, number: 793, title: 'First', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 2, number: 794, title: 'Second', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
			],
		};
		for (const mergeable of [PullRequestMergeability.Behind, PullRequestMergeability.Mergeable, PullRequestMergeability.NotMergeable]) {
			const pr = new PullRequestBuilder().number(794).canUpdateBranch(true).mergeable(mergeable).stack(stack).build();
			const out = render(<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}><Overview {...pr} /></PullRequestContext.Provider>);
			assert(out.container.querySelector('#pull-request-stack'));
			if (mergeable === PullRequestMergeability.Behind) {
				assert(out.getByText('This branch is out-of-date with the base branch.'));
			}
			assert.strictEqual(out.queryByText(/Update with merge commit/i), null);
			out.unmount();
		}
	});

	it('offers Update stack only in the stack header when a PR is behind', function () {
		const stack = {
			position: 2, size: 2, base: 'main',
			pullRequests: [
				{ position: 1, number: 793, title: 'First', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 2, number: 794, title: 'Second', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
			],
		};
		const pr = new PullRequestBuilder().number(794).canUpdateBranch(true).canUpdateStack(true)
			.mergeable(PullRequestMergeability.Behind).stack(stack).build();
		const context = new PRContext(createTestHost(pr));
		const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [794] });
		const updateBranch = sinon.stub(context, 'updateBranch');
		const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

		assert(out.getByText('This branch is out-of-date with the base branch.'));
		const button = out.getByText('Update stack');
		assert.strictEqual(button.closest('summary'), null);
		assert(button.closest('.stack-section'));
		assert.strictEqual(out.queryAllByText('Update stack').length, 1);
		assert.strictEqual(out.queryByText(/Update with merge commit/i), null);
		fireEvent.click(button);
		assert(updateStack.calledOnce);
		assert(updateBranch.notCalled);
	});

	it('offers Update stack for an open PR when only the top of the stack is closed', function () {
		const stack = {
			position: 2, size: 4, base: 'master',
			pullRequests: [
				{ position: 1, number: 793, title: 'First', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 2, number: 794, title: 'Second', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
				{ position: 3, number: 795, title: 'Third', head: 'D3', url: 'https://example.com/795', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 4, number: 798, title: 'Closed', head: 'D4', url: 'https://example.com/798', state: GithubItemStateEnum.Closed, isDraft: true, mergeable: PullRequestMergeability.Unknown },
			],
		};
		const pr = new PullRequestBuilder().number(794).canUpdateBranch(true).canUpdateStack(true)
			.mergeable(PullRequestMergeability.Behind).stack(stack).build();
		const context = new PRContext(createTestHost(pr));
		const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [794, 795] });
		const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

		assert.strictEqual(out.getByText('Update stack').closest('summary'), null);
		assert.strictEqual(out.queryAllByText('Update stack').length, 1);
		assert.strictEqual(out.queryByText(/Update with merge commit/i), null);
		fireEvent.click(out.getByText('Update stack'));
		assert(updateStack.calledOnce);
	});

	it('does not offer Update stack across a closed PR in the middle of a chain', function () {
		const pr = new PullRequestBuilder().number(793).canUpdateStack(false).stack({
			position: 1, size: 3, base: 'master',
			pullRequests: [
				{ position: 1, number: 793, title: 'First', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 2, number: 794, title: 'Closed', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Closed, isDraft: false, mergeable: PullRequestMergeability.Unknown },
				{ position: 3, number: 795, title: 'Third', head: 'D3', url: 'https://example.com/795', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		}).build();
		const out = render(<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}><Overview {...pr} /></PullRequestContext.Provider>);
		assert.strictEqual(out.queryByText('Update stack'), null);
	});

	it('keeps Update stack in the header for other updateable stacked branches', function () {
		const pr = new PullRequestBuilder().canUpdateBranch(true).canUpdateStack(true)
			.stack({
				position: 1, size: 1, base: 'main',
				pullRequests: [{ position: 1, number: 1234, title: 'First', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.NotMergeable }],
			}).build();
		const context = new PRContext(createTestHost(pr));
		const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [1234] });
		const updateBranch = sinon.stub(context, 'updateBranch');
		const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

		assert.strictEqual(out.getByText('Update stack').closest('summary'), null);
		assert.strictEqual(out.queryAllByText('Update stack').length, 1);
		assert.strictEqual(out.queryByText(/Update with merge commit/i), null);
		fireEvent.click(out.getByText('Update stack'));
		assert(updateStack.calledOnce);
		assert(updateBranch.notCalled);
	});

	it('retains merge-commit updates for unstacked PRs and conflict resolution for stacked PRs', function () {
		for (const mergeable of [PullRequestMergeability.Behind, PullRequestMergeability.Mergeable]) {
			const pr = new PullRequestBuilder().canUpdateBranch(true).mergeable(mergeable).build();
			const out = render(<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}><Overview {...pr} /></PullRequestContext.Provider>);
			assert(out.getByText(/Update with merge commit/i));
			out.unmount();
		}
		const pr = new PullRequestBuilder().canUpdateBranch(true).mergeable(PullRequestMergeability.Conflict).stack({
			position: 1, size: 1, base: 'main',
			pullRequests: [{ position: 1, number: 1234, title: 'First', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Conflict }],
		}).build();
		const out = render(<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}><Overview {...pr} /></PullRequestContext.Provider>);
		assert(out.getByText('Resolve conflicts'));
		assert.strictEqual(out.queryByText(/Update with merge commit/i), null);
	});

	it('does not offer merge-commit updates before stack membership is known or when loading fails', function () {
		for (const change of [{ stackLoaded: false }, { stackLoadError: true }]) {
			const pr = { ...new PullRequestBuilder().canUpdateBranch(true).mergeable(PullRequestMergeability.Behind).build(), ...change };
			const out = render(<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}><Overview {...pr} /></PullRequestContext.Provider>);
			assert.strictEqual(out.queryByText(/Update with merge commit/i), null);
			out.unmount();
		}
	});

	it('hides stack merge when the current or an open downstack PR is not mergeable', function () {
		const readyStack = {
			position: 2,
			size: 3,
			base: 'main',
			pullRequests: [
				{ position: 1, number: 793, title: 'First Change', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 2, number: 794, title: 'Second Change', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 3, number: 795, title: 'Third Change', head: 'D3', url: 'https://example.com/795', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Conflict },
			],
		};
		const blocked = [
			new PullRequestBuilder().number(794).mergeable(PullRequestMergeability.Conflict).stack(readyStack).build(),
			...[
				{ mergeable: PullRequestMergeability.Conflict },
				{ mergeable: PullRequestMergeability.NotMergeable },
				{ mergeable: PullRequestMergeability.Behind },
				{ mergeable: PullRequestMergeability.Unknown },
				{ isDraft: true },
				{ state: GithubItemStateEnum.Closed },
			].map(change => new PullRequestBuilder().number(794).stack({
				...readyStack,
				pullRequests: [{ ...readyStack.pullRequests[0], ...change }, ...readyStack.pullRequests.slice(1)],
			}).build()),
		];
		for (const pr of blocked) {
			const out = render(
				<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
					<Overview {...pr} />
				</PullRequestContext.Provider>,
			);
			assert(out.container.querySelector('#pull-request-stack'));
			assert.strictEqual(out.container.querySelector('.stack-merge'), null);
			out.unmount();
		}
	});

	it('ignores PRs above and already merged PRs below the current stack merge', function () {
		const stack = {
			position: 2,
			size: 3,
			base: 'main',
			pullRequests: [
				{ position: 1, number: 793, title: 'First Change', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Merged, isDraft: false, mergeable: PullRequestMergeability.Unknown },
				{ position: 2, number: 794, title: 'Second Change', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 3, number: 795, title: 'Third Change', head: 'D3', url: 'https://example.com/795', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Conflict },
			],
		};
		const pr = new PullRequestBuilder().number(794).stack(stack).build();
		const out = render(
			<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);
		assert(out.getByText('Merge stack (1 pull request)'));
	});

	it('does not offer to merge a stack without write permission', function () {
		const pr = new PullRequestBuilder().hasWritePermission(false).stack({
			position: 1,
			size: 1,
			base: 'main',
			pullRequests: [
				{ position: 1, number: 1234, title: 'First Change', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		}).build();
		const out = render(
			<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert(out.container.querySelector('#pull-request-stack'));
		assert.strictEqual(out.container.querySelector('.automerge-section'), null);
		assert.strictEqual(out.container.querySelector('#merge-comment-form'), null);
	});

	it('offers to queue a stack without showing a direct merge method', function () {
		const pr = new PullRequestBuilder().mergeQueueMethod('squash').stack({
			position: 1,
			size: 1,
			base: 'main',
			pullRequests: [
				{ position: 1, number: 1234, title: 'First Change', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		}).build();
		const out = render(
			<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert(out.getByText('Add stack to merge queue'));
		assert.strictEqual(out.container.querySelector('.automerge-section select'), null);
	});

	it('keeps the PR open when an asynchronous stack merge is pending', async function () {
		const pr = new PullRequestBuilder().stack({
			position: 1,
			size: 1,
			base: 'main',
			pullRequests: [
				{ position: 1, number: 1234, title: 'First Change', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		}).build();
		const context = new PRContext(createTestHost(pr));
		context.setPR(pr);
		const mergeStack = sinon.stub(context, 'mergeStack').resolves({ status: 'pending' });
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		fireEvent.click(out.getByText('Merge stack (1 pull request)'));
		fireEvent.click(out.getByText('Merge stack (1 pull request)'));
		await wait(() => assert.strictEqual(context.pr?.stackMergeStatus, 'pending'));

		assert(mergeStack.calledOnceWithExactly('merge'));
		assert.strictEqual(context.pr?.state, GithubItemStateEnum.Open);
		assert.strictEqual(context.pr?.revertable, false);
		assert.strictEqual(out.container.querySelector('[role="alert"]'), null);
	});

	it('shows stack merge failures without marking the pull request merged', async function () {
		const pr = new PullRequestBuilder().stack({
			position: 1,
			size: 1,
			base: 'main',
			pullRequests: [
				{ position: 1, number: 1234, title: 'First Change', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		}).build();
		const context = new PRContext(createTestHost(pr));
		const mergeStack = sinon.stub(context, 'mergeStack').rejects(new Error('Required checks failed'));
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		fireEvent.click(out.getByText('Merge stack (1 pull request)'));
		fireEvent.click(out.getByText('Merge stack (1 pull request)'));

		assert(mergeStack.calledOnce);
		assert.strictEqual((await waitForElement(() => out.container.querySelector('[role="alert"]')))?.textContent, 'Unable to merge stack: Required checks failed');
		assert.strictEqual(context.pr?.state, GithubItemStateEnum.Open);
		assert.strictEqual(out.getByText('Merge stack (1 pull request)').hasAttribute('disabled'), false);
	});

	it('does not offer a legacy merge while stack membership is loading or failed', function () {
		const pr = new PullRequestBuilder().stackLoaded(false).build();
		const out = render(
			<PullRequestContext.Provider value={new PRContext(createTestHost(pr))}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);
		assert(out.getByText('Checking pull request stack membership...'));
		assert.strictEqual(out.container.querySelector('.automerge-section'), null);

		const failed = { ...pr, stackLoaded: true, stackLoadError: true };
		out.rerender(
			<PullRequestContext.Provider value={new PRContext(createTestHost(failed))}>
				<Overview {...failed} />
			</PullRequestContext.Provider>,
		);
		assert(out.getByText('Unable to load pull request stack details. Refresh to retry merging.'));
		assert.strictEqual(out.container.querySelector('.automerge-section'), null);
	});

	it('shows view changes in both headers', function () {
		const pr = new PullRequestBuilder().isAgentSessionsWorkspace(true).build();
		const context = new PRContext(createTestHost(pr));
		const viewChanges = sinon.stub(context, 'viewChanges');

		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		const viewChangesButtons = out.container.querySelectorAll('[aria-label="View Pull Request Changes"]');
		assert.strictEqual(viewChangesButtons.length, 2);
		viewChangesButtons.forEach(button => {
			assert.strictEqual(button.parentElement?.lastElementChild, button);
			fireEvent.click(button);
		});
		assert.strictEqual(viewChanges.callCount, 2);
	});

	it('does not show view changes outside the agents window', function () {
		const pr = new PullRequestBuilder().isAgentSessionsWorkspace(false).build();
		const context = new PRContext(createTestHost(pr));

		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert.strictEqual(out.container.querySelector('[aria-label="View Pull Request Changes"]'), null);
	});

	it('applies sticky class when scrolled', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(createTestHost(pr));

		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		const titleElement = out.container.querySelector('.title');
		assert(titleElement);

		// Initial state should not have sticky class
		assert(!titleElement.classList.contains('sticky'));

		// Sticky header should exist but not be visible initially
		const stickyHeader = out.container.querySelector('.sticky-header');
		assert(stickyHeader);
		assert(!stickyHeader.classList.contains('visible'));
	});

	it('applies deferred pull request updates', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(createTestHost(pr));
		context.setPR(pr);

		context.handleMessage({
			command: 'pr.update',
			pullrequest: {
				events: [],
				currentUserReviewState: 'APPROVED',
			},
		});

		assert.deepStrictEqual(context.pr?.events, []);
		assert.strictEqual(context.pr?.currentUserReviewState, 'APPROVED');
		assert.strictEqual(context.pr?.title, pr.title);
	});
});
