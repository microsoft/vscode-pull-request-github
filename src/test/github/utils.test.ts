/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { AccountType } from '../../github/interface';
import { getPRFetchQuery, insertNewCommitsSinceReview, sanitizeIssueTitle, variableSubstitution } from '../../github/utils';
import { IssueModel } from '../../github/issueModel';
import { GitHubRef } from '../../common/githubRef';
import { CommitEvent, EventType, ReviewEvent, TimelineEvent } from '../../common/timelineEvent';

describe('utils', () => {

	describe('getPRFetchQuery', () => {
		it('replaces all instances of ${user}', () => {
			const user = 'rmacfarlane';
			const query = 'reviewed-by:${user} -author:${user}';
			const result = getPRFetchQuery(user, query)
			assert.strictEqual(result, 'is:pull-request reviewed-by:rmacfarlane -author:rmacfarlane type:pr');
		});
	});

	describe('sanitizeIssueTitle', () => {
		[
			{ input: 'Issue', expected: 'Issue' },
			{ input: 'Issue A', expected: 'Issue-A' },
			{ input: 'Issue  A', expected: 'Issue-A' },
			{ input: 'Issue     A', expected: 'Issue-A' },
			{ input: 'Issue @ A', expected: 'Issue-A' },
			{ input: "Issue 'A'", expected: 'Issue-A' },
			{ input: 'Issue "A"', expected: 'Issue-A' },
			{ input: '@Issue "A"', expected: 'Issue-A' },
			{ input: 'Issue "A"%', expected: 'Issue-A' },
			{ input: 'Issue .A', expected: 'Issue-A' },
			{ input: 'Issue ,A', expected: 'Issue-A' },
			{ input: 'Issue :A', expected: 'Issue-A' },
			{ input: 'Issue ;A', expected: 'Issue-A' },
			{ input: 'Issue ~A', expected: 'Issue-A' },
			{ input: 'Issue #A', expected: 'Issue-A' },
		].forEach(testCase => {
			it(`Transforms '${testCase.input}' into '${testCase.expected}'`, () => {
				const actual = sanitizeIssueTitle(testCase.input);
				assert.strictEqual(actual, testCase.expected);
			});
		});
	});

	describe('variableSubstitution', () => {
		function makeIssueModel(overrides: { title?: string; number?: number; issueType?: string } = {}): IssueModel {
			const number = overrides.number ?? 42;
			const title = overrides.title ?? 'Some Issue';
			return {
				number,
				title,
				item: {
					issueType: overrides.issueType,
				},
			} as unknown as IssueModel;
		}

		it('replaces ${issueType} with the issue type name', () => {
			const result = variableSubstitution('${issueType}-${issueNumber}', makeIssueModel({ issueType: 'Feature', number: 7 }));
			assert.strictEqual(result, 'Feature-7');
		});

		it('replaces ${sanitizedIssueType} with a branch-safe issue type', () => {
			const result = variableSubstitution('${sanitizedIssueType}-${issueNumber}', makeIssueModel({ issueType: 'Production Bug Fix', number: 7 }));
			assert.strictEqual(result, 'Production-Bug-Fix-7');
		});

		it('replaces ${sanitizedLowercaseIssueType} with a lowercase branch-safe issue type', () => {
			const result = variableSubstitution('${sanitizedLowercaseIssueType}-${issueNumber}', makeIssueModel({ issueType: 'Production Bug Fix', number: 7 }));
			assert.strictEqual(result, 'production-bug-fix-7');
		});

		it('leaves ${issueType} unsubstituted when the issue has no issue type', () => {
			const result = variableSubstitution('${issueType}-${issueNumber}', makeIssueModel({ issueType: undefined, number: 7 }));
			assert.strictEqual(result, '${issueType}-7');
		});
	});

	describe('insertNewCommitsSinceReview', () => {
		const CURRENT_USER = 'octocat';
		const LATEST_REVIEW_SHA = 'shaA';
		const HEAD_SHA = 'shaC';

		function makeHead(sha: string): GitHubRef {
			return new GitHubRef('refs/heads/feature', 'octocat:feature', sha, 'https://github.com/octocat/repo.git', 'octocat', 'repo', false);
		}

		function makeCommit(sha: string, committedDate: Date): CommitEvent {
			return {
				id: sha,
				event: EventType.Committed,
				sha,
				htmlUrl: `https://github.com/octocat/repo/commit/${sha}`,
				message: `commit ${sha}`,
				committedDate,
				author: {
					login: CURRENT_USER,
					id: '1',
					url: 'https://github.com/octocat',
					accountType: AccountType.User,
				},
			};
		}

		function makeReview(submittedAt: string, login: string = CURRENT_USER): ReviewEvent {
			return {
				id: 1,
				event: EventType.Reviewed,
				comments: [],
				submittedAt,
				body: '',
				htmlUrl: '',
				authorAssociation: 'OWNER',
				user: {
					login,
					id: '1',
					url: `https://github.com/${login}`,
					accountType: AccountType.User,
				},
			};
		}

		it('moves a commit pushed AFTER the user\'s review under NewCommitsSinceReview', () => {
			const reviewTime = new Date('2024-01-01T12:00:00Z');
			const events: TimelineEvent[] = [
				makeCommit(LATEST_REVIEW_SHA, new Date('2024-01-01T11:00:00Z')),
				makeReview(reviewTime.toISOString()),
				makeCommit(HEAD_SHA, new Date('2024-01-01T13:00:00Z')),
			];

			insertNewCommitsSinceReview(events, LATEST_REVIEW_SHA, CURRENT_USER, makeHead(HEAD_SHA));

			// Expected order: latest-review commit, review, NewCommitsSinceReview marker, post-review commit
			assert.strictEqual(events.length, 4);
			assert.strictEqual(events[0].event, EventType.Committed);
			assert.strictEqual((events[0] as CommitEvent).sha, LATEST_REVIEW_SHA);
			assert.strictEqual(events[1].event, EventType.Reviewed);
			assert.strictEqual(events[2].event, EventType.NewCommitsSinceReview);
			assert.strictEqual(events[3].event, EventType.Committed);
			assert.strictEqual((events[3] as CommitEvent).sha, HEAD_SHA);
		});

		it('does NOT insert a marker when the only diverging commit was pushed BEFORE the user\'s review (e.g. an attestation commit)', () => {
			const reviewTime = new Date('2024-01-01T12:00:00Z');
			const attestationCommitTime = new Date('2024-01-01T11:59:00Z'); // 1 minute before the review
			const events: TimelineEvent[] = [
				makeCommit(LATEST_REVIEW_SHA, new Date('2024-01-01T10:00:00Z')),
				makeCommit(HEAD_SHA, attestationCommitTime),
				makeReview(reviewTime.toISOString()),
			];

			insertNewCommitsSinceReview(events, LATEST_REVIEW_SHA, CURRENT_USER, makeHead(HEAD_SHA));

			// Expected: no marker is inserted because there are no commits after the review.
			// The pre-review attestation commit stays in its chronological place.
			assert.strictEqual(events.length, 3);
			assert.strictEqual(events[0].event, EventType.Committed);
			assert.strictEqual((events[0] as CommitEvent).sha, LATEST_REVIEW_SHA);
			assert.strictEqual(events[1].event, EventType.Committed);
			assert.strictEqual((events[1] as CommitEvent).sha, HEAD_SHA);
			assert.strictEqual(events[2].event, EventType.Reviewed);
		});

		it('moves only post-review commits when both pre- and post-review commits exist', () => {
			const reviewTime = new Date('2024-01-01T12:00:00Z');
			const preReviewSha = 'shaB';
			const events: TimelineEvent[] = [
				makeCommit(LATEST_REVIEW_SHA, new Date('2024-01-01T10:00:00Z')),
				makeCommit(preReviewSha, new Date('2024-01-01T11:59:00Z')),
				makeReview(reviewTime.toISOString()),
				makeCommit(HEAD_SHA, new Date('2024-01-01T13:00:00Z')),
			];

			insertNewCommitsSinceReview(events, LATEST_REVIEW_SHA, CURRENT_USER, makeHead(HEAD_SHA));

			assert.strictEqual(events.length, 5);
			assert.strictEqual((events[0] as CommitEvent).sha, LATEST_REVIEW_SHA);
			assert.strictEqual((events[1] as CommitEvent).sha, preReviewSha);
			assert.strictEqual(events[2].event, EventType.Reviewed);
			assert.strictEqual(events[3].event, EventType.NewCommitsSinceReview);
			assert.strictEqual((events[4] as CommitEvent).sha, HEAD_SHA);
		});
	});
});