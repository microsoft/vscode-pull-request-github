/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CommentEvent, CommitEvent, EventType, ReviewEvent } from '../../src/common/timelineEvent';
import { AccountType, CheckState, GithubItemStateEnum, IAccount, PullRequestCheckStatus, PullRequestMergeability, PullRequestStack, ReviewState } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import { PullRequestBuilder } from '../editorWebview/test/builder/pullRequest';

export const fixtureNow = '2025-01-15T12:00:00Z';

export const avatarUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="20" fill="#5678b8"/><circle cx="20" cy="15" r="7" fill="#fff"/><path d="M7 36a13 13 0 0 1 26 0" fill="#fff"/></svg>')}`;

export function createAccount(login = 'octocat', overrides: Partial<IAccount> = {}): IAccount {
	return { id: `account-${login}`, login, name: login, url: `https://github.com/${login}`, avatarUrl, accountType: AccountType.User, ...overrides };
}

export function createCheck(state: CheckState, overrides: Partial<PullRequestCheckStatus> = {}): PullRequestCheckStatus {
	return {
		id: 'build', databaseId: 42, context: 'Build and test', state, description: 'Continuous integration',
		targetUrl: 'https://github.com/octocat/component-explorer/actions/runs/42',
		url: undefined, avatarUrl, workflowName: 'Continuous integration', event: 'pull_request',
		isRequired: true, isCheckRun: true, ...overrides,
	};
}

export function createReview(state: ReviewState['state'], overrides: Partial<ReviewEvent> = {}): ReviewEvent {
	return {
		id: 201, event: EventType.Reviewed, comments: [], submittedAt: '2025-01-15T11:00:00Z',
		body: 'Keyboard navigation looks good.', bodyHTML: '<p>Keyboard navigation looks good.</p>',
		htmlUrl: 'https://github.com/octocat/component-explorer/pull/102#pullrequestreview-201',
		user: createAccount('reviewer'), authorAssociation: 'MEMBER', state, ...overrides,
	};
}

export function createComment(overrides: Partial<CommentEvent> = {}): CommentEvent {
	return {
		id: 301, graphNodeId: 'comment-301', event: EventType.Commented, user: createAccount('reviewer'),
		body: 'Could we also cover keyboard navigation?', bodyHTML: '<p>Could we also cover <strong>keyboard navigation</strong>?</p>',
		htmlUrl: 'https://github.com/octocat/component-explorer/pull/102#issuecomment-301',
		createdAt: '2025-01-15T11:30:00Z', canEdit: true, canDelete: true, ...overrides,
	};
}

export function createCommit(overrides: Partial<CommitEvent> = {}): CommitEvent {
	return {
		id: 'commit-401', event: EventType.Committed, author: createAccount(),
		sha: '1234567890abcdef1234567890abcdef12345678',
		htmlUrl: 'https://github.com/octocat/component-explorer/commit/1234567',
		message: 'Support keyboard navigation in the stack',
		committedDate: new Date('2025-01-15T10:30:00Z'), status: 'SUCCESS', ...overrides,
	};
}

export function createPullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
	const pr = new PullRequestBuilder()
		.owner('octocat')
		.repo('component-explorer')
		.number(102)
		.title('Add accessible pull request stack navigation')
		.titleHTML('Add accessible pull request stack navigation')
		.url('https://github.com/octocat/component-explorer/pull/102')
		.createdAt('2025-01-15T10:00:00Z')
		.body('Adds keyboard-friendly stack navigation and clearer merge readiness.')
		.bodyHTML('<p>Adds keyboard-friendly stack navigation and clearer merge readiness.</p><ul><li>Keep the current pull request visible</li><li>Explain blocked merge requirements</li></ul>')
		.head('feature/stack-navigation')
		.author(author => author.login('octocat').name('Octocat').avatarUrl(avatarUrl))
		.labels([{ name: 'enhancement', displayName: 'enhancement', color: 'a2eeef' }])
		.status(status => status.state(CheckState.Success).statuses([createCheck(CheckState.Success, { description: 'All checks passed' })]))
		.build();
	return {
		...pr,
		events: [],
		reviewers: [],
		assignees: [{ ...pr.author }],
		reactions: [],
		closingIssues: [],
		mergeMethodsAvailability: { ...pr.mergeMethodsAvailability },
		...overrides,
	};
}

export function createStack(): PullRequestStack {
	return {
		position: 2,
		size: 3,
		base: 'main',
		pullRequests: [
			{ position: 1, number: 101, title: 'Introduce stack metadata', head: 'feature/stack-metadata', url: 'https://github.com/octocat/component-explorer/pull/101', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			{ position: 2, number: 102, title: 'Add accessible pull request stack navigation', head: 'feature/stack-navigation', url: 'https://github.com/octocat/component-explorer/pull/102', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			{ position: 3, number: 103, title: 'Show stack merge readiness', head: 'feature/stack-readiness', url: 'https://github.com/octocat/component-explorer/pull/103', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
		],
	};
}
