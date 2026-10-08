/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { act, cleanup, fireEvent, render, wait } from 'react-testing-library';
import { createSandbox, SinonSandbox } from 'sinon';

import { AccountBuilder } from './builder/account';
import { PullRequestBuilder } from './builder/pullRequest';
import { GithubItemStateEnum } from '../../../src/github/interface';
import { IssuePreview, PullRequestPreview } from '../../../src/github/views';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { vscode } from '../../common/message';
import { Root } from '../app';
import { Overview, OverviewPreview } from '../overview';

describe('Root', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	it('displays "loading" while the PR is loading', function () {
		const context = new PRContext();
		const children = sinon.stub();

		assert(!context.pr);

		const out = render(
			<PullRequestContext.Provider value={context}>
				<Root>{children}</Root>
			</PullRequestContext.Provider>,
		);

		assert(out.queryByText('Loading...'));
		assert(!children.called);
	});

	it('renders preview HTML without exposing actions or persisting an incomplete PR', async function () {
		const context = new PRContext();
		const persist = sinon.stub(vscode, 'setState');
		const postMessage = sinon.stub(context, 'postMessage').resolves();
		const children = sinon.stub().returns(<div>Complete overview</div>);
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Root>{children}</Root>
			</PullRequestContext.Provider>,
		);
		const preview: PullRequestPreview = {
			number: 1347, title: 'Early title', titleHTML: '<strong>Early title</strong>',
			body: 'Early description', bodyHTML: '<p>Early description</p>', url: 'https://github.com/owner/repo/pull/1347',
			author: new AccountBuilder().build(), createdAt: '2026-10-01T10:00:00Z',
			state: GithubItemStateEnum.Open, isDraft: true, base: 'owner/repo:main', head: 'contributor/repo:feature',
		};

		act(() => context.handleMessage({ command: 'pr.preview', pullrequest: preview }));
		await wait(() => assert(out.queryByText('Early title'), out.container.innerHTML));
		assert(out.queryByText('Early description'));
		assert(out.container.querySelector('strong'));
		assert(out.queryByText('Draft'));
		assert(out.queryByText('owner/repo:main'));
		assert(out.queryByText('contributor/repo:feature'));
		assert(out.container.querySelector('#description .review-comment-header .author-link'));
		assert(out.container.querySelector('#description .comment-container .comment-body'));
		assert.strictEqual(out.container.querySelector('.loading-indicator'), null);
		assert.strictEqual(out.container.querySelector('button'), null);
		assert.strictEqual(context.pr, undefined);
		sinon.assert.notCalled(children);
		sinon.assert.notCalled(persist);
		postMessage.resetHistory();
		assert.strictEqual(fireEvent.click(out.container.querySelector('.overview-title a')!), false);
		sinon.assert.calledOnce(postMessage);
		assert.deepStrictEqual(postMessage.firstCall.args[0], { command: 'pr.openOnGitHub', args: { url: preview.url } });

		act(() => context.handleMessage({ command: 'pr.clear' }));
		assert.strictEqual(out.queryByText('Early title'), null);
		assert.strictEqual(context.preview, undefined);

		const pr = new PullRequestBuilder().build();
		act(() => {
			context.handleMessage({ command: 'pr.initialize', pullrequest: pr });
			context.handleMessage({ command: 'pr.preview', pullrequest: preview });
		});
		assert(out.queryByText('Complete overview'));
		assert.strictEqual(out.queryByText('Early title'), null);
		assert.strictEqual(context.pr, pr);
		assert.strictEqual(context.preview, undefined);
		sinon.assert.calledOnce(persist);
	});

	it('renders an issue preview without pull request fields', async function () {
		const context = new PRContext();
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Root>{() => <div>Complete overview</div>}</Root>
			</PullRequestContext.Provider>,
		);
		const preview: IssuePreview = {
			number: 1347, title: 'Early issue title', titleHTML: 'Early issue title',
			body: 'Early issue description', bodyHTML: '<p>Early issue description</p>', url: 'https://github.com/owner/repo/issues/1347',
			author: new AccountBuilder().build(), createdAt: '2026-10-01T10:00:00Z',
			state: GithubItemStateEnum.Open, isIssue: true,
		};

		act(() => context.handleMessage({ command: 'pr.preview', pullrequest: preview }));
		await wait(() => assert(out.queryByText('Early issue title'), out.container.innerHTML));
		assert(out.queryByText('Early issue description'));
		assert(out.queryByText('Open'));
		assert.strictEqual(out.container.querySelector('#preview-reviewers'), null);
		assert(out.container.querySelector('#preview-assignees'));
		assert.strictEqual(out.queryByText('owner/repo:main'), null);
	});

	it('renders cached issue preview text when HTML is unavailable without treating it as markup', async function () {
		const context = new PRContext();
		const persist = sinon.stub(vscode, 'setState');
		const children = sinon.stub();
		const out = render(
			<PullRequestContext.Provider value={context}>
				<Root>{children}</Root>
			</PullRequestContext.Provider>,
		);
		const preview: IssuePreview = {
			number: 1347, title: 'Cached issue', titleHTML: 'Cached issue',
			body: 'Cached description\n<em>Not rendered as HTML</em>', url: 'https://github.com/owner/repo/issues/1347',
			author: new AccountBuilder().build(), createdAt: '2026-10-01T10:00:00Z',
			state: GithubItemStateEnum.Open, isIssue: true,
		};

		act(() => context.handleMessage({ command: 'pr.preview', pullrequest: preview }));
		await wait(() => assert(out.queryByText('Cached issue'), out.container.innerHTML));
		assert.strictEqual(out.container.querySelector('#description .comment-body')?.textContent, preview.body);
		assert.strictEqual(out.container.querySelector('#description em'), null);
		assert.strictEqual(out.container.querySelector('button'), null);
		assert.strictEqual(context.pr, undefined);
		sinon.assert.notCalled(children);
		sinon.assert.notCalled(persist);
	});

	it('uses the final title, subtitle and description markup in the preview', function () {
		const pr = new PullRequestBuilder().canEdit(false).isAuthor(false).build();
		const context = new PRContext(pr);
		const out = render(
			<PullRequestContext.Provider value={context}>
				<OverviewPreview {...pr} />
			</PullRequestContext.Provider>,
		);
		const selectors = ['.overview-title h2', '.subtitle', '#description .review-comment-header', '#description .comment-body'];
		const previewMarkup = selectors.map(selector => out.container.querySelector(selector)!.outerHTML);

		out.rerender(
			<PullRequestContext.Provider value={context}>
				<Overview {...pr} />
			</PullRequestContext.Provider>,
		);
		out.container.querySelector('.overview-title h2 a')!.removeAttribute('data-vscode-context');
		assert.deepStrictEqual(selectors.map(selector => out.container.querySelector(selector)!.outerHTML), previewMarkup);
	});

	it('uses a collapsed metadata placeholder in a narrow preview', function () {
		const media = window.matchMedia('(max-width: 768px)');
		sinon.stub(window, 'matchMedia').returns({ ...media, matches: true, addEventListener() { }, removeEventListener() { } });
		const out = render(<OverviewPreview {...new PullRequestBuilder().build()} />);
		assert(out.container.querySelector('.collapsible-sidebar'));
		assert.strictEqual(out.container.querySelector('#sidebar'), null);
		assert.strictEqual(out.container.querySelector('[role="button"]'), null);
	});

	it('renders its child prop with a pull request from the context', function () {
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);
		const children = sinon.stub().returns(<div />);

		render(
			<PullRequestContext.Provider value={context}>
				<Root>{children}</Root>
			</PullRequestContext.Provider>,
		);

		assert(children.calledWith(pr));
	});
});
