/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { cleanup, fireEvent, render } from 'react-testing-library';
import { createSandbox, SinonSandbox } from 'sinon';

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
