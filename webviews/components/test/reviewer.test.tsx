/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { cleanup, render } from 'react-testing-library';
import { createSandbox, SinonSandbox } from 'sinon';

import { PRContext } from '../../common/context';
import { Reviewer } from '../reviewer';
import { PullRequestBuilder } from '../../editorWebview/test/builder/pullRequest';
import { AccountBuilder } from '../../editorWebview/test/builder/account';
import { ReviewState, AccountType } from '../../../src/github/interface';

describe('Reviewer', function () {
	let sinon: SinonSandbox;

	beforeEach(function () {
		sinon = createSandbox();
	});

	afterEach(function () {
		cleanup();
		sinon.restore();
	});

	it('displays reviewer with REQUESTED state', function () {
		const reviewer = new AccountBuilder()
			.login('reviewer1')
			.name('Reviewer One')
			.avatarUrl('https://example.com/avatar1.png')
			.build();

		const reviewState: ReviewState = { reviewer, state: 'REQUESTED' };
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);

		const out = render(
			<PRContext.Provider value={context}>
				<Reviewer reviewState={reviewState} />
			</PRContext.Provider>
		);

		// Check that reviewer name is displayed
		assert(out.queryByText('Reviewer One'), 'Should display reviewer name');

		// Check that the requested icon is displayed (no re-request button)
		const reRequestButton = out.container.querySelector('button[title="Re-request review"]');
		assert(!reRequestButton, 'Should not show re-request button for REQUESTED state');
	});

	it('displays reviewer with APPROVED state', function () {
		const reviewer = new AccountBuilder()
			.login('reviewer1')
			.name('Reviewer One')
			.avatarUrl('https://example.com/avatar1.png')
			.build();

		const reviewState: ReviewState = { reviewer, state: 'APPROVED' };
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);

		const out = render(
			<PRContext.Provider value={context}>
				<Reviewer reviewState={reviewState} />
			</PRContext.Provider>
		);

		// Check that reviewer name is displayed
		assert(out.queryByText('Reviewer One'), 'Should display reviewer name');

		// Check that the re-request button is available for non-REQUESTED state
		const reRequestButton = out.container.querySelector('button[title="Re-request review"]');
		assert(reRequestButton, 'Should show re-request button for APPROVED state');
	});

	it('displays reviewer with CHANGES_REQUESTED state', function () {
		const reviewer = new AccountBuilder()
			.login('reviewer1')
			.name('Reviewer One')
			.avatarUrl('https://example.com/avatar1.png')
			.build();

		const reviewState: ReviewState = { reviewer, state: 'CHANGES_REQUESTED' };
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);

		const out = render(
			<PRContext.Provider value={context}>
				<Reviewer reviewState={reviewState} />
			</PRContext.Provider>
		);

		// Check that reviewer name is displayed
		assert(out.queryByText('Reviewer One'), 'Should display reviewer name');

		// Check that the re-request button is available
		const reRequestButton = out.container.querySelector('button[title="Re-request review"]');
		assert(reRequestButton, 'Should show re-request button for CHANGES_REQUESTED state');
	});

	it('displays reviewer with COMMENTED state', function () {
		const reviewer = new AccountBuilder()
			.login('reviewer1')
			.name('Reviewer One')
			.avatarUrl('https://example.com/avatar1.png')
			.build();

		const reviewState: ReviewState = { reviewer, state: 'COMMENTED' };
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);

		const out = render(
			<PRContext.Provider value={context}>
				<Reviewer reviewState={reviewState} />
			</PRContext.Provider>
		);

		// Check that reviewer name is displayed
		assert(out.queryByText('Reviewer One'), 'Should display reviewer name');

		// Check that the re-request button is available
		const reRequestButton = out.container.querySelector('button[title="Re-request review"]');
		assert(reRequestButton, 'Should show re-request button for COMMENTED state');
	});

	it('does not show re-request button for bot reviewers', function () {
		const botReviewer = new AccountBuilder()
			.login('bot')
			.name('Bot Reviewer')
			.avatarUrl('https://example.com/bot.png')
			.accountType(AccountType.Bot)
			.build();

		const reviewState: ReviewState = { reviewer: botReviewer, state: 'APPROVED' };
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);

		const out = render(
			<PRContext.Provider value={context}>
				<Reviewer reviewState={reviewState} />
			</PRContext.Provider>
		);

		// Check that reviewer name is displayed
		assert(out.queryByText('Bot Reviewer'), 'Should display bot reviewer name');

		// Check that the re-request button is not shown for bots
		const reRequestButton = out.container.querySelector('button[title="Re-request review"]');
		assert(!reRequestButton, 'Should not show re-request button for bot reviewer');
	});

	it('calls reRequestReview when re-request button is clicked', function () {
		const reviewer = new AccountBuilder()
			.login('reviewer1')
			.name('Reviewer One')
			.avatarUrl('https://example.com/avatar1.png')
			.id('123')
			.build();

		const reviewState: ReviewState = { reviewer, state: 'APPROVED' };
		const pr = new PullRequestBuilder().build();
		const context = new PRContext(pr);

		const reRequestReviewStub = sinon.stub();
		context.reRequestReview = reRequestReviewStub;

		const out = render(
			<PRContext.Provider value={context}>
				<Reviewer reviewState={reviewState} />
			</PRContext.Provider>
		);

		// Find and click the re-request button
		const reRequestButton = out.container.querySelector('button[title="Re-request review"]') as HTMLButtonElement;
		assert(reRequestButton, 'Should have re-request button');

		reRequestButton.click();

		// Verify that reRequestReview was called with the correct reviewer id
		assert(reRequestReviewStub.calledWith('123'), 'Should call reRequestReview with reviewer id');
	});
});
