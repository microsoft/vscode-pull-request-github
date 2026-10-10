/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { cleanup, fireEvent, render } from 'react-testing-library';

import { PullRequestBuilder } from './builder/pullRequest';
import { CommentEvent, EventType } from '../../../src/common/timelineEvent';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { CommentView } from '../../components/comment';

describe('CommentView', function () {
	afterEach(function () {
		cleanup();
	});

	function makeComment(isMinimized: boolean): CommentEvent {
		return {
			id: 17,
			graphNodeId: 'comment-node-id',
			htmlUrl: 'https://github.com/octocat/repo/pull/1#issuecomment-17',
			body: 'Comment body text',
			bodyHTML: '<p>Comment body text</p>',
			user: new PullRequestBuilder().build().author,
			event: EventType.Commented,
			createdAt: '2024-01-01T12:00:00Z',
			isMinimized,
			minimizedReason: 'SPAM',
		};
	}

	function renderComment(comment: CommentEvent) {
		const context = new PRContext(new PullRequestBuilder().build());
		return render(
			<PullRequestContext.Provider value={context}>
				<CommentView comment={comment} />
			</PullRequestContext.Provider>,
		);
	}

	it('starts minimized comments collapsed and toggles their content on click', function () {
		const view = renderComment(makeComment(true));
		const container = view.container.querySelector('.minimized-comment-container') as HTMLDivElement;

		assert.strictEqual(container.getAttribute('aria-expanded'), 'false');
		assert(view.getByText('This comment was marked as spam'));
		assert.strictEqual(view.queryByText('Comment body text'), null);

		fireEvent.click(container);
		assert.strictEqual(container.getAttribute('aria-expanded'), 'true');
		assert(view.getByText('Comment body text'));

		fireEvent.click(container);
		assert.strictEqual(container.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(view.queryByText('Comment body text'), null);
	});

	it('renders non-minimized comments without the minimized wrapper', function () {
		const view = renderComment(makeComment(false));

		assert.strictEqual(view.container.querySelector('.minimized-comment-container'), null);
		assert(view.getByText('Comment body text'));
	});
});