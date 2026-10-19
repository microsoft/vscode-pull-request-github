/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Response } from 'cross-fetch';
import { AzureClient, PullRequest, ReviewThread } from '../../azure/client';
import { AzurePullRequestProvider } from '../../azure/pullRequestProvider';
import { PendingReviews } from '../../azure/review';
import { DiffSide } from '../../common/comment';
import { CheckState, GithubItemStateEnum, PullRequestMergeability, ReviewEventEnum } from '../../github/interface';

const remote = { organizationUrl: 'https://dev.azure.com/example', project: 'Project', repository: 'Repo' };
const viewer = { id: 'viewer-id', displayName: 'Viewer' };
const pr: PullRequest = {
	pullRequestId: 42, title: 'Shared interface', description: 'Description', status: 'active', isDraft: false,
	createdBy: viewer, sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main',
	reviewers: [{ ...viewer, vote: 10 }, { id: 'other', displayName: 'Other', vote: -10 }],
	lastMergeSourceCommit: { commitId: 'head' }, lastMergeTargetCommit: { commitId: 'base' },
	repository: { id: 'repo-id', name: 'Repo', project: { id: 'project-id', name: 'Project' } },
	creationDate: '2026-10-19T10:00:00Z', mergeStatus: 'succeeded',
};
const threads: ReviewThread[] = [
	{ id: 1, status: 1, comments: [{ id: 1, content: 'First thread', author: viewer }] },
	{ id: 2, status: 2, comments: [{ id: 1, content: 'Same local id', author: { id: 'other', displayName: 'Other' } }],
		threadContext: { filePath: '/file.ts', leftFileStart: { line: 3, offset: 1 }, leftFileEnd: { line: 4, offset: 1 } } },
];

function fixture(handler: (path: string, init: RequestInit) => unknown) {
	const calls: { path: string; init: RequestInit }[] = [];
	const client = new AzureClient(remote, async () => 'Basic test', async (url, init = {}) => {
		const path = new URL(url).pathname;
		calls.push({ path, init });
		return new Response(JSON.stringify(handler(path, init)), { status: 200 });
	});
	const values = new Map<string, unknown>();
	const reviews = new PendingReviews({
		get<T>(key: string, fallback: T): T { return values.has(key) ? values.get(key) as T : fallback; },
		async update(key, value) { values.set(key, value); },
	});
	return { provider: new AzurePullRequestProvider(client, reviews), calls, reviews };
}

