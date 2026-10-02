/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { cleanup, fireEvent, render, wait, waitForElement } from 'react-testing-library';
import { createSandbox, SinonSandbox } from 'sinon';

import { GithubItemStateEnum, PullRequestMergeability } from '../../../src/github/interface';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { Overview } from '../overview';
import { PullRequestBuilder } from './builder/pullRequest';

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
		assert(section?.hasAttribute('open'));
		assert(section.textContent?.includes('also merge 1 pull request below it.'));
		assert.deepStrictEqual([...section.querySelectorAll('.stack-entry')].map(entry => entry.querySelector('.stack-entry-details')?.textContent), [
			'Third Change#795 - D3',
			'Second Change#794 - D2',
			'First Change#793 - D1',
		]);
		assert.deepStrictEqual([...section.querySelectorAll('.stack-entry-readiness')].map(entry => [entry.classList[1], entry.getAttribute('aria-label')]), [
			['waiting', 'Draft pull request cannot be merged'],
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

		assert(out.container.querySelector('#pull-request-stack')?.textContent?.includes('2 pull requests in this stack.'));
		assert.deepStrictEqual([...out.container.querySelectorAll('.stack-entry-readiness')].map(entry => entry.getAttribute('aria-label')), [
			'Mergeability is being checked',
			'Closed pull request cannot be merged',
		]);
		assert.strictEqual(out.container.querySelector('.automerge-section'), null);
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
			'Branch is behind its base',
			'Mergeability is being checked',
			'Already merged',
		]);
		assert.strictEqual(out.container.querySelector('.stack-merge'), null);
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
		const pr = new PullRequestBuilder().isAgentSessionsWorkspace(true).build();
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

	it('does not show view changes outside the agents window', function () {
		const pr = new PullRequestBuilder().isAgentSessionsWorkspace(false).build();
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
});
