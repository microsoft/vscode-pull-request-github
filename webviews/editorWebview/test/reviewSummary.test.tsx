/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { act, cleanup, fireEvent, render } from 'react-testing-library';

import { EventType, ReviewEvent } from '../../../src/common/timelineEvent';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { MessageHandler, vscode } from '../../common/message';
import { Timeline } from '../../components/timeline';
import { PullRequestBuilder } from './builder/pullRequest';

const ReviewSummaryView = ({ context }: { context: PRContext }) => {
	const [pr, setPR] = React.useState(context.pr);
	React.useEffect(() => {
		context.onchange = setPR;
		return () => {
			context.onchange = null;
		};
	}, [context]);

	return pr ? (
		<PullRequestContext.Provider value={context}>
			<Timeline events={pr.events} isIssue={pr.isIssue} />
		</PullRequestContext.Provider>
	) : null;
};

describe('Review summary', function () {
	afterEach(function () {
		cleanup();
		vscode.setState(undefined);
	});

	it('preserves the draft through refresh and remount without changing the main comment', function () {
		const pr = new PullRequestBuilder()
			.number(3931)
			.isAuthor(false)
			.hasReviewDraft(true)
			.pendingCommentText('main comment')
			.build();
		const pendingReview: ReviewEvent = {
			id: 1,
			event: EventType.Reviewed,
			comments: [],
			submittedAt: '',
			body: '',
			htmlUrl: '',
			user: pr.author,
			authorAssociation: 'OWNER',
			state: 'PENDING',
		};
		pr.events = [pendingReview];

		const context = new PRContext(pr);
		context.setPR(pr);
		const view = render(<ReviewSummaryView context={context} />);
		const summary = view.getByPlaceholderText('Leave a review summary comment') as HTMLTextAreaElement;

		fireEvent.change(summary, { target: { value: 'Keep this review summary' } });

		assert.strictEqual(context.pr?.pendingReviewSummaryText, 'Keep this review summary');
		assert.strictEqual(context.pr?.pendingCommentText, 'main comment');

		act(() => {
			context.setPR({
				...pr,
				events: [{ ...pendingReview }],
				pendingReviewSummaryText: undefined,
			});
		});
		view.unmount();

		const restoredContext = new PRContext();
		const restoredView = render(<ReviewSummaryView context={restoredContext} />);
		const restoredSummary = restoredView.getByPlaceholderText('Leave a review summary comment') as HTMLTextAreaElement;

		assert.strictEqual(restoredSummary.value, 'Keep this review summary');
		assert.strictEqual(restoredContext.pr?.pendingCommentText, 'main comment');

		act(() => {
			restoredContext.handleMessage({
				command: 'pr.append-review',
				events: [],
				reviewedEvent: { ...pendingReview, state: 'COMMENTED' },
			});
		});

		assert.strictEqual(restoredContext.pr?.pendingReviewSummaryText, '');
	});

	it('clears the draft when the pending review is cancelled', async function () {
		const pr = new PullRequestBuilder()
			.number(3931)
			.pendingReviewSummaryText('Discard this review summary')
			.build();
		const pendingReview: ReviewEvent = {
			id: 1,
			event: EventType.Reviewed,
			comments: [],
			submittedAt: '',
			body: '',
			htmlUrl: '',
			user: pr.author,
			authorAssociation: 'OWNER',
			state: 'PENDING',
		};
		pr.events = [pendingReview];
		const context = new PRContext(pr, null, {
			postMessage: async () => ({ deletedReviewId: pendingReview.id }),
		} as unknown as MessageHandler);
		context.setPR(pr);

		await context.deleteReview();

		assert.strictEqual(context.pr?.pendingReviewSummaryText, '');
	});
});
