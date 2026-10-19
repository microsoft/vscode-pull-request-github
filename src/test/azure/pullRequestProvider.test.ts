/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Response } from 'cross-fetch';
import { Uri } from 'vscode';
import { AzureClient, PullRequest, ReviewThread } from '../../azure/client';
import { AzurePullRequestProvider } from '../../azure/pullRequestProvider';
import { PendingReviews } from '../../azure/review';
import { GitHubServerType } from '../../common/authentication';
import { DiffSide, SubjectType } from '../../common/comment';
import { GitChangeType } from '../../common/file';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { EventType } from '../../common/timelineEvent';
import { CredentialStore } from '../../github/credentials';
import { GitHubRepository } from '../../github/githubRepository';
import { AccountType, CheckState, PullRequestMergeability, ReviewEventEnum } from '../../github/interface';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockTelemetry } from '../mocks/mockTelemetry';

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
	{ id: 1, status: 1, comments: [{ id: 1, content: 'First thread', author: viewer, publishedDate: pr.creationDate }] },
	{ id: 2, status: 2, comments: [{ id: 1, content: 'Same local id', author: { id: 'other', displayName: 'Other' }, publishedDate: pr.creationDate }],
		threadContext: { filePath: '/file.ts', leftFileStart: { line: 3, offset: 1 }, leftFileEnd: { line: 4, offset: 1 } } },
];

function fixture(handler: (path: string, init: RequestInit, url: URL) => unknown) {
	const calls: { path: string; init: RequestInit; url: URL }[] = [];
	const client = new AzureClient(remote, async () => 'Basic test', async (url, init = {}) => {
		const path = new URL(url).pathname;
		calls.push({ path, init, url: new URL(url) });
		return new Response(JSON.stringify(handler(path, init, new URL(url))), { status: 200 });
	});
	const values = new Map<string, unknown>();
	const reviews = new PendingReviews({
		get<T>(key: string, fallback: T): T { return values.has(key) ? values.get(key) as T : fallback; },
		async update(key, value) { values.set(key, value); },
	});
	return { provider: new AzurePullRequestProvider(client, reviews), calls, reviews };
}