describe('Azure provider for the original application models', () => {
	it('loads shared PR, timeline, checks, reviews and work-item models without HTML', async () => {
		const { provider } = fixture(path => {
			if (path.endsWith('/connectionData')) { return { authenticatedUser: viewer }; }
			if (path.endsWith('/threads')) { return { value: threads }; }
			if (path.endsWith('/labels')) { return { value: [{ id: 'label', name: 'bug' }] }; }
			if (path.endsWith('/workitems')) { return { value: [{ id: '7' }] }; }
			if (path.endsWith('/workitems/7')) { return { id: 7, fields: { 'System.Title': 'Linked item', 'System.State': 'Closed' } }; }
			if (path.endsWith('/statuses')) { return { value: [{ id: 9, state: 'succeeded', context: { name: 'Build' } }] }; }
			if (path.endsWith('/evaluations')) { return { value: [{ evaluationId: 'policy', status: 'queued', configuration: { isBlocking: true, type: { displayName: 'Required check' } } }] }; }
			if (path.endsWith('/commits')) { return { value: [{ commitId: 'head', comment: 'Change' }] }; }
			if (path.endsWith('/pullrequests/42')) { return pr; }
			throw new Error(`Unexpected request: ${path}`);
		});
		const snapshot = await provider.load(42);
		assert.strictEqual(snapshot.pullRequest.head?.ref, 'feature');
		assert.strictEqual(snapshot.pullRequest.base?.ref, 'main');
		assert.strictEqual(snapshot.pullRequest.commits.length, 1);
		assert.strictEqual(snapshot.pullRequest.commentCount, 2);
		assert.strictEqual(snapshot.pullRequest.closingIssues?.[0].state, GithubItemStateEnum.Closed);
		assert.strictEqual(snapshot.pullRequest.titleHTML, '');
		assert.strictEqual(snapshot.pullRequest.bodyHTML, undefined);
		assert.deepStrictEqual(snapshot.reviewers.map(reviewer => reviewer.state), ['APPROVED', 'CHANGES_REQUESTED']);
		assert.strictEqual(snapshot.threads[1].diffSide, DiffSide.LEFT);
		assert.strictEqual(snapshot.threads[1].isResolved, true);
		assert.strictEqual(snapshot.checks.state, CheckState.Pending);
		assert.strictEqual(snapshot.events.length, 2);
		assert.notStrictEqual(snapshot.threads[0].comments[0].graphNodeId, snapshot.threads[1].comments[0].graphNodeId);
		assert.strictEqual(snapshot.threads[0].comments[0].canEdit, true);
		assert.strictEqual(snapshot.threads[1].comments[0].canEdit, false);
		assert.strictEqual(provider.capabilities.mergeQueue, false);
		assert.strictEqual(provider.capabilities.attachments, false);
	});

	it('does not edit another author when local comment identifiers overlap', async () => {
		const { provider, calls } = fixture(path => {
			if (path.endsWith('/connectionData')) { return { authenticatedUser: viewer }; }
			if (path.endsWith('/threads')) { return { value: threads }; }
			throw new Error(`Unexpected mutation: ${path}`);
		});
		await assert.rejects(provider.editComment(42, { threadId: '2', commentId: '1' }, 'Changed'), /Only the author/);
		await assert.rejects(provider.deleteComment(42, { threadId: '1/2', commentId: '1' }), /invalid/);
		assert.ok(calls.every(call => call.init.method === 'GET'));
	});

	it('checks source identity before completion and uses the selected merge method', async () => {
		const { provider, calls } = fixture((path, init) => {
			assert.ok(path.endsWith('/pullrequests/42'));
			return init.method === 'PATCH' ? { ...pr, status: 'completed' } : pr;
		});
		await assert.rejects(provider.merge(42, 'squash', 'stale', false), /source changed/);
		assert.strictEqual(calls.length, 1);
		const merged = await provider.merge(42, 'squash', 'head', false);
		assert.strictEqual(merged.merged, true);
		const update = JSON.parse(String(calls[2].init.body));
		assert.strictEqual(update.completionOptions.mergeStrategy, 'squash');
		assert.strictEqual(update.completionOptions.deleteSourceBranch, false);
		assert.strictEqual(update.lastMergeSourceCommit.commitId, 'head');
	});

	it('preserves unknown mergeability rather than allowing a merge', async () => {
		const { provider } = fixture(() => ({ ...pr, mergeStatus: 'future-status' }));
		assert.strictEqual(await provider.mergeability(42), PullRequestMergeability.Unknown);
	});

	it('does not publish or vote when the reviewed source has changed', async () => {
		const { provider, calls } = fixture(() => pr);
		await assert.rejects(provider.submitReview(42, ReviewEventEnum.Approve, 'Summary', 'stale'), /source changed/);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].init.method, 'GET');
	});

	it('retries a failed vote without duplicating the submitted review summary', async () => {
		let failVote = true;
		const { provider, calls } = fixture((path, init) => {
			if (path.endsWith('/connectionData')) { return { authenticatedUser: viewer }; }
			if (path.endsWith('/pullrequests/42')) { return pr; }
			if (path.endsWith('/threads')) {
				if (init.method === 'POST') { return threads[0]; }
				return { value: [] };
			}
			if (path.endsWith('/reviewers/viewer-id')) {
				if (failVote) { throw new Error('Vote unavailable'); }
				return { ...viewer, vote: 10 };
			}
			throw new Error(`Unexpected request: ${path}`);
		});
		await assert.rejects(provider.submitReview(42, ReviewEventEnum.Approve, 'Summary', 'head'), /Vote unavailable/);
		failVote = false;
		await provider.submitReview(42, ReviewEventEnum.Approve, 'Summary', 'head');
		assert.strictEqual(calls.filter(call => call.path.endsWith('/threads') && call.init.method === 'POST').length, 1);
		assert.strictEqual(calls.filter(call => call.init.method === 'PUT').length, 2);
	});

	it('normalizes branch names for the existing creation workflow', async () => {
		const { provider, calls } = fixture(() => pr);
		await provider.create('Title', 'Body', 'feature', 'refs/heads/main', true);
		assert.deepStrictEqual(JSON.parse(String(calls[0].init.body)), {
			title: 'Title', description: 'Body', sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main', isDraft: true,
		});
	});
});
