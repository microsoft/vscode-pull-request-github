/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { createSandbox, SinonSandbox } from 'sinon';
import { AccountType, isITeam, reviewerLabel } from '../../github/interface';
import { getPRFetchQuery, insertNewCommitsSinceReview, parseGraphQLIssue, parseCombinedTimelineEvents, sanitizeIssueTitle, variableSubstitution } from '../../github/utils';
import { IssueModel } from '../../github/issueModel';
import { GitHubRef } from '../../common/githubRef';
import { CommitEvent, EventType, ReviewEvent, TimelineEvent } from '../../common/timelineEvent';
import * as GraphQL from '../../github/graphql';
import { GitHubRepository } from '../../github/githubRepository';

describe('utils', () => {

	describe('transformHtmlUrlsToExtensionUrls', () => {
		let sinon: SinonSandbox;

		beforeEach(() => {
			sinon = createSandbox();
			sinon.stub(vscode.env, 'asExternalUri').callsFake(async uri => uri);
		});

		afterEach(() => {
			sinon.restore();
		});

		it('does not add an extra quote to issue links', async () => {
			const githubRepository = {
				remote: {
					gitProtocol: { url: { authority: 'github.com' } },
					owner: 'owner',
					repositoryName: 'repo',
					isEnterprise: false,
				}
			} as any;

			const issue = {
				databaseId: 1,
				id: 'issue-id',
				number: 42,
				url: 'https://github.com/owner/repo/issues/42',
				state: 'OPEN',
				body: 'issue body',
				bodyHTML: '<p><a href="https://github.com/owner/repo/issues/42">issue</a> <a href="https://github.com/owner/repo/pull/7">pull request</a></p>',
				title: 'Issue',
				titleHTML: 'Issue',
				author: null,
				comments: { nodes: [], totalCount: 0 },
				createdAt: '2026-01-01T00:00:00Z',
				updatedAt: '2026-01-01T00:00:00Z',
				labels: { nodes: [] },
				viewerCanUpdate: false,
				reactions: { totalCount: 0 },
				reactionGroups: [],
			} as any;

			const result = await parseGraphQLIssue(issue, githubRepository);
			assert.ok(result.bodyHTML !== undefined);
			const bodyHTML = result.bodyHTML;

			assert.strictEqual((bodyHTML.match(/href="/g) ?? []).length, 2);
			assert.ok(!bodyHTML.includes('""'));
		});
	});

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

	describe('parseCombinedTimelineEvents', () => {
		it('handles commits without an author or committer', async () => {
			const commit = {
				__typename: 'PullRequestCommit',
				id: 'commit-id',
				commit: {
					author: null,
					committer: null,
					oid: 'sha',
					message: 'Commit message',
					committedDate: new Date('2024-01-01T12:00:00Z'),
				},
				url: 'https://github.com/octocat/repo/commit/sha',
			} satisfies GraphQL.Commit;

			const events = await parseCombinedTimelineEvents([commit], [], {} as GitHubRepository);

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0].event, EventType.Committed);
			assert.strictEqual((events[0] as CommitEvent).author.login, '');
		});

		it('handles merged events whose merge ref was deleted', async () => {
			const mergedEvent = {
				__typename: 'MergedEvent',
				id: 'merged-event-id',
				actor: null,
				createdAt: '2024-01-01T12:00:00Z',
				mergeRef: null,
				mergeRefName: 'main',
				commit: {
					oid: 'sha',
					commitUrl: 'https://github.com/octocat/repo/commit/sha',
				},
				url: 'https://github.com/octocat/repo/pull/1',
			} satisfies GraphQL.MergedEvent;

			const events = await parseCombinedTimelineEvents([mergedEvent], [], {} as GitHubRepository);

			assert.strictEqual(events.length, 1);
			assert.strictEqual(events[0].event, EventType.Merged);
			assert.strictEqual(events[0].mergeRef, 'main');
		});

		const githubRepository = { remote: { owner: 'octocat', isEnterprise: false } } as GitHubRepository;
		const actor = {
			__typename: 'User',
			id: 'user-id',
			login: 'octocat',
			avatarUrl: 'https://avatars.githubusercontent.com/u/1',
			url: 'https://github.com/octocat',
		} satisfies GraphQL.Actor;
		const createdAt = '2024-01-01T12:00:00Z';

		it('parses label, milestone, and title events', async () => {
			const events = await parseCombinedTimelineEvents([
				{ __typename: 'LabeledEvent', id: 'labeled', actor, createdAt, label: { name: 'bug', color: 'd73a4a' } } satisfies GraphQL.LabeledEvent,
				{ __typename: 'UnlabeledEvent', id: 'unlabeled', actor, createdAt, label: { name: 'question', color: 'cc317c' } } satisfies GraphQL.UnlabeledEvent,
				{ __typename: 'MilestonedEvent', id: 'milestoned', actor, createdAt, milestoneTitle: 'October' } satisfies GraphQL.MilestonedEvent,
				{ __typename: 'DemilestonedEvent', id: 'demilestoned', actor, createdAt, milestoneTitle: 'September' } satisfies GraphQL.DemilestonedEvent,
				{ __typename: 'RenamedTitleEvent', id: 'renamed', actor, createdAt, previousTitle: 'Old', currentTitle: 'New' } satisfies GraphQL.RenamedTitleEvent,
			], [], githubRepository);

			assert.deepStrictEqual(events.map(event => event.event), [EventType.Labeled, EventType.Unlabeled, EventType.Milestoned, EventType.Demilestoned, EventType.RenamedTitle]);
			const [labeled, unlabeled, milestoned, demilestoned, renamed] = events;
			assert.strictEqual(labeled.event, EventType.Labeled);
			assert.deepStrictEqual(labeled.label, { name: 'bug', color: 'd73a4a', displayName: 'bug' });
			assert.strictEqual(labeled.actor.login, 'octocat');
			assert.strictEqual(unlabeled.event, EventType.Unlabeled);
			assert.strictEqual(unlabeled.label.name, 'question');
			assert.strictEqual(milestoned.event, EventType.Milestoned);
			assert.strictEqual(milestoned.milestoneTitle, 'October');
			assert.strictEqual(demilestoned.event, EventType.Demilestoned);
			assert.strictEqual(demilestoned.milestoneTitle, 'September');
			assert.strictEqual(renamed.event, EventType.RenamedTitle);
			assert.strictEqual(renamed.previousTitle, 'Old');
			assert.strictEqual(renamed.currentTitle, 'New');
		});

		it('parses review requests and skips teams without details', async () => {
			const user = { ...actor, id: 'reviewer-id', login: 'reviewer', name: 'Reviewer', email: '' } satisfies GraphQL.Account;
			const bot = { ...actor, __typename: 'Bot', id: 'BOT_1', login: 'review-bot' } satisfies GraphQL.Actor;
			const team = { id: 'team-id', name: 'Reviewers', slug: 'reviewers', url: 'https://github.com/orgs/octocat/teams/reviewers', avatarUrl: '', repositories: { nodes: [] } } satisfies GraphQL.Team;
			// Teams are only an id when queried without the read:org scope.
			const hiddenTeam = { id: 'hidden-team-id' } satisfies GraphQL.Node;

			const events = await parseCombinedTimelineEvents([
				{ __typename: 'ReviewRequestedEvent', id: 'user', actor, createdAt, requestedReviewer: user } satisfies GraphQL.ReviewRequestedEvent,
				{ __typename: 'ReviewRequestedEvent', id: 'bot', actor, createdAt, requestedReviewer: bot } satisfies GraphQL.ReviewRequestedEvent,
				{ __typename: 'ReviewRequestRemovedEvent', id: 'team', actor, createdAt, requestedReviewer: team } satisfies GraphQL.ReviewRequestRemovedEvent,
				{ __typename: 'ReviewRequestedEvent', id: 'hidden', actor, createdAt, requestedReviewer: hiddenTeam } satisfies GraphQL.ReviewRequestedEvent,
				{ __typename: 'ReviewRequestedEvent', id: 'deleted', actor, createdAt, requestedReviewer: null } satisfies GraphQL.ReviewRequestedEvent,
			], [], githubRepository);

			assert.deepStrictEqual(events.map(event => event.id), ['user', 'bot', 'team']);
			const [userRequest, botRequest, teamRequest] = events;
			assert.strictEqual(userRequest.event, EventType.ReviewRequested);
			assert.strictEqual(reviewerLabel(userRequest.reviewer), 'reviewer');
			assert.strictEqual(botRequest.event, EventType.ReviewRequested);
			assert.strictEqual(reviewerLabel(botRequest.reviewer), 'review-bot');
			assert.strictEqual(teamRequest.event, EventType.ReviewRequestRemoved);
			assert(isITeam(teamRequest.reviewer));
			assert.strictEqual(teamRequest.reviewer.name, 'Reviewers');
			assert.strictEqual(teamRequest.reviewer.org, 'octocat');
		});

		it('parses pull request state events', async () => {
			const events = await parseCombinedTimelineEvents([
				{ __typename: 'ConvertToDraftEvent', id: 'draft', actor, createdAt } satisfies GraphQL.ConvertToDraftEvent,
				{ __typename: 'ReadyForReviewEvent', id: 'ready', actor, createdAt } satisfies GraphQL.ReadyForReviewEvent,
				{
					__typename: 'HeadRefForcePushedEvent', id: 'force-pushed', actor, createdAt,
					pullRequest: { headRefName: 'feature' },
					beforeCommit: null,
					afterCommit: { oid: 'after', commitUrl: 'https://github.com/octocat/repo/commit/after' },
				} satisfies GraphQL.HeadRefForcePushedEvent,
				{ __typename: 'HeadRefRestoredEvent', id: 'restored', actor, createdAt, pullRequest: { headRefName: 'feature' } } satisfies GraphQL.HeadRefRestoredEvent,
				{ __typename: 'ReviewDismissedEvent', id: 'dismissed', actor, createdAt, dismissalMessage: null, review: { author: { ...actor, login: 'reviewer' } } } satisfies GraphQL.ReviewDismissedEvent,
				{ __typename: 'AutoSquashEnabledEvent', id: 'auto-squash', actor, createdAt } satisfies GraphQL.AutoMergeEnabledEvent,
				{ __typename: 'AutoMergeEnabledEvent', id: 'auto-merge', actor, createdAt } satisfies GraphQL.AutoMergeEnabledEvent,
				{ __typename: 'AutoMergeDisabledEvent', id: 'auto-merge-disabled', actor, createdAt, reason: 'Base branch was changed' } satisfies GraphQL.AutoMergeDisabledEvent,
				{ __typename: 'AddedToMergeQueueEvent', id: 'queued', actor, createdAt } satisfies GraphQL.AddedToMergeQueueEvent,
				{ __typename: 'RemovedFromMergeQueueEvent', id: 'dequeued', actor: null, createdAt, reason: null } satisfies GraphQL.RemovedFromMergeQueueEvent,
			], [], githubRepository);

			assert.deepStrictEqual(events.map(event => event.event), [
				EventType.ConvertToDraft,
				EventType.ReadyForReview,
				EventType.HeadRefForcePushed,
				EventType.HeadRefRestored,
				EventType.ReviewDismissed,
				EventType.AutoMergeEnabled,
				EventType.AutoMergeEnabled,
				EventType.AutoMergeDisabled,
				EventType.AddedToMergeQueue,
				EventType.RemovedFromMergeQueue,
			]);
			const [, , forcePushed, restored, dismissed, autoSquash, autoMerge, autoMergeDisabled, , dequeued] = events;
			assert.strictEqual(forcePushed.event, EventType.HeadRefForcePushed);
			assert.strictEqual(forcePushed.headRef, 'feature');
			assert.strictEqual(forcePushed.beforeCommit, undefined);
			assert.deepStrictEqual(forcePushed.afterCommit, { sha: 'after', url: 'https://github.com/octocat/repo/commit/after' });
			assert.strictEqual(restored.event, EventType.HeadRefRestored);
			assert.strictEqual(restored.headRef, 'feature');
			assert.strictEqual(dismissed.event, EventType.ReviewDismissed);
			assert.strictEqual(dismissed.reviewAuthor?.login, 'reviewer');
			assert.strictEqual(dismissed.dismissalMessage, undefined);
			assert.strictEqual(autoSquash.event, EventType.AutoMergeEnabled);
			assert.strictEqual(autoSquash.mergeMethod, 'squash');
			assert.strictEqual(autoMerge.event, EventType.AutoMergeEnabled);
			assert.strictEqual(autoMerge.mergeMethod, undefined);
			assert.strictEqual(autoMergeDisabled.event, EventType.AutoMergeDisabled);
			assert.strictEqual(autoMergeDisabled.reason, 'Base branch was changed');
			assert.strictEqual(dequeued.event, EventType.RemovedFromMergeQueue);
			assert.strictEqual(dequeued.reason, undefined);
			assert.strictEqual(dequeued.actor.login, '');
		});

		it('skips timeline items whose type the query does not select', async () => {
			const events = await parseCombinedTimelineEvents([
				{ __typename: 'LabeledEvent' } satisfies GraphQL.UnselectedTimelineItem,
				{ __typename: 'MilestonedEvent' } satisfies GraphQL.UnselectedTimelineItem,
				{ __typename: 'HeadRefForcePushedEvent' } satisfies GraphQL.UnselectedTimelineItem,
				{ __typename: 'HeadRefRestoredEvent' } satisfies GraphQL.UnselectedTimelineItem,
				{ __typename: 'ClosedEvent', id: 'closed', actor, createdAt } satisfies GraphQL.ClosedEvent,
			], [], githubRepository);

			assert.deepStrictEqual(events.map(event => event.id), ['closed']);
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