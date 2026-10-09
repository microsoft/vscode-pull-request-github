/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { AddComment, CommentPreview, CommentView } from './comment';
import { GithubItemStateEnum } from '../../src/github/interface';
import { PullRequest, ReviewType } from '../../src/github/views';
import { createComment, createPullRequest, createReview } from '../fixtures/data';
import { clickFixtureElement, defineComponentFixture, defineFixtureGroup, defineThemeVariants } from '../fixtures/fixtureUtils';

function composerFixture(overrides: () => Partial<PullRequest>, width = 720) {
	return defineComponentFixture({
		width,
		createPullRequest: () => createPullRequest(overrides()),
		render: pr => <AddComment {...pr} />,
	});
}

function renderRichMarkdown() {
	return <CommentView comment={createComment({
		body: 'Release checklist and code sample',
		bodyHTML: '<h3>Release checklist</h3><blockquote>Keep keyboard focus visible.</blockquote><ul><li>Support narrow layouts</li><li>Add regression tests</li></ul><pre><code>const ready = checks.every(check =&gt; check.passed);</code></pre><table><thead><tr><th>Platform</th><th>Result</th></tr></thead><tbody><tr><td>Windows</td><td>Passed</td></tr><tr><td>Linux</td><td>Passed</td></tr></tbody></table>',
	})} />;
}

const comments = defineFixtureGroup({
	Plain: defineComponentFixture({ render: () => <CommentView comment={createComment()} /> }),
	EmptyDescription: defineComponentFixture({
		createPullRequest: () => createPullRequest({ body: '', bodyHTML: '' }),
		render: pr => <CommentView isPRDescription comment={pr} />,
	}),
	RichMarkdown: defineThemeVariants(defaultTheme => defineComponentFixture({
		defaultTheme,
		render: renderRichMarkdown,
	})),
	Reactions: defineComponentFixture({
		render: () => <CommentView comment={createComment({ reactions: [
			{ label: '\u{1f44d}', count: 3, viewerHasReacted: true, reactors: ['alice', 'bob', 'octocat'] },
			{ label: '\u{1f389}', count: 1, viewerHasReacted: false, reactors: ['reviewer'] },
		] })} />,
	}),
	EditingDraft: defineComponentFixture({
		createPullRequest: () => createPullRequest({ pendingCommentDrafts: { 301: 'Saved draft: please keep focus on the selected pull request.' } }),
		render: () => <CommentView comment={createComment()} headerInEditMode />,
	}),
	ActionToolbar: defineComponentFixture({
		render: () => <CommentView comment={createComment()} />,
		prepare: container => {
			const authorLink = container.querySelector<HTMLAnchorElement>('.review-comment-header a');
			if (!authorLink) {
				throw new Error('Comment author link missing');
			}
			authorLink.focus();
		},
	}),
	Approval: defineComponentFixture({ render: () => <CommentView comment={createReview('APPROVED')} /> }),
	RequestedChanges: defineComponentFixture({
		render: () => <CommentView comment={createReview('CHANGES_REQUESTED', { body: 'Please test focus restoration.', bodyHTML: '<p>Please test focus restoration.</p>' })} />,
	}),
	LoadingPreview: defineComponentFixture({ render: pr => <CommentPreview {...pr} /> }),
	QuoteReply: defineComponentFixture({
		createPullRequest: () => createPullRequest({ isAuthor: false }),
		render: pr => <><CommentView comment={createComment()} /><AddComment {...pr} /></>,
		prepare: async container => {
			await clickFixtureElement('button[title="Quote reply"]')(container);
			const textarea = container.querySelector<HTMLTextAreaElement>('#comment-form textarea');
			if (textarea?.value !== `> ${createComment().body} \n\n`) {
				throw new Error('Quote reply did not populate the comment composer');
			}
		},
	}),
});

const composer = defineFixtureGroup({
	EmptyAuthor: composerFixture(() => ({})),
	ReviewerDraft: composerFixture(() => ({ isAuthor: false, pendingCommentText: 'Looks good! The keyboard tests cover the regression.' })),
	Approve: composerFixture(() => ({ isAuthor: false, lastReviewType: ReviewType.Approve })),
	RequestChanges: composerFixture(() => ({ isAuthor: false, lastReviewType: ReviewType.RequestChanges, pendingCommentText: 'Please add a test for an empty stack.' })),
	Busy: composerFixture(() => ({ busy: true, pendingCommentText: 'Submitting this review...' })),
	ClosedIssue: composerFixture(() => ({ isIssue: true, state: GithubItemStateEnum.Closed })),
	ContinueOnGitHub: composerFixture(() => ({ isAuthor: false, continueOnGitHub: true })),
	Attestation: composerFixture(() => ({ isAuthor: false, attestationCommitsEnabled: true, isCurrentlyCheckedOut: true, lastReviewType: ReviewType.Approve })),
	Narrow: composerFixture(() => ({ isAuthor: false, pendingCommentText: 'Review from a narrow panel.' }), 360),
});

export default defineFixtureGroup({ path: 'Components/Comments' }, {
	Display: comments,
	Composer: composer,
});
