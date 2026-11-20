/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as React from 'react';
import { act, cleanup, fireEvent, render, RenderResult, wait, waitForElement } from 'react-testing-library';
import { createSandbox, SinonSandbox, SinonSpy, SinonStub } from 'sinon';

import { AccountBuilder } from './builder/account';
import { PullRequestBuilder } from './builder/pullRequest';
import { IComment } from '../../../src/common/comment';
import { COPILOT_REVIEWER, COPILOT_REVIEWER_ID } from '../../../src/common/copilot';
import { EventType, ReviewEvent, ReviewStateValue, TimelineEvent } from '../../../src/common/timelineEvent';
import { AccountType, CheckState, GithubItemStateEnum, MergeQueueEntry, MergeQueueState, PullRequestCheckStatus, PullRequestMergeability, PullRequestStack } from '../../../src/github/interface';
import { DeleteCommentReply, PullRequest, SubmitReviewReply } from '../../../src/github/views';
import { Root as ActivityBarRoot } from '../../activityBarView/app';
import { Overview as ActivityBarOverview } from '../../activityBarView/overview';
import { COMMENT_TEXTAREA_ID } from '../../common/constants';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { STACK_RECOMMENDATION_HINT_LABEL as HINT, STACKS_DOCUMENTATION_URL } from '../../components/stackRecommendation';
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

	it('renders the sidebar before the main column so the timeline can flow below it', function () {
		const pr = new PullRequestBuilder().build();
		const out = render(
			<PullRequestContext.Provider value={new PRContext(pr)}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);

		const sidebar = out.container.querySelector('#sidebar')!;
		assert.strictEqual(sidebar.nextElementSibling, out.container.querySelector('#main'));
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

	describe('workflows awaiting approval', function () {
		const waiting: PullRequestCheckStatus = {
			id: 'awaiting-approval:CI', state: CheckState.Pending, context: 'CI',
			description: 'Waiting for approval', targetUrl: null, workflowName: 'CI', event: 'pull_request',
			url: undefined, avatarUrl: undefined, isRequired: false, isCheckRun: true, databaseId: undefined,
		};

		function renderAwaitingApproval(workflowRunIds: number[], hasWritePermission: boolean) {
			const pr = new PullRequestBuilder()
				.hasWritePermission(hasWritePermission)
				.status(checks => checks.state(CheckState.Pending).statuses([waiting]).workflowRunIdsAwaitingApproval(workflowRunIds))
				.build();
			const context = new PRContext(pr);
			const approveWorkflowRuns = sinon.stub(context, 'approveWorkflowRuns').resolves();
			const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);
			return { out, approveWorkflowRuns };
		}

		it('offers maintainers to approve them above the checks', async function () {
			const { out, approveWorkflowRuns } = renderAwaitingApproval([11, 12], true);

			const heading = out.getByText('2 workflows awaiting approval');
			assert(heading.compareDocumentPosition(out.getByLabelText('Show status checks')) & Node.DOCUMENT_POSITION_FOLLOWING);
			fireEvent.click(out.getByText('Approve Workflows'));

			await wait(() => assert(approveWorkflowRuns.calledOnceWithExactly([11, 12])));
		});

		it('only explains them to users who cannot approve them', function () {
			const { out } = renderAwaitingApproval([11], false);

			assert(out.getByText('1 workflow awaiting approval'));
			assert.strictEqual(out.queryByText('Approve Workflows'), null);
		});
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

	it('opens the details of a check in the browser instead of letting the webview host open them', function () {
		// A check that hasn't reported yet links to the pull request, which the extension would open in this overview.
		const pullRequestUrl = 'https://github.com/owner/name/pull/1234';
		const waiting: PullRequestCheckStatus = {
			id: '', state: CheckState.Pending, context: 'Required check', description: 'Waiting for status to be reported',
			targetUrl: pullRequestUrl, workflowName: undefined, event: undefined, url: undefined, avatarUrl: undefined,
			isRequired: true, isCheckRun: false, databaseId: undefined,
		};
		const pr = new PullRequestBuilder().status(checks => checks.state(CheckState.Pending).statuses([waiting])).build();
		const context = new PRContext(pr);
		const openCheckDetails = sinon.stub(context, 'openCheckDetails').resolves();
		// Stands in for the webview host, which opens any anchor with an href that a click reaches.
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
			fireEvent.click(out.getByLabelText('Show status checks'));

			fireEvent.click(out.getByText('Details'));

			assert(openCheckDetails.calledOnceWithExactly(pullRequestUrl));
			assert.deepStrictEqual(hostOpenedLinks, []);
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
		const mergeButton = out.getByText('Merge Partial Stack (2 Pull Requests)');
		fireEvent.change(out.getByLabelText('Select merge method'), { target: { value: 'squash' } });
		fireEvent.click(mergeButton);
		assert(out.getByText('Merge this pull request and 1 open pull request below it?'));
		fireEvent.click(out.getByText('Merge Partial Stack (2 Pull Requests)'));
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
				const stackAction = mergeQueueMethod ? 'Add Stack to Merge Queue' : 'Merge Stack (3 Pull Requests)';
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
		const button = out.getByText('Unstack All');
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
		assert.strictEqual(out.queryByText('Unstack All'), null);
		out.rerender(
			<PullRequestContext.Provider value={new PRContext({ ...pr, stack: { ...stack, pullRequests: [stack.pullRequests[0]] } })}>
				<Overview {...pr} stack={{ ...stack, pullRequests: [stack.pullRequests[0]] }} />
			</PullRequestContext.Provider>,
		);
		assert.strictEqual(out.queryByText('Unstack All'), null);
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
		fireEvent.click(out.getByText('Unstack All'));
		const alert = await waitForElement(() => out.container.querySelector('.stack-action-error[role="alert"]'));
		assert.strictEqual(alert?.textContent, 'Unable to unstack pull requests: Stack is locked');
		assert(alert.closest('.stack-section'), 'the error is shown with the stack');
		assert.strictEqual((out.getByText('Unstack All') as HTMLButtonElement).disabled, false);
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
		const button = out.getByText('Update Stack');
		const section = out.container.querySelector('#pull-request-stack');
		assert(section);
		assert.strictEqual(button.closest('.stack-section'), null);
		assert(section.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING, 'the button is below the stack');
		assert(button.closest('.status-item')?.textContent?.includes('No conflicts with main'));
		assert.deepStrictEqual([...section.querySelectorAll('.stack-actions button')].map(action => action.textContent), ['Unstack All']);
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
		assert(out.getByText('Unstack All'));

		fireEvent.click(chevron);

		assert.strictEqual(chevron.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(chevron.getAttribute('aria-label'), 'Expand pull request stack');
		assert(content.hasAttribute('hidden'));
		assert.strictEqual(out.queryByText('Unstack All'), null, 'the stack is only unstacked while it is shown');

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
		assert(out.getByText('Update Stack'));
		for (const change of [
			{ canUpdateStack: false },
			{ stackLoaded: false },
			{ stackLoadError: true },
			{ stack: undefined },
		]) {
			out.rerender(<PullRequestContext.Provider value={context}><Overview {...pr} {...change} /></PullRequestContext.Provider>);
			assert.strictEqual(out.queryByText('Update Stack'), null);
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
		fireEvent.click(out.getByText('Update Stack'));
		const alert = await waitForElement(() => out.container.querySelector('.stack-action-error[role="alert"]'));
		assert.strictEqual(alert?.textContent, 'Unable to update the stack: Branch changed on GitHub');
		assert.strictEqual(alert.closest('.stack-section'), null, 'the error is shown with the button');
		assert.strictEqual((out.getByText('Update Stack') as HTMLButtonElement).disabled, false);
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
			fireEvent.click(out.getByText(firstAction === 'update' ? 'Update Stack' : 'Unstack All'));
			const alert = await waitForElement(() => out.container.querySelector('.stack-action-error[role="alert"]'));
			assert(alert?.textContent?.includes('Previous action failed'));

			fireEvent.click(out.getByText(firstAction === 'update' ? 'Unstack All' : 'Update Stack'));
			assert.strictEqual(out.container.querySelector('.stack-action-error'), null);
			assert(out.getByText(firstAction === 'update' ? 'Unstacking...' : 'Updating...'));
			finish();
			await waitForElement(() => out.getByText(firstAction === 'update' ? 'Unstack All' : 'Update Stack'));
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
				assert(out.getByText('Branch is out of date'));
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

		assert(out.getByText('Branch is out of date'));
		const button = out.getByText('Update Stack');
		assert.strictEqual(button.closest('.stack-section'), null);
		assert(button.closest('.status-item')?.textContent?.includes('Branch is out of date'));
		assert.strictEqual(out.queryAllByText('Update Stack').length, 1);
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

		assert.strictEqual(out.getByText('Update Stack').closest('.stack-section'), null);
		assert.strictEqual(out.queryAllByText('Update Stack').length, 1);
		assert.strictEqual(out.queryByText(/Update with merge commit/i), null);
		fireEvent.click(out.getByText('Update Stack'));
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
		assert.strictEqual(out.queryByText('Update Stack'), null);
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

		assert(out.getByText('Update Stack').closest('.status-item')?.textContent?.includes('No conflicts with main'));
		assert.strictEqual(out.queryAllByText('Update Stack').length, 1);
		out.unmount();

		const sidebar = render(<PullRequestContext.Provider value={new PRContext(pr)}><ActivityBarOverview {...pr} /></PullRequestContext.Provider>);
		assert.strictEqual(sidebar.queryByText('Update Stack'), null, 'the sidebar only updates the stack to resolve conflicts');
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

		assert.strictEqual(out.getByText('Update Stack').closest('.stack-section'), null);
		assert.strictEqual(out.queryAllByText('Update Stack').length, 1);
		assert.strictEqual(out.queryByText(/Update with merge commit/i), null);
		fireEvent.click(out.getByText('Update Stack'));
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
		fireEvent.click(out.getByText('Resolve Conflicts'));
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
			assert.strictEqual(out.queryAllByText('Resolve Conflicts').length, 1, 'the stack has a single update action');
			assert(out.getByText('Resolve Conflicts').closest('.status-item')?.textContent?.includes('This branch has conflicts that must be resolved.'));
			assert.strictEqual(out.queryByText('Update Stack'), null);
			fireEvent.click(out.getByText('Resolve Conflicts'));

			assert(updateStack.calledOnce);
			assert(updateBranch.notCalled);
			await wait(() => assert.strictEqual(out.getByText('Updating...').closest('button')!.disabled, true));
			assert.strictEqual(out.getByText('Unstack All').closest('button')!.disabled, true, 'stack actions share progress');
			finishUpdate();
			await wait(() => assert.strictEqual(out.getByText('Resolve Conflicts').closest('button')!.disabled, false));
		});

		it('offers to resolve conflicts when another pull request in the stack has conflicts', function () {
			const pr = new PullRequestBuilder().number(1235).canUpdateStack(true).mergeable(PullRequestMergeability.Mergeable).stack(stackWithConflictBelow).build();
			const context = new PRContext(pr);
			const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [1234, 1235] });
			const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

			assert(out.getByText('A pull request in this stack has conflicts that must be resolved.'));
			assert.strictEqual([...out.container.querySelectorAll('.status-heading')].some(heading => heading.textContent?.startsWith('No conflicts')), false);
			assert.strictEqual(out.queryAllByText('Resolve Conflicts').length, 1, 'the stack has a single update action');
			assert(out.getByText('Resolve Conflicts').closest('.status-item')?.textContent?.includes('A pull request in this stack has conflicts that must be resolved.'));
			assert.strictEqual(out.queryByText('Update Stack'), null);
			fireEvent.click(out.getByText('Resolve Conflicts'));
			assert(updateStack.calledOnce);
		});

		it('resolves conflicts in another pull request in the stack from the sidebar', function () {
			const pr = new PullRequestBuilder().number(1235).canUpdateStack(true).mergeable(PullRequestMergeability.Mergeable).stack(stackWithConflictBelow).build();
			const context = new PRContext(pr);
			const updateStack = sinon.stub(context, 'updateStack').resolves({ updatedPullRequests: [1234, 1235] });
			const out = render(<PullRequestContext.Provider value={context}><ActivityBarOverview {...pr} /></PullRequestContext.Provider>);

			assert(out.getByText('A pull request in this stack has conflicts that must be resolved.'));
			fireEvent.click(out.getByText('Resolve Conflicts'));
			assert(updateStack.calledOnce);
		});

		it('reports conflicts elsewhere in the stack even when this stack cannot be updated', function () {
			const pr = new PullRequestBuilder().number(1235).canUpdateStack(false).mergeable(PullRequestMergeability.Mergeable).stack(stackWithConflictBelow).build();
			for (const Component of [Overview, ActivityBarOverview]) {
				const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Component {...pr} /></PullRequestContext.Provider>);
				assert(out.getByText('A pull request in this stack has conflicts that must be resolved.'));
				assert.strictEqual(out.queryByText('Resolve Conflicts'), null);
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
			assert(out.getByText('Update Stack'));
			assert.strictEqual(out.queryByText('Resolve Conflicts'), null);
			assert.strictEqual(out.queryByText('A pull request in this stack has conflicts that must be resolved.'), null);
		});

		it('shows a failed conflict resolution with the branch status', async function () {
			const pr = new PullRequestBuilder().canUpdateStack(true)
				.mergeable(PullRequestMergeability.Conflict).stack(conflictingStack).build();
			const context = new PRContext(pr);
			sinon.stub(context, 'updateStack').rejects(new Error('Branch D1 changed on GitHub.'));
			const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

			fireEvent.click(out.getByText('Resolve Conflicts'));

			await wait(() => assert.strictEqual(out.getByRole('alert').textContent, 'Unable to update the stack: Branch D1 changed on GitHub.'));
			assert.strictEqual(out.getByRole('alert').closest('.stack-section'), null);
		});

		it('does not offer a merge commit to resolve conflicts when the stack cannot be updated', function () {
			const pr = new PullRequestBuilder().canUpdateBranch(true).canUpdateStack(false)
				.mergeable(PullRequestMergeability.Conflict).stack(conflictingStack).build();
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
			assert(out.getByText('This branch has conflicts that must be resolved.'));
			assert.strictEqual(out.queryByText('Resolve Conflicts'), null);
		});

		it('does not offer conflict resolution before stack membership is known', function () {
			const pr = { ...new PullRequestBuilder().canUpdateBranch(true).mergeable(PullRequestMergeability.Conflict).build(), stackLoaded: false };
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
			assert.strictEqual(out.queryByText('Resolve Conflicts'), null);
		});

		it('resolves conflicts by updating the stack from the sidebar and shows failures there', async function () {
			const pr = new PullRequestBuilder().canUpdateBranch(true).canUpdateStack(true)
				.mergeable(PullRequestMergeability.Conflict).stack(conflictingStack).build();
			const context = new PRContext(pr);
			const updateStack = sinon.stub(context, 'updateStack').rejects(new Error('Branch D1 changed on GitHub.'));
			const updateBranch = sinon.stub(context, 'updateBranch');
			const out = render(<PullRequestContext.Provider value={context}><ActivityBarOverview {...pr} /></PullRequestContext.Provider>);

			fireEvent.click(out.getByText('Resolve Conflicts'));

			assert(updateStack.calledOnce);
			assert(updateBranch.notCalled);
			await wait(() => assert.strictEqual(out.getByRole('alert').textContent, 'Unable to update the stack: Branch D1 changed on GitHub.'));
		});

		it('does not offer a merge commit to resolve conflicts from the sidebar when the stack cannot be updated', function () {
			const pr = new PullRequestBuilder().canUpdateBranch(true).canUpdateStack(false)
				.mergeable(PullRequestMergeability.Conflict).stack(conflictingStack).build();
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><ActivityBarOverview {...pr} /></PullRequestContext.Provider>);
			assert.strictEqual(out.queryByText('Resolve Conflicts'), null);
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
		assert(out.getByText('Merge Partial Stack (1 Pull Request)'));
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

		assert(out.getByText('Add Stack to Merge Queue'));
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

		fireEvent.click(out.getByText('Merge Stack (1 Pull Request)'));
		fireEvent.click(out.getByText('Merge Stack (1 Pull Request)'));
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

		fireEvent.click(out.getByText('Merge Stack (1 Pull Request)'));
		fireEvent.click(out.getByText('Merge Stack (1 Pull Request)'));

		assert(mergeStack.calledOnce);
		assert.strictEqual((await waitForElement(() => out.container.querySelector('[role="alert"]')))?.textContent, 'Unable to merge stack: Required checks failed');
		assert.strictEqual(context.pr?.state, GithubItemStateEnum.Open);
		assert.strictEqual(out.getByText('Merge Stack (1 Pull Request)').hasAttribute('disabled'), false);
	});

	describe('stack auto-merge', function () {
		const entry = (position: number, mergeable = PullRequestMergeability.NotMergeable): PullRequestStack['pullRequests'][number] => ({
			position, number: 792 + position, title: `Change ${position}`, head: `D${position}`, url: `https://example.com/${792 + position}`,
			state: GithubItemStateEnum.Open, isDraft: false, mergeable,
		});
		const stack: PullRequestStack = { position: 2, size: 3, base: 'main', pullRequests: [entry(1), entry(2), entry(3)] };

		it('is offered for this pull request and the ones below it while the stack cannot be merged', async function () {
			const pr = new PullRequestBuilder().number(794).mergeable(PullRequestMergeability.NotMergeable).stack(stack)
				.mergeMethodsAvailability({ merge: true, squash: true, rebase: false })
				.stackAutoMerge({ viewerCanEnable: true, viewerCanDisable: false }).build();
			const context = new PRContext(pr);
			context.setPR(pr);
			const enabled = { enabledThrough: 794, mergeMethod: 'squash', viewerCanEnable: false, viewerCanDisable: true };
			const postMessage = sinon.stub(context, 'postMessage').resolves(enabled);
			const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

			const checkbox = out.getByLabelText('Merge automatically when requirements are met (2 pull requests)') as HTMLInputElement;
			assert.strictEqual(checkbox.checked, false);
			assert.strictEqual(out.container.querySelector<HTMLOptionElement>('.automerge-section option[value="rebase"]')?.disabled, true);
			// The merge method is chosen before enabling, without changing anything on GitHub.
			fireEvent.change(out.container.querySelector('.automerge-section select')!, { target: { value: 'squash' } });
			fireEvent.click(checkbox);

			await wait(() => assert.deepStrictEqual(context.pr?.stackAutoMerge, enabled));
			assert(postMessage.calledOnceWithExactly({
				command: 'pr.update-stack-automerge',
				args: { autoMerge: true, autoMergeMethod: 'squash', expectedEnabledThrough: undefined },
			}));
		});

		it('counts only this pull request at the bottom of the stack, since the ones above are not merged with it', function () {
			const pr = new PullRequestBuilder().number(793).mergeable(PullRequestMergeability.NotMergeable).stack({ ...stack, position: 1 })
				.stackAutoMerge({ viewerCanEnable: true, viewerCanDisable: false }).build();
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);

			assert(out.getByLabelText('Merge automatically when requirements are met (1 pull request)'));
		});

		it('shows the merge method of a request that is enabled elsewhere, instead of the one chosen here', async function () {
			const pr = new PullRequestBuilder().number(794).mergeable(PullRequestMergeability.NotMergeable).stack(stack)
				.stackAutoMerge({ viewerCanEnable: true, viewerCanDisable: false }).build();
			const context = new PRContext(pr);
			context.setPR(pr);
			sinon.stub(context, 'postMessage').resolves();
			const out = render(
				<PullRequestContext.Provider value={context}>
					<EditorRoot>{(current: PullRequest) => <Overview {...current} />}</EditorRoot>
				</PullRequestContext.Provider>,
			);
			const method = () => out.container.querySelector<HTMLSelectElement>('.automerge-section select');
			fireEvent.change(method()!, { target: { value: 'rebase' } });

			context.handleMessage({
				command: 'pr.update',
				pullrequest: { stackAutoMerge: { enabledThrough: 795, mergeMethod: 'squash', viewerCanEnable: false, viewerCanDisable: true } },
			});

			await wait(() => assert.strictEqual(method()?.value, 'squash'));
			assert.strictEqual(method()?.disabled, true);
		});

		it('disables the request that was shown, which can only be disabled and not changed, since GitHub cannot change its merge method', async function () {
			const pr = new PullRequestBuilder().number(794).mergeable(PullRequestMergeability.NotMergeable).stack(stack)
				.stackAutoMerge({ enabledThrough: 795, mergeMethod: 'squash', viewerCanEnable: false, viewerCanDisable: true }).build();
			const context = new PRContext(pr);
			context.setPR(pr);
			const postMessage = sinon.stub(context, 'postMessage').resolves({ viewerCanEnable: true, viewerCanDisable: false });
			const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

			const checkbox = out.getByLabelText('Merge automatically when requirements are met (enabled through #795)') as HTMLInputElement;
			assert.strictEqual(checkbox.checked, true);
			assert.strictEqual(checkbox.disabled, false);
			const method = out.container.querySelector<HTMLSelectElement>('.automerge-section select');
			assert.strictEqual(method?.value, 'squash');
			assert.strictEqual(method?.disabled, true);
			fireEvent.click(checkbox);

			await wait(() => assert(postMessage.calledOnceWithExactly({
				command: 'pr.update-stack-automerge',
				args: { autoMerge: false, autoMergeMethod: 'squash', expectedEnabledThrough: 795 },
			})));
		});

		it('still shows a request covering a pull request that is ready to merge, so that it can be disabled, but offers no new one', function () {
			const ready: PullRequestStack = {
				...stack,
				pullRequests: [entry(1, PullRequestMergeability.Mergeable), entry(2, PullRequestMergeability.Mergeable), entry(3)],
			};
			const covered = new PullRequestBuilder().number(794).stack(ready)
				.stackAutoMerge({ enabledThrough: 795, mergeMethod: 'squash', viewerCanEnable: false, viewerCanDisable: true }).build();
			const out = render(<PullRequestContext.Provider value={new PRContext(covered)}><Overview {...covered} /></PullRequestContext.Provider>);

			assert(out.container.querySelector('.stack-merge'));
			assert(out.getByLabelText('Merge automatically when requirements are met (enabled through #795)'));

			const uncovered = { ...covered, stackAutoMerge: { viewerCanEnable: true, viewerCanDisable: false } };
			const other = render(<PullRequestContext.Provider value={new PRContext(uncovered)}><Overview {...uncovered} /></PullRequestContext.Provider>);

			assert(other.container.querySelector('.stack-merge'));
			assert.strictEqual(other.container.querySelector('#automerge-checkbox'), null);
		});
	});

	describe('merge all', function () {
		const entry = (position: number, change: Partial<PullRequestStack['pullRequests'][number]> = {}): PullRequestStack['pullRequests'][number] => ({
			position, number: 792 + position, title: `Change ${position}`, head: `D${position}`, url: `https://example.com/${792 + position}`,
			state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable, ...change,
		});
		const middleOf = (top: Partial<PullRequestStack['pullRequests'][number]> = {}) =>
			new PullRequestBuilder().number(794).stack({ position: 2, size: 3, base: 'main', pullRequests: [entry(1), entry(2), entry(3, top)] });

		it('offers to merge every open pull request in the stack, up to the top, from an icon button when they are all ready', async function () {
			const pr = middleOf().build();
			for (const Component of [Overview, ActivityBarOverview]) {
				const view = render(<PullRequestContext.Provider value={new PRContext(pr)}><Component {...pr} /></PullRequestContext.Provider>);
				assert(view.getByText('Merge Partial Stack (2 Pull Requests)'));
				const mergeAll = view.getByLabelText('Merge all 3 open pull requests in this stack');
				assert.strictEqual(mergeAll.getAttribute('title'), 'Merge all 3 open pull requests in this stack');
				assert(mergeAll.classList.contains('icon-button'));
				assert.strictEqual(mergeAll.textContent, '', 'the button only shows an icon');
				view.unmount();
			}
			const context = new PRContext(pr);
			context.setPR(pr);
			const mergeStack = sinon.stub(context, 'mergeStack').resolves({ status: 'merged', state: GithubItemStateEnum.Merged });
			const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

			fireEvent.change(out.getByLabelText('Select merge method'), { target: { value: 'squash' } });
			fireEvent.click(out.getByLabelText('Merge all 3 open pull requests in this stack'));
			assert(out.getByText('Merge all 3 open pull requests in this stack?'));
			assert.strictEqual(out.queryByText('Merge Partial Stack (2 Pull Requests)'), null);
			fireEvent.click(out.getByText('Merge All (3 Pull Requests)'));

			await wait(() => assert.strictEqual(context.pr?.state, GithubItemStateEnum.Merged));
			assert(mergeStack.calledOnceWithExactly('squash', 795));
		});

		it('offers to add every open pull request to the merge queue when the base has one', function () {
			const pr = middleOf().mergeQueueMethod('squash').build();
			const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);

			assert(out.getByText('Add Partial Stack to Merge Queue'));
			fireEvent.click(out.getByLabelText('Add all 3 open pull requests in this stack to the merge queue'));

			assert(out.getByText('Add all 3 open pull requests in this stack to the merge queue?'));
			assert(out.getByText('Add All to Merge Queue'));
		});

		it('only merges this pull request and the ones below it with Merge stack', async function () {
			const pr = middleOf().build();
			const context = new PRContext(pr);
			const mergeStack = sinon.stub(context, 'mergeStack').resolves({ status: 'merged', state: GithubItemStateEnum.Merged });
			const out = render(<PullRequestContext.Provider value={context}><Overview {...pr} /></PullRequestContext.Provider>);

			fireEvent.click(out.getByText('Merge Partial Stack (2 Pull Requests)'));
			assert(out.getByText('Merge this pull request and 1 open pull request below it?'));
			fireEvent.click(out.getByText('Merge Partial Stack (2 Pull Requests)'));

			await wait(() => assert(mergeStack.calledOnce));
			assert(mergeStack.calledOnceWithExactly('merge'));
		});

		it('is not offered for the top of the stack or when a pull request above is not ready', function () {
			const notReady = [
				{ isDraft: true },
				{ mergeable: PullRequestMergeability.NotMergeable },
				{ mergeable: PullRequestMergeability.Behind },
				{ mergeable: PullRequestMergeability.Conflict },
				{ state: GithubItemStateEnum.Closed },
			].map(change => middleOf(change).build());
			const top = new PullRequestBuilder().number(795).stack({ position: 3, size: 3, base: 'main', pullRequests: [entry(1), entry(2), entry(3)] }).build();
			for (const pr of [...notReady, top]) {
				const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
				assert(out.getByText(/^Merge (Partial )?Stack/));
				assert.strictEqual(out.queryByLabelText(/^Merge all/), null);
				out.unmount();
			}
		});
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

	it('offers merging and updating a pull request that was loaded without a stack, before its stack is checked', function () {
		const pr = { ...new PullRequestBuilder().build(), stack: null, stackLoaded: false };
		const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);
		assert.strictEqual(out.queryByText('Checking pull request stack membership...'), null);
		assert(out.container.querySelector('.automerge-section'));
		out.unmount();

		const behind = { ...new PullRequestBuilder().canUpdateBranch(true).mergeable(PullRequestMergeability.Behind).build(), stack: null, stackLoaded: false };
		const updating = render(<PullRequestContext.Provider value={new PRContext(behind)}><Overview {...behind} /></PullRequestContext.Provider>);
		assert(updating.queryByText(/Update with merge commit/i));
	});

	it('shows a stack loaded with the pull request while the merge status of its pull requests is checked', function () {
		const unknown = PullRequestMergeability.Unknown;
		const pr = new PullRequestBuilder().number(794).stackLoaded(false).stack({
			position: 2, size: 2, base: 'main',
			pullRequests: [
				{ position: 1, number: 793, title: 'First', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Merged, isDraft: false, mergeable: unknown },
				{ position: 2, number: 794, title: 'Second', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: unknown },
			],
		}).build();
		const out = render(<PullRequestContext.Provider value={new PRContext(pr)}><Overview {...pr} /></PullRequestContext.Provider>);

		assert.strictEqual(out.container.querySelector('.stack-badge')?.textContent, '2/2');
		assert.deepStrictEqual([...out.container.querySelectorAll('.stack-entry-readiness')].map(entry => entry.getAttribute('aria-label')),
			['Mergeability is being checked', 'Already merged']);
		assert(out.getByText('Checking whether the stack can be merged...'));
		assert.strictEqual(out.queryByText('Checking pull request stack membership...'), null);
		assert.strictEqual(out.container.querySelector('.stack-merge'), null);
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

	it('does not show the checkout button in the agents window', function () {
		for (const isCurrentlyCheckedOut of [false, true]) {
			const pr = new PullRequestBuilder().isAgentSessionsWorkspace(true).isCurrentlyCheckedOut(isCurrentlyCheckedOut).build();
			const context = new PRContext(pr);

			const out = render(
				<PullRequestContext.Provider value={context}>
					<Overview {...pr} />
				</PullRequestContext.Provider>,
			);

			assert.strictEqual(out.queryByText('Checkout'), null);
			assert.strictEqual(out.queryByText('Checkout \'main\''), null);
			assert.strictEqual(out.container.querySelector('[data-vscode-context*="github:checkoutMenu"]'), null);
			assert(out.getByText('Refresh'));
			cleanup();
		}
	});

	describe('overview tabs', function () {
		function renderTabbedOverview(pr = new PullRequestBuilder().overviewTabs(true).build(), beforeRender?: (context: PRContext) => void) {
			const context = new PRContext(pr);
			beforeRender?.(context);
			const out = render(
				<PullRequestContext.Provider value={context}>
					<Overview {...pr} />
				</PullRequestContext.Provider>,
			);
			const tabs = [...out.container.querySelectorAll<HTMLElement>('[role="tab"]')];
			const selectedTab = () => tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent;
			const visiblePanels = () => [...out.container.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter(panel => !panel.hidden);
			return { context, out, tabs, selectedTab, visiblePanels };
		}

		const failedCheckRun: PullRequestCheckStatus = {
			id: 'build', state: CheckState.Failure, context: 'Build',
			description: null, targetUrl: null, workflowName: undefined, event: undefined,
			url: undefined, avatarUrl: undefined, isRequired: false, isCheckRun: true, databaseId: 1,
		};

		function reviewEvent(comments: Partial<IComment>[]): ReviewEvent {
			return {
				id: 1,
				event: EventType.Reviewed,
				submittedAt: '2019-01-01T10:00:00Z',
				body: '',
				htmlUrl: 'https://github.com/owner/name/pull/1234#pullrequestreview-1',
				user: new AccountBuilder().build(),
				authorAssociation: 'MEMBER',
				state: 'COMMENTED',
				comments: comments.map((comment, index) => ({
					id: index,
					url: '',
					diffHunk: '',
					body: 'Please rename this.',
					createdAt: '2019-01-01T10:00:00Z',
					htmlUrl: '',
					graphNodeId: `comment-${index}`,
					user: new AccountBuilder().build(),
					path: 'src/file.ts',
					position: 1,
					threadId: `thread-${index}`,
					isResolved: false,
					...comment,
				})),
			};
		}

		/** The session action shown on the right of the tabs, if any. */
		function visibleSessionAction(container: HTMLElement) {
			const visible = [...container.querySelectorAll<HTMLElement>('.overview-session-action')].filter(action => !action.hidden);
			assert(visible.length <= 1);
			return visible[0]?.querySelector('button');
		}

		/** The label of the session action shown with each tab selected, by tab. */
		function sessionActionsByTab(container: HTMLElement, tabs: HTMLElement[]) {
			return Object.fromEntries(tabs.map(tab => {
				fireEvent.click(tab);
				return [tab.textContent, visibleSessionAction(container)?.textContent ?? null];
			}));
		}

		/** An open pull request in the agents window with `overrides`. */
		const agentsPullRequestWith = (overrides: Partial<PullRequest>): PullRequest =>
			({ ...new PullRequestBuilder().isAgentSessionsWorkspace(true).overviewTabs(true).build(), ...overrides });

		it('puts failed checks and unresolved comments in the session from the right of their tabs', async function () {
			const stubs: { fixChecks?: SinonStub; addressComments?: SinonStub } = {};
			let finishFixChecks = () => { };
			const { out, tabs } = renderTabbedOverview(agentsPullRequestWith({
				status: { state: CheckState.Failure, statuses: [failedCheckRun] },
				events: [reviewEvent([{}])],
			}), context => {
				stubs.fixChecks = sinon.stub(context, 'fixChecksInSession').returns(new Promise<void>(resolve => { finishFixChecks = resolve; }));
				stubs.addressComments = sinon.stub(context, 'addressCommentsInSession').resolves();
			});
			const [timelineTab, checksTab] = tabs;

			assert.deepStrictEqual(sessionActionsByTab(out.container, tabs), {
				'Checks/Merge': 'Fix Checks in Session',
				'Timeline': 'Address Comments in Session',
				'Metadata': null,
			});
			// In the bar with the tabs, but not in the tab list, which only has tabs.
			const actions = [...out.container.querySelectorAll('.overview-session-action')];
			assert.deepStrictEqual(actions.map(action => action.parentElement?.className), ['overview-tab-bar', 'overview-tab-bar']);
			assert.strictEqual(out.container.querySelector('[role="tablist"] .overview-session-action, [role="tabpanel"] .overview-session-action'), null);

			fireEvent.click(checksTab);
			const fixChecks = visibleSessionAction(out.container);
			assert(fixChecks);
			fireEvent.click(fixChecks);
			fireEvent.click(timelineTab);
			const addressComments = visibleSessionAction(out.container);
			assert(addressComments);
			fireEvent.click(addressComments);
			await wait(() => assert(stubs.fixChecks?.calledOnce && stubs.addressComments?.calledOnce));

			// A running action stays disabled when its tab is selected again.
			fireEvent.click(checksTab);
			assert.strictEqual(visibleSessionAction(out.container), fixChecks);
			assert.strictEqual(fixChecks.disabled, true);
			finishFixChecks();
			await wait(() => assert.strictEqual(fixChecks.disabled, false));
		});

		it('only offers the session actions for failed checks and posted unresolved comments of open pull requests', function () {
			const none = { 'Checks/Merge': null, 'Timeline': null, 'Metadata': null };
			const cases: [string, Partial<PullRequest>][] = [
				['no failures or threads', {
					status: { state: CheckState.Success, statuses: [{ ...failedCheckRun, state: CheckState.Success }] },
					events: [reviewEvent([{ threadId: undefined, isResolved: undefined }])],
				}],
				['resolved and draft comments', {
					events: [reviewEvent([{ isResolved: true }, { isDraft: true }])],
				}],
				['closed', {
					state: GithubItemStateEnum.Closed,
					status: { state: CheckState.Failure, statuses: [failedCheckRun] },
					events: [reviewEvent([{}])],
				}],
			];
			for (const [description, overrides] of cases) {
				const { out, tabs } = renderTabbedOverview(agentsPullRequestWith(overrides));
				assert.deepStrictEqual(sessionActionsByTab(out.container, tabs), none, description);
				cleanup();
			}
		});

		it('splits the overview into timeline, checks, and metadata tabs', function () {
			const { out, tabs, selectedTab, visiblePanels } = renderTabbedOverview();

			assert.deepStrictEqual(tabs.map(tab => tab.textContent), ['Timeline', 'Checks/Merge', 'Metadata']);
			assert.strictEqual(selectedTab(), 'Timeline');
			assert.deepStrictEqual(visiblePanels().map(panel => panel.id), ['overview-panel-timeline']);
			assert.deepStrictEqual(visiblePanels().map(panel => panel.getAttribute('aria-labelledby')), [tabs[0].id]);
			assert(visiblePanels()[0].querySelector('#description'));
			assert(visiblePanels()[0].querySelector('#comment-form'));

			fireEvent.click(tabs[1]);
			assert.strictEqual(selectedTab(), 'Checks/Merge');
			assert.strictEqual(out.container.querySelectorAll('#status-checks').length, 1);
			assert.deepStrictEqual(visiblePanels().map(panel => panel.id), ['overview-panel-checks']);
			assert(visiblePanels()[0].querySelector('#status-checks .automerge-section'));

			fireEvent.click(tabs[2]);
			assert.strictEqual(selectedTab(), 'Metadata');
			assert(visiblePanels()[0].querySelector('#sidebar #reviewers'));
		});

		it('moves between tabs with the arrow, Home, and End keys', function () {
			const { tabs, selectedTab } = renderTabbedOverview();

			for (const [from, key, expected] of [[0, 'ArrowLeft', 2], [2, 'ArrowRight', 0], [0, 'End', 2], [2, 'Home', 0], [0, 'ArrowRight', 1]] as const) {
				fireEvent.keyDown(tabs[from], { key });
				assert.strictEqual(selectedTab(), tabs[expected].textContent, `${key} from ${tabs[from].textContent}`);
				assert.strictEqual(document.activeElement, tabs[expected]);
				assert.deepStrictEqual(tabs.map(tab => tab.tabIndex), tabs.map((_, index) => index === expected ? 0 : -1));
			}
		});

		it('shows on the checks tab whether the pull request can be merged', function () {
			const tabbedPullRequest = () => new PullRequestBuilder().overviewTabs(true);
			const failedCheck: PullRequestCheckStatus = {
				id: 'build', state: CheckState.Failure, context: 'build', description: null, targetUrl: null, workflowName: undefined,
				event: undefined, url: undefined, avatarUrl: undefined, isRequired: false, isCheckRun: false, databaseId: undefined,
			};
			const cases: [string, PullRequest, string | undefined][] = [
				['mergeable', tabbedPullRequest().build(), 'Ready to merge'],
				['mergeable with a failed check', tabbedPullRequest()
					.status(status => status.state(CheckState.Failure).statuses([failedCheck])).build(), 'Ready to merge'],
				['blocked with a failed check', tabbedPullRequest().mergeable(PullRequestMergeability.NotMergeable)
					.status(status => status.state(CheckState.Failure).statuses([failedCheck])).build(), 'Cannot be merged, checks failed'],
				['conflicting', tabbedPullRequest().mergeable(PullRequestMergeability.Conflict).build(), 'Cannot be merged yet'],
				['draft that can otherwise be merged', tabbedPullRequest().isDraft(true).build(), undefined],
				['draft in a stack that can otherwise be merged', tabbedPullRequest().isDraft(true).number(794).stack({
					position: 2,
					size: 2,
					base: 'main',
					pullRequests: [
						{ position: 1, number: 793, title: 'First Change', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Merged, isDraft: false, mergeable: PullRequestMergeability.Unknown },
						{ position: 2, number: 794, title: 'Second Change', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: true, mergeable: PullRequestMergeability.Mergeable },
					],
				}).build(), undefined],
				['draft blocked by a failed check', tabbedPullRequest().isDraft(true).mergeable(PullRequestMergeability.NotMergeable)
					.status(status => status.state(CheckState.Failure).statuses([failedCheck])).build(), 'Cannot be merged, checks failed'],
				['in a stack with a pull request below that is being checked', tabbedPullRequest().number(794).stack({
					position: 2,
					size: 2,
					base: 'main',
					pullRequests: [
						{ position: 1, number: 793, title: 'First Change', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Unknown },
						{ position: 2, number: 794, title: 'Second Change', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
					],
				}).build(), undefined],
				['being checked', tabbedPullRequest().mergeable(PullRequestMergeability.Unknown).build(), undefined],
				['merged', tabbedPullRequest().state(GithubItemStateEnum.Merged).build(), undefined],
			];
			for (const [description, pr, expected] of cases) {
				const { tabs } = renderTabbedOverview(pr);
				assert.strictEqual(tabs[1].querySelector('.overview-tab-badge')?.getAttribute('aria-label'), expected, description);
				cleanup();
			}
		});

		const reviewComment = (id: number, pullRequestReviewId: number, threadId: string): IComment => ({
			id, pullRequestReviewId, threadId, path: 'file.ts', body: 'Please change this', diffHunk: '', url: '', htmlUrl: '',
			graphNodeId: `comment-${id}`, createdAt: '', user: new AccountBuilder().build(),
		});

		/** A review with one comment in each of its threads. */
		const review = (id: number, state: ReviewStateValue, threads: { [threadId: string]: boolean }): ReviewEvent => ({
			id, event: EventType.Reviewed, submittedAt: '', body: '', htmlUrl: '', user: new AccountBuilder().build(), authorAssociation: 'OWNER', state,
			comments: Object.keys(threads).map((threadId, index) => reviewComment(id * 100 + index, id, threadId)),
			reviewThreads: Object.fromEntries(Object.entries(threads).map(([threadId, isResolved]) =>
				[threadId, { threadId, canResolve: true, canUnresolve: true, isResolved }])),
		});

		const unresolvedCount = (out: RenderResult) => out.container.querySelector('#overview-tab-timeline .overview-tab-count')?.getAttribute('aria-label');

		it('shows the number of unresolved conversations on the timeline tab', function () {
			const cases: [TimelineEvent[], string | undefined][] = [
				// Threads in a pending review have not been published yet.
				[[review(1, 'COMMENTED', { a: false, b: true }), review(2, 'CHANGES_REQUESTED', { c: false }), review(3, 'PENDING', { d: false })], '2 unresolved conversations'],
				[[review(1, 'COMMENTED', { a: false })], '1 unresolved conversation'],
				[[review(1, 'COMMENTED', { a: true })], undefined],
			];
			for (const [events, expected] of cases) {
				const { out, tabs } = renderTabbedOverview(new PullRequestBuilder().overviewTabs(true).events(events).build());
				assert.strictEqual(unresolvedCount(out), expected);
				assert.strictEqual(tabs[0].querySelector('.overview-tab-count')?.textContent, expected?.split(' ')[0]);
				cleanup();
			}
		});

		it('stops counting a conversation once its last comment is deleted', async function () {
			const event = review(1, 'COMMENTED', { a: false, b: false });
			event.comments.push(reviewComment(102, 1, 'b'));
			const pr = new PullRequestBuilder().overviewTabs(true).events([event]).build();
			const context = new PRContext(pr);
			context.setPR(pr);
			sinon.stub(context, 'postMessage').resolves({ deleted: true } satisfies DeleteCommentReply);
			const out = render(
				<PullRequestContext.Provider value={context}>
					<EditorRoot>{(current: PullRequest) => <Overview {...current} />}</EditorRoot>
				</PullRequestContext.Provider>,
			);
			assert.strictEqual(unresolvedCount(out), '2 unresolved conversations');

			// The comments are 100 in conversation a, and 101 and 102 in conversation b.
			await context.deleteComment({ id: 101, pullRequestReviewId: 1 });
			assert.strictEqual(unresolvedCount(out), '2 unresolved conversations');

			await context.deleteComment({ id: 100, pullRequestReviewId: 1 });
			assert.strictEqual(unresolvedCount(out), '1 unresolved conversation');
		});

		it('shows the timeline when asked to scroll to the pending review', function () {
			const { context, out, tabs, selectedTab } = renderTabbedOverview();
			fireEvent.click(tabs[1]);
			const scrollIntoView = sinon.spy();
			HTMLElement.prototype.scrollIntoView = scrollIntoView;
			try {
				act(() => context.handleMessage({ command: 'pr.scrollToPendingReview' }));
			} finally {
				Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
			}

			const textarea = out.container.querySelector(`#${COMMENT_TEXTAREA_ID}`);
			assert.strictEqual(selectedTab(), 'Timeline');
			assert(scrollIntoView.calledOn(textarea));
			assert.strictEqual(document.activeElement, textarea);
		});

		it('shows the stack from the header badge before the link scrolls to it', function () {
			const { out, tabs, selectedTab } = renderTabbedOverview(new PullRequestBuilder().overviewTabs(true).number(794).stack({
				position: 2,
				size: 2,
				base: 'main',
				pullRequests: [
					{ position: 1, number: 793, title: 'First Change', head: 'D1', url: 'https://example.com/793', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
					{ position: 2, number: 794, title: 'Second Change', head: 'D2', url: 'https://example.com/794', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				],
			}).build());
			const stack = out.container.querySelector('#pull-request-stack')!;

			for (const tab of [tabs[0], tabs[2]]) {
				fireEvent.click(tab);
				assert(stack.closest('[hidden]'));

				// VS Code scrolls to the target of a link within the page in a click listener on the window.
				let stackVisibleWhenScrolled: boolean | undefined;
				const scrollToTarget = () => {
					stackVisibleWhenScrolled = !stack.closest('[hidden]');
				};
				window.addEventListener('click', scrollToTarget);
				try {
					// Unlike fireEvent, a user's click is not wrapped in act(), which would only render after the click.
					out.container.querySelector('.stack-badge')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
				} finally {
					window.removeEventListener('click', scrollToTarget);
				}

				assert.strictEqual(selectedTab(), 'Checks/Merge', `from ${tab.textContent}`);
				assert.strictEqual(stackVisibleWhenScrolled, true, `from ${tab.textContent}`);
			}
		});
	});

	it('splits the overview into tabs according to the experimental setting and the window', function () {
		const cases: [isAgentSessionsWorkspace: boolean, overviewTabs: boolean | 'agents', expectTabs: boolean][] = [
			[false, false, false],
			[true, false, false],
			[false, true, true],
			[true, true, true],
			[false, 'agents', false],
			[true, 'agents', true],
		];
		for (const [isAgentSessionsWorkspace, overviewTabs, expectTabs] of cases) {
			const pr = new PullRequestBuilder().isAgentSessionsWorkspace(isAgentSessionsWorkspace).overviewTabs(overviewTabs).build();
			const out = render(
				<PullRequestContext.Provider value={new PRContext(pr)}>
					<Overview {...pr} />
				</PullRequestContext.Provider>,
			);

			const description = `agents window: ${isAgentSessionsWorkspace}, setting: ${overviewTabs}`;
			assert.strictEqual(!!out.container.querySelector('[role="tablist"]'), expectTabs, description);
			assert.strictEqual(!!out.container.querySelector('#main > #status-checks'), !expectTabs, description);
			cleanup();
		}
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

	describe('button progress', function () {
		function renderEditor(pr: PullRequest, stub?: (context: PRContext) => void) {
			const context = new PRContext(pr);
			context.setPR(pr);
			stub?.(context);
			const out = render(
				<PullRequestContext.Provider value={context}>
					<EditorRoot>{(current: PullRequest) => <Overview {...current} />}</EditorRoot>
				</PullRequestContext.Provider>,
			);
			return { context, out };
		}

		/** A published review with one comment in a conversation. */
		const reviewed = (isResolved: boolean): ReviewEvent => ({
			id: 1, event: EventType.Reviewed, submittedAt: '', body: '', htmlUrl: '', user: new AccountBuilder().build(), authorAssociation: 'OWNER', state: 'COMMENTED',
			comments: [{
				id: 100, pullRequestReviewId: 1, threadId: 'thread', path: 'file.ts', body: 'Please change this', diffHunk: '', url: '', htmlUrl: '',
				graphNodeId: 'comment-100', createdAt: '', user: new AccountBuilder().build(), isResolved, canDelete: true,
			}],
			reviewThreads: { thread: { threadId: 'thread', canResolve: true, canUnresolve: true, isResolved } },
		});

		/** React's warnings about updating the state of components that are no longer rendered. */
		const unmountedUpdateWarnings = (consoleError: SinonSpy) => consoleError.getCalls()
			.map(call => String(call.args[0]))
			.filter(message => message.includes('unmounted component'));

		it('says what the comment form submits until the review is submitted', async function () {
			let finish!: (reply: SubmitReviewReply) => void;
			const { context, out } = renderEditor(new PullRequestBuilder().isAuthor(false).pendingCommentText('Looks good').build(), context => {
				sinon.stub(context, 'postMessage').returns(new Promise<SubmitReviewReply>(resolve => { finish = resolve; }));
			});
			const submit = out.container.querySelector<HTMLButtonElement>('#comment-form .split-left')!;

			fireEvent.click(submit);
			assert.strictEqual(submit.textContent, 'Commenting...');
			assert.strictEqual(submit.disabled, true);

			finish({ events: [], reviewedEvent: { ...reviewed(false), comments: [], reviewThreads: {}, body: 'Looks good' } });
			await wait(() => assert.strictEqual(submit.textContent, 'Comment'));
			assert.strictEqual(submit.disabled, false);
			assert.strictEqual(context.pr?.pendingCommentText, '', 'the comment was submitted');
		});

		it('says what a review submitted from the context menu submits until it is submitted', function () {
			const { context, out } = renderEditor(new PullRequestBuilder().isAuthor(false).build());
			const submit = out.container.querySelector<HTMLButtonElement>('#comment-form .split-left')!;

			act(() => {
				context.handleMessage({ command: 'pr.submitting-review', lastReviewType: 'approve' });
			});
			assert.strictEqual(submit.textContent, 'Approving...');
			assert.strictEqual(submit.disabled, true);

			// A failed review clears busy without a reviewed event.
			act(() => {
				context.handleMessage({ command: 'pr.append-review' });
			});
			assert.strictEqual(submit.textContent, 'Approve');
			assert.strictEqual(submit.disabled, false);
		});

		it('keeps a conversation as it is until resolving it is done', async function () {
			let finish!: (events: TimelineEvent[]) => void;
			const { out } = renderEditor(new PullRequestBuilder().events([reviewed(false)]).build(), context => {
				sinon.stub(context, 'postMessage').returns(new Promise<TimelineEvent[]>(resolve => { finish = resolve; }));
			});

			fireEvent.click(out.getByText('Resolve Conversation'));
			assert.strictEqual((out.getByText('Resolving Conversation...') as HTMLButtonElement).disabled, true);
			assert(out.getByText('Hide'), 'the conversation stays expanded while it is resolved');

			finish([reviewed(true)]);
			await wait(() => assert(out.getByText('Show'), 'a resolved conversation is collapsed'));
			assert.strictEqual(out.queryByText('Resolving Conversation...'), null);
		});

		it('keeps a comment when deleting it is cancelled', async function () {
			const { context } = renderEditor(new PullRequestBuilder().events([reviewed(false)]).build(), context => {
				sinon.stub(context, 'postMessage').resolves({ deleted: false } satisfies DeleteCommentReply);
			});

			await context.deleteComment({ id: 100, pullRequestReviewId: 1 });

			const review = context.pr?.events[0];
			assert(review?.event === EventType.Reviewed);
			assert.strictEqual(review.comments.length, 1);
		});

		it('removes a deleted comment without updating its buttons once they are gone', async function () {
			const consoleError = sinon.spy(console, 'error');
			const { out } = renderEditor(new PullRequestBuilder().events([reviewed(false)]).build(), context => {
				sinon.stub(context, 'postMessage').resolves({ deleted: true } satisfies DeleteCommentReply);
			});

			fireEvent.click(out.getByTitle('Delete comment'));

			await wait(() => assert.strictEqual(out.container.querySelector('button[title^="Delet"]'), null));
			assert.deepStrictEqual(unmountedUpdateWarnings(consoleError), []);
		});

		it('shows that the link was copied', async function () {
			const { out } = renderEditor(new PullRequestBuilder().build(), context => {
				sinon.stub(context, 'copyPrLink').resolves();
			});
			const copy = out.container.querySelector<HTMLButtonElement>('.overview-title button[title="Copy Link"]')!;

			fireEvent.click(copy);

			await wait(() => assert.strictEqual(copy.title, 'Copied'));
		});

		it('shows that it is refreshing in the Refresh button', async function () {
			let finish!: () => void;
			const { out } = renderEditor(new PullRequestBuilder().build(), context => {
				sinon.stub(context, 'postMessage').returns(new Promise<void>(resolve => { finish = resolve; }));
			});

			fireEvent.click(out.getByText('Refresh'));
			assert.strictEqual((out.getByText('Refreshing...') as HTMLButtonElement).disabled, true);

			finish();
			await wait(() => assert.strictEqual((out.getByText('Refresh') as HTMLButtonElement).disabled, false));
		});

		it('keeps saying what a review submitted from the context menu submits while the pull request is refreshed', async function () {
			const pr = new PullRequestBuilder().isAuthor(false).build();
			let finishRefresh!: () => void;
			const { context, out } = renderEditor(pr, context => {
				sinon.stub(context, 'postMessage').returns(new Promise<void>(resolve => { finishRefresh = resolve; }));
			});
			const submit = () => out.container.querySelector<HTMLButtonElement>('#comment-form .split-left')!;
			act(() => {
				context.handleMessage({ command: 'pr.submitting-review', lastReviewType: 'approve' });
			});

			fireEvent.click(out.getByText('Refresh'));
			// The extension reloads the pull request before it replies.
			act(() => {
				context.handleMessage({ command: 'pr.initialize', pullrequest: { ...pr } });
			});
			finishRefresh();
			await wait(() => assert.strictEqual((out.getByText('Refresh') as HTMLButtonElement).disabled, false));
			assert.strictEqual(submit().textContent, 'Approving...');
			assert.strictEqual(submit().disabled, true);

			act(() => {
				context.handleMessage({ command: 'pr.append-review' });
			});
			assert.strictEqual(submit().textContent, 'Approve');
			assert.strictEqual(submit().disabled, false);
		});

		it('only shows a pull request in the merge queue when the reply is for it', async function () {
			const pullRequest = (number: number, pendingCommentText: string) => new PullRequestBuilder()
				.number(number)
				.url(`https://github.com/owner/name/pull/${number}`)
				.mergeQueueMethod('merge')
				.pendingCommentText(pendingCommentText)
				.build();
			const first = pullRequest(1, 'First draft');
			const second = pullRequest(2, 'Second draft');
			const entry: MergeQueueEntry = { position: 1, state: MergeQueueState.Queued, url: 'https://github.com/owner/name/queue/main' };
			const enqueued: ((reply: Pick<PullRequest, 'mergeQueueEntry'>) => void)[] = [];
			const context = new PRContext(first);
			context.setPR(first);
			sinon.stub(context, 'postMessage').callsFake(message => message.command === 'pr.enqueue'
				? new Promise(resolve => enqueued.push(resolve))
				: Promise.resolve());
			const out = render(
				<PullRequestContext.Provider value={context}>
					<ActivityBarRoot>{(current: PullRequest) => <ActivityBarOverview {...current} />}</ActivityBarRoot>
				</PullRequestContext.Provider>,
			);
			const draft = () => out.container.querySelector('textarea')!.value;

			// The active pull request changes before the first one is added to the merge queue.
			fireEvent.click(out.getByText('Add to Merge Queue'));
			act(() => {
				context.handleMessage({ command: 'pr.initialize', pullrequest: second });
			});
			enqueued[0]({ mergeQueueEntry: entry });
			await wait(() => assert.strictEqual(out.queryByText('Adding to Merge Queue...'), null));
			assert.strictEqual(context.pr?.number, 2);
			assert.strictEqual(draft(), 'Second draft');
			assert(out.getByText('Add to Merge Queue'));

			fireEvent.click(out.getByText('Add to Merge Queue'));
			enqueued[1]({ mergeQueueEntry: entry });
			await wait(() => assert(out.getByText('Remove from Queue')));
			assert.strictEqual(draft(), 'Second draft');
		});
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

		/**
		 * Shows the page without the recommendation, which is found after the page is shown.
		 * @param titleTop Where the title is in the window before the recommendation is added above it.
		 */
		function renderPageBeforeRecommendation(titleTop = 20) {
			const { stackRecommendation, ...pr } = recommendedPullRequest();
			assert(stackRecommendation);
			const context = new PRContext(pr);
			const page = (current: PullRequest) => <PullRequestContext.Provider value={context}><Overview {...current} /></PullRequestContext.Provider>;
			const out = render(page(pr));
			const title = out.container.querySelector('#title');
			assert(title);
			// JSDOM has no layout. Here, adding the recommendation moves the title down 60px.
			sinon.stub(title, 'getBoundingClientRect').callsFake(() => rectAt(titleTop + (out.container.querySelector('.stack-recommendation') ? 60 : 0)));
			/** Updates the page the way the webview does when the pull request changes. */
			const update = (current: PullRequest) => out.rerender(page(current));
			const showRecommendation = () => update({ ...pr, stackRecommendation });
			return { pr, stackRecommendation, out, title, update, showRecommendation };
		}

		function rectAt(top: number): DOMRect {
			const height = 100;
			return { x: 0, y: top, top, bottom: top + height, left: 0, right: 0, width: 0, height, toJSON() { return this; } };
		}

		// A boolean, so that a failure does not describe the whole DOM.
		const hintShown = (out: { queryByLabelText: (text: string) => HTMLElement | null }) => out.queryByLabelText(HINT) !== null;

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

		it('keeps the page where it is when the recommendation is added above it', function () {
			const { pr, stackRecommendation, out, title, update, showRecommendation } = renderPageBeforeRecommendation();
			const scrollTo = sinon.stub(window, 'scrollTo');

			showRecommendation();

			assert.strictEqual(out.container.querySelector('.stack-recommendation')?.nextElementSibling, title);
			assert.deepStrictEqual(scrollTo.args, [[0, 60]], 'scrolls the recommendation out of view');
			assert.match(document.documentElement.style.minHeight, /\b60px\b/, 'a short page can be scrolled that far');
			assert.strictEqual(hintShown(out), true);

			update({ ...pr, stackRecommendation: { ...stackRecommendation } });
			assert(scrollTo.calledOnce, 'loading the pull request again with the recommendation does not move the page');

			update({ ...pr, stackRecommendation: null });
			assert.strictEqual(document.documentElement.style.minHeight, '');
		});

		it('does not move the page for a recommendation that is shown with it', function () {
			const scrollTo = sinon.stub(window, 'scrollTo');

			const out = renderOverview(recommendedPullRequest());

			assert(out.container.querySelector('.stack-recommendation'));
			assert(scrollTo.notCalled);
			assert.strictEqual(document.documentElement.style.minHeight, '');
			assert.strictEqual(hintShown(out), false);
		});

		it('stops pointing to the recommendation once the page is scrolled', function () {
			let scrollY = 0;
			sinon.stub(window, 'scrollY').get(() => scrollY);
			sinon.stub(window, 'scrollTo').callsFake((_x: number, y: number) => { scrollY = y; });
			const { pr, stackRecommendation, out, update, showRecommendation } = renderPageBeforeRecommendation();
			const scroll = () => act(() => { window.dispatchEvent(new window.Event('scroll')); });

			showRecommendation();
			scroll();
			// React runs the effects of a render before it renders again, as it does when the pull request is updated.
			update({ ...pr, stackRecommendation });

			assert.strictEqual(hintShown(out), true, 'keeping the page where it is does not count as scrolling');
			scrollY += 1;
			scroll();
			assert.strictEqual(hintShown(out), false);
		});

		it('stops pointing to the recommendation when the page is scrolled right after it is added', function () {
			let scrollY = 0;
			sinon.stub(window, 'scrollY').get(() => scrollY);
			sinon.stub(window, 'scrollTo').callsFake((_x: number, y: number) => { scrollY = y; });
			const { pr, stackRecommendation, out, update, showRecommendation } = renderPageBeforeRecommendation();

			showRecommendation();
			// Scrolled before the hint's effects run, so that there is nothing listening for it yet.
			scrollY += 1;
			update({ ...pr, stackRecommendation });

			assert.strictEqual(hintShown(out), false);
		});

		it('does not point to a recommendation added while the page is scrolled past the title', function () {
			const { out, showRecommendation } = renderPageBeforeRecommendation(-150);

			showRecommendation();

			assert(out.container.querySelector('.stack-recommendation'));
			assert.strictEqual(hintShown(out), false);
		});

		it('scrolls up to the recommendation from the hint', function () {
			const { out, showRecommendation } = renderPageBeforeRecommendation();
			showRecommendation();
			const scrollTo = sinon.stub(window, 'scrollTo');

			fireEvent.click(out.getByLabelText(HINT));

			assert.deepStrictEqual(scrollTo.args, [[{ top: 0, behavior: 'smooth' }]]);
			assert(document.activeElement === out.container.querySelector('.stack-recommendation'), 'focus moves to the recommendation');
			assert.strictEqual(hintShown(out), false);
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