describe('Azure provider for the original application models', () => {
	it('loads original PR models and distinguishes discussions from inline threads without work-item calls', async () => {
		const { provider, calls } = fixture(path => {
			if (path.endsWith('/connectionData')) { return { authenticatedUser: viewer }; }
			if (path.endsWith('/threads')) { return { value: threads }; }
			if (path.endsWith('/iterations')) { return { value: [{ id: 3 }] }; }
			if (path.endsWith('/labels')) { return { value: [{ id: 'label', name: 'bug' }] }; }
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
		assert.strictEqual(snapshot.pullRequest.closingIssues, undefined);
		assert.ok(calls.every(call => !call.path.includes('workitems')));
		assert.strictEqual(snapshot.pullRequest.titleHTML, 'Shared interface');
		assert.strictEqual(snapshot.pullRequest.bodyHTML, '<p>Description</p>\n');
		assert.deepStrictEqual(snapshot.reviewers.map(reviewer => reviewer.state), ['APPROVED', 'CHANGES_REQUESTED']);
		assert.ok(snapshot.discussions.state === 'loaded');
		assert.ok(snapshot.checks.state === 'loaded');
		const discussions = snapshot.discussions.value;
		assert.strictEqual(discussions.threads.length, 1);
		assert.strictEqual(discussions.threads[0].diffSide, DiffSide.LEFT);
		assert.strictEqual(discussions.threads[0].isResolved, true);
		assert.strictEqual(snapshot.checks.value.state, CheckState.Pending);
		assert.strictEqual(discussions.events.length, 2);
		const general = discussions.events.find(event => event.event === EventType.Commented);
		assert.ok(general?.event === EventType.Commented);
		assert.strictEqual(general.threadId, '1');
		assert.notStrictEqual(general.graphNodeId, discussions.threads[0].comments[0].graphNodeId);
		assert.strictEqual(general.canEdit, true);
		assert.strictEqual(discussions.threads[0].comments[0].canEdit, false);
		assert.strictEqual(calls.find(call => call.path.endsWith('/threads'))?.url.searchParams.get('iteration'), '3');
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

		it('keeps essential PR data usable and exposes individual section failures for retry', async () => {
			let fail = true;
			const { provider } = fixture(path => {
				if (path.endsWith('/connectionData')) { return { authenticatedUser: viewer }; }
				if (path.endsWith('/pullrequests/42')) { return pr; }
				if (path.endsWith('/evaluations')) {
					if (fail) { throw new Error('Policies unavailable'); }
					return { value: [] };
				}
				if (path.endsWith('/statuses')) { return { value: [] }; }
				throw new Error('Section unavailable');
			});
			const snapshot = await provider.load(42);
			assert.strictEqual(snapshot.pullRequest.title, pr.title);
			assert.deepStrictEqual(snapshot.checks, { state: 'error', message: 'Policies unavailable' });
			assert.strictEqual(snapshot.discussions.state, 'error');
			assert.strictEqual(snapshot.commits.state, 'error');
			assert.strictEqual(snapshot.labels.state, 'error');
			fail = false;
			assert.strictEqual((await provider.checks(42)).state, CheckState.Unknown);
		});

		it('requests one filtered page rather than eagerly loading every PR', async () => {
			const { provider, calls } = fixture(() => ({ value: Array.from({ length: 30 }, (_, index) => ({ ...pr, pullRequestId: index + 1 })) }));
			const page = await provider.list({ status: 'merged', reviewerId: viewer.id, sourceBranch: 'feature', cursor: 30 });
			assert.strictEqual(page.nextCursor, 60);
			assert.strictEqual(calls.length, 1);
			const query = calls[0].url.searchParams;
			assert.strictEqual(query.get('$skip'), '30');
			assert.strictEqual(query.get('$top'), '30');
			assert.strictEqual(query.get('searchCriteria.status'), 'completed');
			assert.strictEqual(query.get('searchCriteria.reviewerId'), viewer.id);
			assert.strictEqual(query.get('searchCriteria.sourceRefName'), 'refs/heads/feature');
			await assert.rejects(provider.list({ cursor: -1 }), /cursor is invalid/);
			assert.strictEqual(calls.length, 1);
		});

		it('enables and cancels auto-complete without transitioning deferred work items', async () => {
			const { provider, calls } = fixture((path, init) => {
				if (path.endsWith('/connectionData')) { return { authenticatedUser: viewer }; }
				if (init.method === 'PATCH') { return { ...pr, autoCompleteSetBy: viewer }; }
				return pr;
			});
			await provider.setAutoMerge(42, 'squash', 'head', false);
			const enabled = JSON.parse(String(calls.find(call => call.init.method === 'PATCH')?.init.body));
			assert.deepStrictEqual(enabled.autoCompleteSetBy, { id: viewer.id });
			assert.strictEqual(enabled.status, undefined);
			assert.strictEqual(enabled.completionOptions.transitionWorkItems, false);
			await provider.setAutoMerge(42, undefined, 'head', false);
			assert.deepStrictEqual(JSON.parse(String(calls.at(-1)?.init.body)), { autoCompleteSetBy: null });
		});

		it('keeps existing reviewer votes while changing the selected reviewer set', async () => {
			const { provider, calls } = fixture((path, init) => {
				if (path.endsWith('/pullrequests/42') && init.method === 'GET') { return pr; }
				return {};
			});
			await provider.setReviewers(42, [
				{ id: viewer.id, login: viewer.id, url: '', accountType: AccountType.User },
				{ id: 'new', login: 'new', url: '', accountType: AccountType.User },
			]);
			assert.strictEqual(calls.some(call => call.path.endsWith(`/reviewers/${viewer.id}`)), false);
			assert.strictEqual(calls.find(call => call.path.endsWith('/reviewers/other'))?.init.method, 'DELETE');
			assert.deepStrictEqual(JSON.parse(String(calls.find(call => call.path.endsWith('/reviewers/new'))?.init.body)), { vote: 0 });
		});

		it('returns immutable source/target/common-ancestor revisions and normalized file changes', async () => {
			const { provider } = fixture(path => {
				if (path.endsWith('/iterations')) {
					return { value: [{ id: 3, sourceRefCommit: { commitId: 'source' }, targetRefCommit: { commitId: 'target' }, commonRefCommit: { commitId: 'ancestor' } }] };
				}
				if (path.endsWith('/changes')) {
					return { changeEntries: [{ changeTrackingId: 7, changeType: 'rename, edit', item: { path: '/new.ts', objectId: 'blob' }, originalPath: '/old.ts' }] };
				}
				throw new Error(`Unexpected request: ${path}`);
			});
			const revision = await provider.revision(42);
			assert.deepStrictEqual(revision, { iteration: 3, source: 'source', target: 'target', mergeBase: 'ancestor' });
			assert.deepStrictEqual(await provider.changes(42, revision), [{ path: 'new.ts', previousPath: 'old.ts', trackingId: 7, type: GitChangeType.RENAME, objectId: 'blob' }]);
		});

		it('updates the original shared model and timeline without GitHub authentication or transport', async () => {
			let text = 'First version';
			let failSections = false;
			let reads = 0;
			const { provider } = fixture(path => {
				if (path.endsWith('/connectionData')) { return { authenticatedUser: viewer }; }
				if (path.endsWith('/pullrequests/42')) { reads++; return pr; }
				if (path.endsWith('/iterations')) { return { value: [] }; }
				if (failSections) { throw new Error('Section unavailable'); }
				if (path.endsWith('/labels')) { return { value: [{ id: 'label', name: 'keep' }] }; }
				if (path.endsWith('/commits')) { return { value: [{ commitId: 'head', comment: 'Keep this commit' }] }; }
				if (path.endsWith('/threads')) { return { value: [{ ...threads[0], comments: [{ ...threads[0].comments[0], content: text }] }] }; }
				return { value: [] };
			});
			const context = new MockExtensionContext();
			const telemetry = new MockTelemetry();
			const credentials = new CredentialStore(telemetry, context);
			const url = 'https://dev.azure.com/example/Project/_git/Repo';
			const repository = new GitHubRepository(12345, new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.None),
				Uri.file('/workspace/repo'), credentials, telemetry, true, provider);
			try {
				const [model, concurrent] = await Promise.all([
					repository.getPullRequest(42, 'provider-model-test'), repository.getPullRequest(42, 'provider-model-concurrent-test'),
				]);
				assert.ok(model);
				assert.strictEqual(concurrent, model);
				assert.strictEqual(reads, 2);
				assert.strictEqual(model.author.id, viewer.id);
				assert.strictEqual(model.providerSnapshot?.discussions.state, 'loaded');
				assert.throws(() => repository.hub, /GitHub transport is not supported/);
				let changed = 0;
				const listener = model.onDidChange(event => { if (event.timeline) { changed++; } });
				text = 'Edited without adding events';
				const refreshed = await repository.getPullRequest(42, 'provider-model-test');
				assert.strictEqual(refreshed, model);
				const event = model.timelineEvents?.[0];
				assert.ok(event?.event === EventType.Commented);
				assert.strictEqual(event.body, text);
				assert.ok(changed > 0);
				const afterEdit = changed;
				let threadChanges = 0;
				let modelChanges = 0;
				const threadListener = model.onDidChangeReviewThreads(() => threadChanges++);
				const modelListener = model.onDidChange(() => modelChanges++);
				await repository.getPullRequest(42, 'unchanged-provider-model-test');
				assert.strictEqual(changed, afterEdit, 'An unchanged snapshot must not cause refresh loops.');
				assert.strictEqual(threadChanges, 0);
				assert.strictEqual(modelChanges, 0);
				const beforeReads = reads;
				const [reviewThreads, timeline, reviewers] = await Promise.all([
					model.getReviewThreads(), model.getTimelineEvents(), model.getReviewRequests(),
				]);
				assert.strictEqual(reads, beforeReads + 2, 'Concurrent original-model reads share one consistent provider load.');
				assert.deepStrictEqual(reviewThreads, []);
				assert.strictEqual(timeline?.length, 1);
				assert.strictEqual(reviewers.length, 2);
				assert.deepStrictEqual(await model.getMergeability(), { mergeability: PullRequestMergeability.Mergeable });
				assert.strictEqual(modelChanges, 0);
				threadListener.dispose();
				modelListener.dispose();
				failSections = true;
				await repository.getPullRequest(42, 'provider-model-test');
				assert.strictEqual(model.providerSnapshot?.labels.state, 'error');
				assert.strictEqual(model.providerSnapshot?.discussions.state, 'error');
				assert.deepStrictEqual(model.item.labels.map(label => label.name), ['keep']);
				assert.deepStrictEqual(model.item.commits, [{ message: 'Keep this commit' }]);
				assert.strictEqual(model.timelineEvents?.[0], event);
				await assert.rejects(model.getTimelineEvents(), /Section unavailable/);
				const snapshot = model.providerSnapshot;
				assert.ok(snapshot);
				assert.throws(() => model.applyProviderSnapshot({
					...snapshot, pullRequest: { ...model.item, url: `${model.html_url}/other` },
				}), /another pull request/);
				listener.dispose();
				const pending = repository.getPullRequest(42, 'disposed-provider-session-test');
				const rejected = assert.rejects(pending, /repository session changed/);
				repository.dispose();
				await rejected;
			} finally {
				repository.dispose();
				credentials.dispose();
			}
		});

		it('rejects a mixed-source snapshot rather than attaching checks to the wrong revision', async () => {
			let reads = 0;
			const { provider } = fixture(path => {
				if (path.endsWith('/connectionData')) { return { authenticatedUser: viewer }; }
				if (path.endsWith('/pullrequests/42')) {
					return ++reads === 1 ? pr : { ...pr, lastMergeSourceCommit: { commitId: 'pushed' } };
				}
				return { value: [] };
			});
			await assert.rejects(provider.load(42), /changed while it was loading/);
		});

		it('fails explicitly when essential timestamps or revision metadata are missing', async () => {
			for (const data of [{ ...pr, creationDate: 'invalid' }, { ...pr, lastMergeSourceCommit: undefined }]) {
				const { provider } = fixture(path => path.endsWith('/connectionData') ? { authenticatedUser: viewer } : data);
				await assert.rejects(provider.load(42), /timestamp|revisions/);
			}
		});

		it('maps every Azure thread status without granting resolution rights to unknown states', async () => {
			const states = [0, 1, 2, 3, 4, 5, 6];
			const { provider } = fixture(path => {
				if (path.endsWith('/connectionData')) { return { authenticatedUser: viewer }; }
				if (path.endsWith('/iterations')) { return { value: [{ id: 3 }] }; }
				return { value: states.map(status => ({ ...threads[1], id: status + 1, status })) };
			});
			const { threads: mapped } = await provider.discussions(42);
			assert.deepStrictEqual(mapped.map(thread => thread.isResolved), [false, false, true, true, true, true, false]);
			assert.deepStrictEqual(mapped.map(thread => thread.viewerCanResolve), [false, true, false, false, false, false, true]);
			assert.deepStrictEqual(mapped.map(thread => thread.viewerCanUnresolve), [false, false, true, true, true, true, false]);
		});

		it('preserves original tracked ranges and keeps unmappable threads out of current inline positions', async () => {
			const { provider } = fixture(path => {
				if (path.endsWith('/connectionData')) { return { authenticatedUser: viewer }; }
				if (path.endsWith('/iterations')) { return { value: [{ id: 3 }] }; }
				return { value: [
					{ ...threads[1], pullRequestThreadContext: {
						iterationContext: { firstComparingIteration: 0, secondComparingIteration: 1 },
						trackingCriteria: { firstComparingIteration: 0, secondComparingIteration: 3,
							origFilePath: '/old.ts', origLeftFileStart: { line: 1, offset: 1 }, origLeftFileEnd: { line: 2, offset: 1 } },
					} },
					{ ...threads[1], id: 3, threadContext: undefined, pullRequestThreadContext: {
						iterationContext: { firstComparingIteration: 0, secondComparingIteration: 1 },
						trackingCriteria: { firstComparingIteration: 0, secondComparingIteration: 1,
							origFilePath: '/deleted.ts', origRightFileStart: { line: 7, offset: 1 }, origRightFileEnd: { line: 7, offset: 1 } },
					} },
					{ ...threads[1], id: 4, threadContext: { filePath: '/file-level.ts' } },
				] };
			});
			const { threads: mapped, events } = await provider.discussions(42);
			assert.strictEqual(mapped[0].isOutdated, false);
			assert.strictEqual(mapped[0].startLine, 3);
			assert.strictEqual(mapped[0].originalStartLine, 1);
			assert.strictEqual(mapped[1].isOutdated, true);
			assert.strictEqual(mapped[1].path, 'deleted.ts');
			assert.strictEqual(mapped[1].originalStartLine, 7);
			assert.strictEqual(mapped[1].subjectType, SubjectType.LINE);
			assert.strictEqual(mapped[2].subjectType, SubjectType.FILE);
			assert.ok(events.every(event => event.event === EventType.Reviewed));
		});

		it('rejects invalid inline line numbers instead of placing comments on the wrong source line', async () => {
			for (const line of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				const { provider } = fixture(path => {
					if (path.endsWith('/connectionData')) { return { authenticatedUser: viewer }; }
					if (path.endsWith('/iterations')) { return { value: [{ id: 3 }] }; }
					return { value: [{ ...threads[1], threadContext: { filePath: '/bad.ts', rightFileStart: { line, offset: 1 } } }] };
				});
				await assert.rejects(provider.discussions(42), /invalid inline discussion range/);
			}
		});
});
