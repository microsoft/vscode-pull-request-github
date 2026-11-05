/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as React from 'react';
import { act, cleanup, fireEvent, render, wait } from 'react-testing-library';

import { PullRequestBuilder } from './builder/pullRequest';
import { EventType, ReviewEvent } from '../../../src/common/timelineEvent';
import { PullRequest } from '../../../src/github/views';
import { PRContext, default as PullRequestContext } from '../../common/context';
import { vscode } from '../../common/message';
import { AddComment, AddCommentSimple } from '../../components/comment';
import { Timeline } from '../../components/timeline';
import { Root } from '../app';

const forms: { name: string, render: (pr: PullRequest) => React.ReactElement }[] = [
	{ name: 'overview comment', render: pr => <AddComment {...pr} /> },
	{ name: 'sidebar comment', render: pr => <AddCommentSimple {...pr} /> },
	{ name: 'review summary', render: pr => <Timeline events={pr.events} isIssue={pr.isIssue} /> },
];

describe('Attestation checkbox', function () {
	afterEach(function () {
		cleanup();
		vscode.setState(undefined);
	});

	for (const form of forms) {
		it(`unchecks the ${form.name} checkbox only after a review is submitted`, async function () {
			const pr = new PullRequestBuilder()
				.isAuthor(false)
				.hasReviewDraft(true)
				.build();
			pr.attestationCommitsEnabled = true;
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
			const view = render(
				<PullRequestContext.Provider value={context}>
					<Root>{form.render}</Root>
				</PullRequestContext.Provider>,
			);
			const checkbox = view.getByLabelText('Add attestation') as HTMLInputElement;

			fireEvent.click(checkbox);
			await wait(() => assert.strictEqual(checkbox.checked, true));
			assert.strictEqual(context.pr?.pendingAttestation, true);

			// A failed attestation or review clears busy without a reviewed event.
			act(() => {
				context.handleMessage({ command: 'pr.submitting-review', lastReviewType: 'approve' });
				context.handleMessage({ command: 'pr.append-review' });
			});
			assert.strictEqual(checkbox.checked, true);
			assert.strictEqual(context.pr?.busy, false);

			act(() => {
				context.handleMessage({ command: 'pr.submitting-review', lastReviewType: 'approve' });
				context.handleMessage({
					command: 'pr.append-review',
					events: [],
					reviewedEvent: { ...pendingReview, id: 2, state: 'APPROVED' },
				});
			});
			assert.strictEqual(checkbox.checked, false);
			assert.strictEqual(context.pr?.pendingAttestation, false);
		});
	}
});
