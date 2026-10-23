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

import { AccountBuilder } from './builder/account';
import { PullRequestBuilder } from './builder/pullRequest';
import { COPILOT_REVIEWER, COPILOT_REVIEWER_ID } from '../../../src/common/copilot';
import { AccountType, CheckState, GithubItemStateEnum, PullRequestCheckStatus, PullRequestMergeability } from '../../../src/github/interface';
import { PullRequest } from '../../../src/github/views';
import { Root as ActivityBarRoot } from '../../activityBarView/app';
import { Overview as ActivityBarOverview } from '../../activityBarView/overview';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { STACKS_DOCUMENTATION_URL } from '../../components/stackRecommendation';
import { Root as EditorRoot } from '../app';
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
		const context = new PRContext(pr);

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
		const context = new PRContext(pr);
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

	it('offers re-requesting a review from Copilot but not from other bots', function () {
		const copilot = new AccountBuilder().login(COPILOT_REVIEWER).id(COPILOT_REVIEWER_ID).accountType(AccountType.Bot).build();
		const otherBot = new AccountBuilder().login('other-bot').id('BOT_other').accountType(AccountType.Bot).build();
		const pr = new PullRequestBuilder().reviewers([
			{ reviewer: copilot, state: 'COMMENTED' },
			{ reviewer: otherBot, state: 'COMMENTED' },
		]).build();
		const context = new PRContext(pr);
		const reRequestReview = sinon.stub(context, 'reRequestReview').resolves();
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		const reRequestButtons = out.container.querySelectorAll('button[title="Re-request review"]');
		assert.strictEqual(reRequestButtons.length, 1);
		fireEvent.click(reRequestButtons[0]);
		assert(reRequestReview.calledOnceWithExactly(COPILOT_REVIEWER_ID));
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
		const context = new PRContext(pr);
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
					<PullRequestContext.Provider value={new PRContext(pr)}>
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

	it('shows and hides the status checks with a caret', function () {
		const status: PullRequestCheckStatus = {
			id: 'build', state: CheckState.Success, context: 'Build',
			description: null, targetUrl: null, workflowName: undefined, event: undefined,
			url: undefined, avatarUrl: undefined, isRequired: false, isCheckRun: false, databaseId: undefined,
		};
		const pr = new PullRequestBuilder().status(checks => checks.state(CheckState.Success).statuses([status])).build();
		const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);

		const caret = out.getByLabelText('Show status checks');
		assert.strictEqual(caret.getAttribute('aria-expanded'), 'false');
		assert(caret.querySelector('svg'));
		assert.strictEqual(out.queryByText('Show'), null);
		assert.strictEqual(out.container.querySelector('.status-check'), null);

		fireEvent.click(caret);

		assert.strictEqual(caret.getAttribute('aria-expanded'), 'true');
		assert.strictEqual(caret.getAttribute('aria-label'), 'Hide status checks');
		assert.strictEqual(out.queryByText('Hide'), null);
		assert(out.container.querySelector('.status-check'));
	});

	it('opens a PR number link exactly once', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);
		const openOnGitHub = sinon.stub(context, 'openOnGitHub');

		// Stands in for the webview host, which opens any anchor with an href that a click
		// reaches, and does not check defaultPrevented.
		const hostOpenedLinks: string[] = [];
		const hostLinkHandler = (event: Event) => {
			const anchor = (event.target as HTMLElement).closest('a[href]');
			if (anchor) {
				hostOpenedLinks.push(anchor.getAttribute('href')!);
			}
		};
		window.addEventListener('click', hostLinkHandler);

		try {
			const out = render(
				<PullRequestContext.Provider value={context}>
					<Overview {...pr} />
				</PullRequestContext.Provider>,
			);

			const numberLinks = out.container.querySelectorAll('.overview-title a, .sticky-header-number');
			assert.strictEqual(numberLinks.length, 2);
			numberLinks.forEach(link => {
				openOnGitHub.resetHistory();
				hostOpenedLinks.length = 0;

				fireEvent.click(link);

				assert.strictEqual(openOnGitHub.callCount, 1);
				assert.deepStrictEqual(hostOpenedLinks, []);
			});
		} finally {
			window.removeEventListener('click', hostLinkHandler);
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
		const context = new PRContext(pr);
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
		assert(section);
		assert.strictEqual(section.querySelector('.stack-chevron')?.getAttribute('aria-expanded'), 'true');
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

	it('shows a behind PR without conflicts as ready and withholds stack merging for it and PRs above it', function () {
		const iconPath = (svg: string) => {
			const element = document.createElement('div');
			element.innerHTML = svg;
			return element.querySelector('path')?.getAttribute('d');
		};
		const check = iconPath(require('../../../resources/icons/codicons/pass.svg'));
		const dot = iconPath(require('../../../resources/icons/codicons/circle-filled.svg'));
		for (const [number, position, thirdIcon] of [[794, 2, dot], [795, 3, check]] as const) {
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
				<PullRequestContext.Provider value={new PRContext(pr)}>
					<Overview {...pr} />
				</PullRequestContext.Provider>,
			);

			assert.deepStrictEqual([...out.container.querySelectorAll('.stack-entry-readiness')].map(readiness => [
				readiness.getAttribute('aria-label'), readiness.classList[1], readiness.querySelector('svg path')?.getAttribute('d'),
			]), [
				['Closed pull request cannot be merged', 'blocked', iconPath(require('../../../resources/icons/codicons/skip.svg'))],
				['No conflicts, but a pull request below is behind its base', 'ready', thirdIcon],
				['No conflicts, but the branch is behind its base', 'ready', check],
				['Ready to merge', 'ready', check],
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
			<PullRequestContext.Provider value={new PRContext(pr)}>
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
			['No conflicts, but the branch is behind its base', 'ready', dot],
			['Merge requirements not met', 'waiting', dot],
			['Merge conflicts', 'conflict', iconPath(require('../../../resources/icons/codicons/close.svg'))],
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
			<PullRequestContext.Provider value={new PRContext(pr)}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert.strictEqual(out.container.querySelector('.stack-badge'), null);
		assert.strictEqual(out.container.querySelector('#pull-request-stack'), null);
		assert(out.getByText('Merge Pull Request'));
	});

	for (const [view, Root, Component] of [
		['sidebar', ActivityBarRoot, ActivityBarOverview],
		['editor', EditorRoot, Overview],
	] as const) {
		for (const mergeQueueMethod of [undefined, 'squash'] as const) {
			it(`clears the ${view} stack after a serialized unstack update (${mergeQueueMethod ?? 'no queue'})`, async function () {
				const pr = new PullRequestBuilder().number(1001).mergeQueueMethod(mergeQueueMethod).stack({
					position: 3, size: 3, base: 'main',
					pullRequests: [999, 1000, 1001].map((number, index) => ({
						position: index + 1, number, title: `Change ${index + 1}`, head: `D${index + 1}`, url: '',
						state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable,
					})),
				}).build();
				const context = new PRContext(pr);
				context.setPR(pr);
				const out = render(
					<PullRequestContext.Provider value={context}>
						<Root>{current => <Component {...current} />}</Root>
					</PullRequestContext.Provider>,
				);
				const stackAction = mergeQueueMethod ? 'Add stack to merge queue' : 'Merge stack (3 pull requests)';
				assert(out.getByText(stackAction));
				if (view === 'editor') {
					assert(out.container.querySelector('#pull-request-stack'));
					assert(out.container.querySelector('.stack-badge'));
				}

				context.handleMessage(JSON.parse(JSON.stringify({
					command: 'pr.update',
					pullrequest: { stack: null, stackLoaded: true, stackLoadError: false, mergeQueueMethod: null },
				})));

				await wait(() => {
					assert.strictEqual(out.queryByText(stackAction), null);
					assert.strictEqual(out.container.querySelector('#pull-request-stack'), null);
					assert.strictEqual(out.container.querySelector('.stack-badge'), null);
					assert.strictEqual(context.pr?.stack, null);
					assert.strictEqual(context.pr?.mergeQueueMethod, null);
					if (view === 'sidebar') {
						assert.strictEqual(out.container.querySelector('.select-control input[type="submit"]')?.getAttribute('value'), 'Create Merge Commit');
						assert(out.getByText('Comment'));
						assert(out.getByText("Checkout 'main'"));
					} else {
						assert(out.getByText('Merge Pull Request'));
					}
				}, { timeout: 500 });
			});
		}
	}

	it('offers Unstack all for an eligible stack without showing it to users without write permission', function () {
		const stack = {
			position: 2, size: 2, base: 'main',
			pullRequests: [
				{ position: 1, number: 794, title: 'First', head: 'D1', url: 'https://example.com/794', state: GithubItemStateEnum.Merged, isDraft: false, mergeable: PullRequestMergeability.Unknown },
				{ position: 2, number: 795, title: 'Second', head: 'D2', url: 'https://example.com/795', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		};
		const pr = new PullRequestBuilder().number(795).stack(stack).build();
		const context = new PRContext(pr);
		const unstackAll = sinon.stub(context, 'unstackAll').resolves({ cancelled: false, remainingPullRequests: [794] });
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);
		const button = out.getByText('Unstack all');
		const section = button.closest('#pull-request-stack');
		assert(section);
		const header = section.querySelector('.stack-header');
		assert(header);
		assert.strictEqual(button.closest('.stack-actions')?.parentElement, header, 'the button is laid out in the header');
		assert.strictEqual(header.lastElementChild?.getAttribute('aria-controls'), 'pull-request-stack-content', 'the chevron comes last');
		assert.strictEqual(fireEvent.click(button), true);
		assert(unstackAll.calledOnce);
		assert.strictEqual(header.lastElementChild?.getAttribute('aria-expanded'), 'true', 'clicking the button does not collapse the stack');

		out.rerender(
			<PullRequestContext.Provider value={new PRContext({ ...pr, hasWritePermission: false })}>
				<Overview {...pr} hasWritePermission={false} />
			</PullRequestContext.Provider>,
		);
		assert.strictEqual(out.queryByText('Unstack all'), null);
		out.rerender(
			<PullRequestContext.Provider value={new PRContext({ ...pr, stack: { ...stack, pullRequests: [stack.pullRequests[0]] } })}>
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
		const context = new PRContext(pr);
		sinon.stub(context, 'unstackAll').rejects(new Error('Stack is locked'));
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);
		fireEvent.click(out.getByText('Unstack all'));
		const alert = await waitForElement(() => out.container.querySelector('.stack-action-error[role="alert"]'));
		assert.strictEqual(alert?.textContent, 'Unable to unstack pull requests: Stack is locked');
		assert(alert.closest('.stack-section'), 'the error is shown with the stack');
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
				<PullRequestContext.Provider value={new PRContext(pr)}>
					<Overview {...pr} />
				</PullRequestContext.Provider>,
			);

			assert.strictEqual(out.container.querySelector('.stack-description')?.textContent, '1 pull request in this stack.');
			assert.strictEqual(out.container.querySelector('.stack-badge')?.textContent?.trim(), '1/1');
			out.unmount();
		}
	});

	it('offers Update stack with the branch status, below the stack, without collapsing the stack', async function () {
		const stack = {
			position: 2, size: 2, base: 'main',
			pullRequests: [
				{ position: 1, number: 1233, title: 'First', head: 'D1', url: 'https://example.com/1233', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
				{ position: 2, number: 1234, title: 'Second', head: 'D2', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.NotMergeable },
			],
		};
		const pr = new PullRequestBuilder().stack(stack).canUpdateStack(true).build();
		const context = new PRContext(pr);
		const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [1233, 1234] });
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);
		const button = out.getByText('Update stack');
		const section = out.container.querySelector('#pull-request-stack');
		assert(section);
		assert.strictEqual(button.closest('.stack-section'), null);
		assert(section.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING, 'the button is below the stack');
		assert(button.closest('.status-item')?.textContent?.includes('This branch has no conflicts with the base branch.'));
		assert.deepStrictEqual([...section.querySelectorAll('.stack-actions button')].map(action => action.textContent), ['Unstack all']);
		assert.strictEqual(fireEvent.click(button), true);
		assert(updateStack.calledOnce);
		assert.strictEqual(section.querySelector('.stack-chevron')?.getAttribute('aria-expanded'), 'true');
	});

	it('collapses and expands the stack from the chevron or the header', function () {
		const pr = new PullRequestBuilder().number(794).stack({
			position: 1, size: 1, base: 'main',
			pullRequests: [{ position: 1, number: 794, title: 'First', head: 'D1', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable }],
		}).build();
		const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
		const chevron = out.getByLabelText('Collapse pull request stack');
		const content = out.container.querySelector('#pull-request-stack-content');
		assert(content);
		assert.strictEqual(chevron.getAttribute('aria-controls'), content.id);
		assert.strictEqual(content.hasAttribute('hidden'), false);
		assert(out.getByText('Unstack all'));

		fireEvent.click(chevron);

		assert.strictEqual(chevron.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(chevron.getAttribute('aria-label'), 'Expand pull request stack');
		assert(content.hasAttribute('hidden'));
		assert.strictEqual(out.queryByText('Unstack all'), null, 'the stack is only unstacked while it is shown');

		fireEvent.click(out.getByText('Pull request stack'));

		assert.strictEqual(chevron.getAttribute('aria-expanded'), 'true');
		assert.strictEqual(content.hasAttribute('hidden'), false);
	});

	it('does not offer Update stack when the host rejects eligibility or stack details are unavailable', function () {
		const entry = { position: 1, number: 1234, title: 'First', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable };
		const stack = { position: 1, size: 1, base: 'main', pullRequests: [entry] };
		const pr = new PullRequestBuilder().stack(stack).canUpdateStack(true).build();
		const context = new PRContext(pr);
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
		const context = new PRContext(pr);
		sinon.stub(context, 'updateStack').rejects(new Error('Branch changed on GitHub'));
		const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);
		fireEvent.click(out.getByText('Update stack'));
		const alert = await waitForElement(() => out.container.querySelector('.stack-action-error[role="alert"]'));
		assert.strictEqual(alert?.textContent, 'Unable to update the stack: Branch changed on GitHub');
		assert.strictEqual(alert.closest('.stack-section'), null, 'the error is shown with the button');
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
			const context = new PRContext(pr);
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
			<PullRequestContext.Provider value={new PRContext(pr)}>
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
			<PullRequestContext.Provider value={new PRContext(pr)}>
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
			<PullRequestContext.Provider value={new PRContext(pr)}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert(out.container.querySelector('#pull-request-stack')?.textContent?.includes('also merge 1 pull request below it.'));
		assert.deepStrictEqual([...out.container.querySelectorAll('.stack-entry-readiness')].map(entry => entry.getAttribute('aria-label')), [
			'No conflicts, but the branch is behind its base',
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
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
			assert(out.container.querySelector('#pull-request-stack'));
			if (mergeable === PullRequestMergeability.Behind) {
				assert(out.getByText('This branch is out-of-date with the base branch.'));
			}
			assert.strictEqual(out.queryByText(/Update with merge commit/i), null);
			out.unmount();
		}
	});

	it('offers Update stack with the out-of-date branch status when a PR is behind', function () {
		const stack = {
			position: 2, size: 2, base: 'main',
			pullRequests: [
				{ position: 1, number: 793, title: 'First', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 2, number: 794, title: 'Second', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
			],
		};
		const pr = new PullRequestBuilder().number(794).canUpdateBranch(true).canUpdateStack(true)
			.mergeable(PullRequestMergeability.Behind).stack(stack).build();
		const context = new PRContext(pr);
		const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [794] });
		const updateBranch = sinon.stub(context, 'updateBranch');
		const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

		assert(out.getByText('This branch is out-of-date with the base branch.'));
		const button = out.getByText('Update stack');
		assert.strictEqual(button.closest('.stack-section'), null);
		assert(button.closest('.status-item')?.textContent?.includes('This branch is out-of-date with the base branch.'));
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
		const context = new PRContext(pr);
		const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [794, 795] });
		const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

		assert.strictEqual(out.getByText('Update stack').closest('.stack-section'), null);
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
		const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
		assert.strictEqual(out.queryByText('Update stack'), null);
	});

	it('offers Update stack next to the no-conflicts status when the stack is behind but GitHub reports no conflicts', function () {
		const pr = new PullRequestBuilder().number(794).canUpdateStack(true).mergeable(PullRequestMergeability.Mergeable).stack({
			position: 2, size: 2, base: 'main',
			pullRequests: [
				{ position: 1, number: 793, title: 'First', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 2, number: 794, title: 'Second', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
			],
		}).build();
		const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);

		assert(out.getByText('Update stack').closest('.status-item')?.textContent?.includes('This branch has no conflicts with the base branch.'));
		assert.strictEqual(out.queryAllByText('Update stack').length, 1);
		out.unmount();

		const sidebar = render(<PullRequestContext.Provider value={new PRContext(pr)}><ActivityBarOverview {...pr} /></PullRequestContext.Provider>);
		assert.strictEqual(sidebar.queryByText('Update stack'), null, 'the sidebar only updates the stack to resolve conflicts');
	});

	it('offers Update stack for other updateable stacked branches', function () {
		const pr = new PullRequestBuilder().canUpdateBranch(true).canUpdateStack(true)
			.stack({
				position: 1, size: 1, base: 'main',
				pullRequests: [{ position: 1, number: 1234, title: 'First', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.NotMergeable }],
			}).build();
		const context = new PRContext(pr);
		const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [1234] });
		const updateBranch = sinon.stub(context, 'updateBranch');
		const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

		assert.strictEqual(out.getByText('Update stack').closest('.stack-section'), null);
		assert.strictEqual(out.queryAllByText('Update stack').length, 1);
		assert.strictEqual(out.queryByText(/Update with merge commit/i), null);
		fireEvent.click(out.getByText('Update stack'));
		assert(updateStack.calledOnce);
		assert(updateBranch.notCalled);
	});

	it('retains merge-commit updates and conflict resolution for unstacked PRs', function () {
		for (const mergeable of [PullRequestMergeability.Behind, PullRequestMergeability.Mergeable]) {
			const pr = new PullRequestBuilder().canUpdateBranch(true).mergeable(mergeable).build();
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
			assert(out.getByText(/Update with merge commit/i));
			out.unmount();
		}
		const pr = new PullRequestBuilder().canUpdateBranch(true).mergeable(PullRequestMergeability.Conflict).build();
		const context = new PRContext(pr);
		const updateBranch = sinon.stub(context, 'updateBranch').resolves();
		const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);
		fireEvent.click(out.getByText('Resolve conflicts'));
		assert(updateBranch.calledOnce);
	});

	describe('stacked PR conflicts', function () {
		const conflictingStack = {
			position: 1, size: 1, base: 'main',
			pullRequests: [{ position: 1, number: 1234, title: 'First', head: 'D1', url: 'https://example.com/1234', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Conflict }],
		};
		const stackWithConflictBelow = {
			position: 2, size: 2, base: 'main',
			pullRequests: [
				conflictingStack.pullRequests[0],
				{ position: 2, number: 1235, title: 'Second', head: 'D2', url: 'https://example.com/1235', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		};

		it('resolves conflicts from the branch status instead of creating a merge commit', async function () {
			const pr = new PullRequestBuilder().canUpdateBranch(true).canUpdateStack(true)
				.mergeable(PullRequestMergeability.Conflict).stack(conflictingStack).build();
			const context = new PRContext(pr);
			let finishUpdate!: () => void;
			const updateStack = sinon.stub(context, 'updateStack').returns(new Promise(resolve => {
				finishUpdate = () => resolve({ updatedPullRequests: [1234] });
			}));
			const updateBranch = sinon.stub(context, 'updateBranch');
			const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

			assert(out.getByText('This branch has conflicts that must be resolved.'));
			assert.strictEqual(out.queryAllByText('Resolve conflicts').length, 1, 'the stack has a single update action');
			assert(out.getByText('Resolve conflicts').closest('.status-item')?.textContent?.includes('This branch has conflicts that must be resolved.'));
			assert.strictEqual(out.queryByText('Update stack'), null);
			fireEvent.click(out.getByText('Resolve conflicts'));

			assert(updateStack.calledOnce);
			assert(updateBranch.notCalled);
			await wait(() => assert.strictEqual(out.getByText('Updating...').closest('button')!.disabled, true));
			assert.strictEqual(out.getByText('Unstack all').closest('button')!.disabled, true, 'stack actions share progress');
			finishUpdate();
			await wait(() => assert.strictEqual(out.getByText('Resolve conflicts').closest('button')!.disabled, false));
		});

		it('offers to resolve conflicts when another pull request in the stack has conflicts', function () {
			const pr = new PullRequestBuilder().number(1235).canUpdateStack(true).mergeable(PullRequestMergeability.Mergeable).stack(stackWithConflictBelow).build();
			const context = new PRContext(pr);
			const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [1234, 1235] });
			const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

			assert(out.getByText('A pull request in this stack has conflicts that must be resolved.'));
			assert.strictEqual(out.queryByText('This branch has no conflicts with the base branch.'), null);
			assert.strictEqual(out.queryAllByText('Resolve conflicts').length, 1, 'the stack has a single update action');
			assert(out.getByText('Resolve conflicts').closest('.status-item')?.textContent?.includes('A pull request in this stack has conflicts that must be resolved.'));
			assert.strictEqual(out.queryByText('Update stack'), null);
			fireEvent.click(out.getByText('Resolve conflicts'));
			assert(updateStack.calledOnce);
		});

		it('resolves conflicts in another pull request in the stack from the sidebar', function () {
			const pr = new PullRequestBuilder().number(1235).canUpdateStack(true).mergeable(PullRequestMergeability.Mergeable).stack(stackWithConflictBelow).build();
			const context = new PRContext(pr);
			const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [1234, 1235] });
			const out = render(<PullRequestContext.Provider value={context}><ActivityBarOverview {...pr} /></PullRequestContext.Provider>);

			assert(out.getByText('A pull request in this stack has conflicts that must be resolved.'));
			fireEvent.click(out.getByText('Resolve conflicts'));
			assert(updateStack.calledOnce);
		});

		it('reports conflicts elsewhere in the stack even when this stack cannot be updated', function () {
			const pr = new PullRequestBuilder().number(1235).canUpdateStack(false).mergeable(PullRequestMergeability.Mergeable).stack(stackWithConflictBelow).build();
			for (const Component of [Overview, ActivityBarOverview]) {
				const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Component {...pr} /></PullRequestContext.Provider>);
				assert(out.getByText('A pull request in this stack has conflicts that must be resolved.'));
				assert.strictEqual(out.queryByText('Resolve conflicts'), null);
				out.unmount();
			}
		});

		it('ignores conflicts in closed pull requests at the top of the stack', function () {
			const pr = new PullRequestBuilder().number(1234).canUpdateStack(true).mergeable(PullRequestMergeability.Behind).stack({
				position: 1, size: 2, base: 'main',
				pullRequests: [
					{ ...conflictingStack.pullRequests[0], mergeable: PullRequestMergeability.Behind },
					{ position: 2, number: 1235, title: 'Closed', head: 'D2', url: 'https://example.com/1235', state: GithubItemStateEnum.Closed, isDraft: false, mergeable: PullRequestMergeability.Conflict },
				],
			}).build();
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
			assert(out.getByText('Update stack'));
			assert.strictEqual(out.queryByText('Resolve conflicts'), null);
			assert.strictEqual(out.queryByText('A pull request in this stack has conflicts that must be resolved.'), null);
		});

		it('shows a failed conflict resolution with the branch status', async function () {
			const pr = new PullRequestBuilder().canUpdateStack(true)
				.mergeable(PullRequestMergeability.Conflict).stack(conflictingStack).build();
			const context = new PRContext(pr);
			sinon.stub(context, 'updateStack').rejects(new Error('Branch D1 changed on GitHub.'));
			const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

			fireEvent.click(out.getByText('Resolve conflicts'));

			await wait(() => assert.strictEqual(out.getByRole('alert').textContent, 'Unable to update the stack: Branch D1 changed on GitHub.'));
			assert.strictEqual(out.getByRole('alert').closest('.stack-section'), null);
		});

		it('does not offer a merge commit to resolve conflicts when the stack cannot be updated', function () {
			const pr = new PullRequestBuilder().canUpdateBranch(true).canUpdateStack(false)
				.mergeable(PullRequestMergeability.Conflict).stack(conflictingStack).build();
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
			assert(out.getByText('This branch has conflicts that must be resolved.'));
			assert.strictEqual(out.queryByText('Resolve conflicts'), null);
		});

		it('does not offer conflict resolution before stack membership is known', function () {
			const pr = { ...new PullRequestBuilder().canUpdateBranch(true).mergeable(PullRequestMergeability.Conflict).build(), stackLoaded: false };
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
			assert.strictEqual(out.queryByText('Resolve conflicts'), null);
		});

		it('resolves conflicts by updating the stack from the sidebar and shows failures there', async function () {
			const pr = new PullRequestBuilder().canUpdateBranch(true).canUpdateStack(true)
				.mergeable(PullRequestMergeability.Conflict).stack(conflictingStack).build();
			const context = new PRContext(pr);
			const updateStack = sinon.stub(context, 'updateStack').rejects(new Error('Branch D1 changed on GitHub.'));
			const updateBranch = sinon.stub(context, 'updateBranch');
			const out = render(<PullRequestContext.Provider value={context}><ActivityBarOverview {...pr} /></PullRequestContext.Provider>);

			fireEvent.click(out.getByText('Resolve conflicts'));

			assert(updateStack.calledOnce);
			assert(updateBranch.notCalled);
			await wait(() => assert.strictEqual(out.getByRole('alert').textContent, 'Unable to update the stack: Branch D1 changed on GitHub.'));
		});

		it('does not offer a merge commit to resolve conflicts from the sidebar when the stack cannot be updated', function () {
			const pr = new PullRequestBuilder().canUpdateBranch(true).canUpdateStack(false)
				.mergeable(PullRequestMergeability.Conflict).stack(conflictingStack).build();
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><ActivityBarOverview {...pr} /></PullRequestContext.Provider>);
			assert.strictEqual(out.queryByText('Resolve conflicts'), null);
		});
	});

	it('does not offer merge-commit updates before stack membership is known or when loading fails', function () {
		for (const change of [{ stackLoaded: false }, { stackLoadError: true }]) {
			const pr = { ...new PullRequestBuilder().canUpdateBranch(true).mergeable(PullRequestMergeability.Behind).build(), ...change };
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
			assert.strictEqual(out.queryByText(/Update with merge commit/i), null);
			out.unmount();
		}
	});

	it('offers stack merging from the bottom PR when GitHub reports it behind its target branch', function () {
		const pullRequests = [
			{ position: 1, number: 793, title: 'First', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			{ position: 2, number: 794, title: 'Second', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
		];
		for (const [number, position, offered] of [[793, 1, true], [794, 2, false]] as const) {
			const pr = new PullRequestBuilder().number(number).mergeable(PullRequestMergeability.Behind)
				.stack({ position, size: 2, base: 'main', pullRequests }).build();
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);

			assert.strictEqual(!!out.container.querySelector('.stack-merge'), offered, `#${number}`);
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
				<PullRequestContext.Provider value={new PRContext(pr)}>
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
			<PullRequestContext.Provider value={new PRContext(pr)}>
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
			<PullRequestContext.Provider value={new PRContext(pr)}>
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
			<PullRequestContext.Provider value={new PRContext(pr)}>
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
		const context = new PRContext(pr);
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
		const context = new PRContext(pr);
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
			<PullRequestContext.Provider value={new PRContext(pr)}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);
		assert(out.getByText('Checking pull request stack membership...'));
		assert.strictEqual(out.container.querySelector('.automerge-section'), null);

		const failed = { ...pr, stackLoaded: true, stackLoadError: true };
		out.rerender(
			<PullRequestContext.Provider value={new PRContext(failed)}>
				<Overview {...failed} />
			</PullRequestContext.Provider>,
		);
		assert(out.getByText('Unable to load pull request stack details. Refresh to retry merging.'));
		assert.strictEqual(out.container.querySelector('.automerge-section'), null);
	});

	it('shows view changes in both headers', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);
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

	it('does not show view changes in either header for issues', function () {
		const pr = new PullRequestBuilder().isIssue(true).build();
		const context = new PRContext(pr);

		const out = render(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		assert.strictEqual(out.container.querySelector('[aria-label="View Pull Request Changes"]'), null);
	});

	it('applies sticky class when scrolled', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);

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
		const context = new PRContext(pr);
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

	describe('stack recommendation', function () {
		function recommendedPullRequest(existingStackSize?: number): PullRequest {
			const pr = new PullRequestBuilder().number(794).build();
			const entries = [
				{ number: 792, title: 'Existing Change', head: 'D0' },
				{ number: 793, title: 'First Change', head: 'D1' },
				{ number: 794, title: 'Second Change', head: 'D2' },
				{ number: 795, title: 'Third Change', head: 'D3' },
			].slice(existingStackSize === undefined ? 1 : 0);
			return {
				...pr,
				stackRecommendation: {
					stack: {
						position: entries.findIndex(entry => entry.number === 794) + 1,
						size: entries.length,
						base: 'main',
						pullRequests: entries.map((entry, index) => ({
							...entry,
							position: index + 1,
							url: `https://example.com/${entry.number}`,
							state: GithubItemStateEnum.Open,
							isDraft: false,
							mergeable: entry.number === 795 ? PullRequestMergeability.Conflict : PullRequestMergeability.Mergeable,
						})),
					},
					existingStackSize,
				},
			};
		}

		function renderOverview(pr: PullRequest, context = new PRContext(pr)) {
			return render(
				<PullRequestContext.Provider value={context}>
					<Overview {...pr} />
				</PullRequestContext.Provider>,
			);
		}

		it('recommends stacking above the title and previews the stack like the stack section', function () {
			const pr = recommendedPullRequest();
			const out = renderOverview(pr);

			const banner = out.container.querySelector('.stack-recommendation');
			assert(banner);
			assert.strictEqual(banner.nextElementSibling?.id, 'title');
			assert(banner.textContent?.includes('This pull request can be stacked with other pull requests.'));
			assert.strictEqual(out.getByText('Learn more about stacks').getAttribute('href'), STACKS_DOCUMENTATION_URL);
			const region = banner.querySelector('.stack-recommendation-preview');
			assert(region);
			assert(region.hasAttribute('hidden'), 'the preview starts collapsed');

			const preview = out.getByText('Preview stack');
			assert.strictEqual(preview.getAttribute('aria-controls'), region.id, 'the button always controls the preview');
			fireEvent.click(preview);

			assert.strictEqual(preview.getAttribute('aria-expanded'), 'true');
			assert.strictEqual(region.hasAttribute('hidden'), false);
			const list = region.querySelector('.stack-entries');
			assert(list);
			assert.strictEqual(list.getAttribute('aria-label'), 'Pull requests merging down into main');
			assert.deepStrictEqual([...list.querySelectorAll('.stack-entry')].map(entry => entry.querySelector('.stack-entry-details')?.textContent), [
				'Third Change#795 - D3',
				'Second Change#794 - D2',
				'First Change#793 - D1',
			]);
			assert.deepStrictEqual([...list.querySelectorAll('.stack-entry-readiness')].map(entry => entry.getAttribute('aria-label')), [
				'Merge conflicts',
				'Ready to merge',
				'Ready to merge',
			]);
			assert.strictEqual(list.querySelector('.stack-entry.current')?.getAttribute('aria-current'), 'step');
			assert.strictEqual(list.querySelector('a[href="https://example.com/793"]')?.textContent, 'First Change');
			assert.strictEqual(list.querySelector('.stack-base')?.textContent, 'main');
			assert(banner.textContent?.includes('3 pull requests will be stacked, merging down into main.'));
			assert.strictEqual(preview.textContent, 'Hide stack', 'the same button hides the preview');
			assert.strictEqual(out.queryByText('Preview stack'), null);
			assert.strictEqual(out.queryByText('Cancel'), null);

			fireEvent.click(preview);
			assert(region.hasAttribute('hidden'));
			assert.strictEqual(preview.getAttribute('aria-expanded'), 'false');
			assert.strictEqual(preview.getAttribute('aria-controls'), region.id);
			assert.strictEqual(preview.textContent, 'Preview stack');
		});

		it('describes adding the pull requests to the top of an existing stack', function () {
			const out = renderOverview(recommendedPullRequest(1));
			fireEvent.click(out.getByText('Preview stack'));

			assert(out.container.textContent?.includes('3 pull requests will be added to the top of an existing stack of 1 pull request.'));
			assert(out.getByText('Add to stack', { selector: 'button' }));
			assert.strictEqual(out.container.querySelectorAll('.stack-recommendation .stack-entry').length, 4);
		});

		it('stacks the previewed pull requests', async function () {
			const pr = recommendedPullRequest();
			const context = new PRContext(pr);
			const create = sinon.stub(context, 'createRecommendedStack').resolves();
			const out = renderOverview(pr, context);
			fireEvent.click(out.getByText('Preview stack'));

			fireEvent.click(out.getByText('Create stack'));

			assert(create.calledOnceWithExactly([793, 794, 795]));
			await wait(() => assert.strictEqual((out.getByText('Create stack') as HTMLButtonElement).disabled, false));
		});

		it('shows an inline error when stacking fails', async function () {
			const pr = recommendedPullRequest();
			const context = new PRContext(pr);
			sinon.stub(context, 'createRecommendedStack').rejects(new Error('The pull requests that can be stacked have changed.'));
			const out = renderOverview(pr, context);
			fireEvent.click(out.getByText('Preview stack'));

			fireEvent.click(out.getByText('Create stack'));

			const alert = await waitForElement(() => out.container.querySelector('.stack-recommendation .stack-action-error[role="alert"]'));
			assert.strictEqual(alert?.textContent, 'Unable to stack pull requests: The pull requests that can be stacked have changed.');
			assert.strictEqual((out.getByText('Create stack') as HTMLButtonElement).disabled, false);
		});

		it('dismisses the recommendation', function () {
			const pr = recommendedPullRequest();
			const context = new PRContext(pr);
			const dismiss = sinon.stub(context, 'dismissStackRecommendation').resolves();
			const out = renderOverview(pr, context);

			fireEvent.click(out.getByLabelText('Dismiss stack recommendation'));

			assert(dismiss.calledOnce);
		});

		it('shows no recommendation when there is none', function () {
			for (const stackRecommendation of [undefined, null]) {
				const out = renderOverview({ ...new PullRequestBuilder().build(), stackRecommendation });
				assert.strictEqual(out.container.querySelector('.stack-recommendation'), null);
				cleanup();
			}
		});

		it('starts collapsed when the recommendation comes back after the pull requests were stacked and unstacked', async function () {
			const pr = recommendedPullRequest();
			// The context saves the pull request as webview state and updates it in place.
			const recommendation = pr.stackRecommendation;
			const context = new PRContext(pr);
			context.setPR(pr);
			const postMessage = sinon.stub(context, 'postMessage').resolves();
			const consoleError = sinon.spy(console, 'error');
			const out = render(
				<PullRequestContext.Provider value={context}>
					<EditorRoot>{(current: PullRequest) => <Overview {...current} />}</EditorRoot>
				</PullRequestContext.Provider>,
			);
			fireEvent.click(out.getByText('Preview stack'));
			assert.strictEqual(out.container.querySelector('.stack-recommendation-preview')?.hasAttribute('hidden'), false);

			fireEvent.click(out.getByText('Create stack'));
			await wait(() => assert.strictEqual(out.container.querySelector('.stack-recommendation'), null));
			assert(postMessage.calledWithExactly({ command: 'pr.create-recommended-stack', args: { pullRequests: [793, 794, 795] } }));

			context.handleMessage({ command: 'pr.update', pullrequest: { stackRecommendation: recommendation } });

			const banner = await waitForElement(() => out.container.querySelector('.stack-recommendation'));
			assert.strictEqual(banner?.querySelector('.stack-recommendation-preview')?.hasAttribute('hidden'), true);
			assert.strictEqual(out.getByText('Preview stack').getAttribute('aria-expanded'), 'false');
			assert(consoleError.getCalls().every(call => !String(call.args[0]).includes('unmounted component')));
		});

		it('hides the recommendation as soon as it is dismissed or stacked', async function () {
			for (const act of [
				(context: PRContext) => context.dismissStackRecommendation(),
				(context: PRContext) => context.createRecommendedStack([793, 794, 795]),
			]) {
				const pr = recommendedPullRequest();
				const context = new PRContext(pr);
				context.setPR(pr);
				const postMessage = sinon.stub(context, 'postMessage').resolves();

				await act(context);

				assert.strictEqual(context.pr?.stackRecommendation, null);
				assert(postMessage.calledOnce);
				postMessage.restore();
			}
		});

		it('keeps the recommendation when stacking fails', async function () {
			const pr = recommendedPullRequest();
			const context = new PRContext(pr);
			context.setPR(pr);
			const postMessage = sinon.stub(context, 'postMessage').rejects(new Error('Failed'));

			await assert.rejects(context.createRecommendedStack([793, 794, 795]), /Failed/);

			assert(postMessage.calledOnceWithExactly({ command: 'pr.create-recommended-stack', args: { pullRequests: [793, 794, 795] } }));
			assert(context.pr?.stackRecommendation);
		});
	});
});
