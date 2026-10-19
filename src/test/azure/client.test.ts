/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Headers, Response } from 'cross-fetch';
import { createServer } from 'http';
import { createSandbox } from 'sinon';
import { AzureApiError, AzureClient, PullRequest } from '../../azure/client';

const remote = { organizationUrl: 'https://dev.azure.com/example', project: 'My Project', repository: 'My Repo' };
const identity = { id: 'user-id', displayName: 'Example User' };
const pr: PullRequest = {
	pullRequestId: 42, title: 'Example', status: 'active', isDraft: false, createdBy: identity,
	sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main', reviewers: [],
	lastMergeSourceCommit: { commitId: 'source' }, lastMergeTargetCommit: { commitId: 'target' },
	repository: { id: 'repository-id', name: 'My Repo', project: { id: 'project-id', name: 'My Project' } },
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function fixture(responses: Response[]) {
	const calls: { url: URL; init: RequestInit }[] = [];
	const client = new AzureClient(remote, async () => 'Bearer test-token', async (url, init) => {
		calls.push({ url: new URL(url), init: init! });
		const response = responses.shift();
		assert.ok(response, `Unexpected request: ${url}`);
		return response!;
	});
	const body = (index = 0) => JSON.parse(String(calls[index].init.body));
	return { client, calls, body };
}

describe('Azure DevOps REST client', () => {
	it('uses the connection-data preview version on cloud and Server collections', async () => {
		for (const organizationUrl of ['https://dev.azure.com/example', 'https://server.example/tfs/Collection']) {
			const requested: URL[] = [];
			const client = new AzureClient({ ...remote, organizationUrl }, async () => 'Basic test', async url => {
				requested.push(new URL(url));
				return json({ authenticatedUser: identity });
			});
			assert.strictEqual((await client.currentUser()).id, identity.id);
			assert.strictEqual(requested[0].searchParams.get('api-version'), '7.1-preview.1');
		}
	});

	it('retains the policy preview version and artifact on continuation pages', async () => {
		const { client, calls } = fixture([
			json({ value: [] }, 200, { 'x-ms-continuationtoken': 'next' }),
			json({ value: [] }),
		]);
		await client.policies(pr);
		assert.strictEqual(calls.length, 2);
		for (const { url } of calls) {
			assert.strictEqual(url.searchParams.get('api-version'), '7.1-preview.1');
			assert.strictEqual(url.searchParams.get('artifactId'), 'vstfs:///CodeReview/CodeReviewId/project-id/42');
		}
		assert.strictEqual(calls[1].url.searchParams.get('continuationToken'), 'next');
	});

	it('propagates a policy failure rather than showing an empty successful policy set', async () => {
		const { client } = fixture([json({}, 400)]);
		await assert.rejects(client.policies(pr), /HTTP 400/);
	});

	it('exposes immutable changed-file context and rejects unrelated file reads', async () => {
		const sandbox = createSandbox();
		const { client } = fixture([]);
		try {
			sandbox.stub(client, 'pullRequest').resolves(pr);
			sandbox.stub(client, 'threads').resolves([]);
			sandbox.stub(client, 'iterations').resolves([{
				id: 3, sourceRefCommit: { commitId: 'source' }, targetRefCommit: { commitId: 'target' }, commonRefCommit: { commitId: 'base' },
			}]);
			sandbox.stub(client, 'changes').resolves([{ changeTrackingId: 7, changeType: 'rename, edit', item: { path: '/new.ts' }, originalPath: '/old.ts' }]);
			const file = sandbox.stub(client, 'file').resolves('contents');
			const details = await client.reviewDetails(42, '/new.ts');
			assert.strictEqual(details.file?.source, 'contents');
			assert.deepStrictEqual(file.args, [['/old.ts', 'base'], ['/new.ts', 'source']]);
			await assert.rejects(client.reviewDetails(42, '/unrelated.ts'), /changed file/);
			assert.strictEqual(file.callCount, 2);
		} finally {
			sandbox.restore();
		}
	});

	it('uses the production HTTP transport and refuses credential-bearing redirects', async () => {
		const requests: { path: string; authorization?: string }[] = [];
		let redirect = false;
		const server = createServer((request, response) => {
			requests.push({ path: request.url!, authorization: request.headers.authorization });
			if (redirect) {
				response.writeHead(302, { Location: '/redirected' });
				response.end();
			} else {
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify(pr));
			}
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		try {
			const address = server.address();
			assert.ok(address && typeof address !== 'string');
			const client = new AzureClient({ ...remote, organizationUrl: `http://127.0.0.1:${address.port}/example` }, async () => 'Basic local-test');
			assert.deepStrictEqual(await client.pullRequest(42), pr);
			assert.strictEqual(requests[0].authorization, 'Basic local-test');
			assert.ok(requests[0].path.includes('/My%20Project/_apis/git/repositories/My%20Repo/pullrequests/42?api-version=7.1'));
			redirect = true;
			await assert.rejects(client.pullRequest(42), /redirect/i);
			assert.strictEqual(requests.length, 2);
		} finally {
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	});

	it('uses an encoded project/repository URL, API version, and authentication', async () => {
		const { client, calls } = fixture([json(pr)]);
		assert.deepStrictEqual(await client.pullRequest(42), pr);
		assert.strictEqual(calls[0].url.pathname, '/example/My%20Project/_apis/git/repositories/My%20Repo/pullrequests/42');
		assert.strictEqual(calls[0].url.searchParams.get('api-version'), '7.1');
		assert.strictEqual(new Headers(calls[0].init.headers).get('authorization'), 'Bearer test-token');
		assert.strictEqual(calls[0].init.redirect, 'error');
	});

	it('surfaces authorization failures without leaking response contents or tokens', async () => {
		for (const status of [401, 403, 404, 429, 500]) {
			const { client } = fixture([json({ message: 'secret response' }, status)]);
			await assert.rejects(client.pullRequest(42), (error: AzureApiError) => {
				assert.strictEqual(error.status, status);
				assert.ok(error.message.includes(`HTTP ${status}`));
				assert.ok(!error.message.includes('test-token'));
				assert.ok(!error.message.includes('secret response'));
				return true;
			});
		}
	});

	it('does not make an unauthenticated request if credentials are unavailable', async () => {
		let requested = false;
		const client = new AzureClient(remote, async () => { throw new Error('Sign in required'); }, async () => {
			requested = true;
			return json({});
		});
		await assert.rejects(client.repository(), /Sign in required/);
		assert.strictEqual(requested, false);
	});

	it('propagates transport failures instead of reporting empty results', async () => {
		const client = new AzureClient(remote, async () => 'Bearer token', async () => { throw new Error('Network unavailable'); });
		await assert.rejects(client.pullRequests(), /Network unavailable/);
	});

	it('follows continuation headers for list endpoints', async () => {
		const { client, calls } = fixture([
			json({ value: [{ id: 1 }] }, 200, { 'x-ms-continuationtoken': 'next+page' }),
			json({ value: [{ id: 2 }] }),
		]);
		assert.deepStrictEqual(await client.threads(42), [{ id: 1 }, { id: 2 }]);
		assert.strictEqual(calls[1].url.searchParams.get('continuationToken'), 'next+page');
	});

	it('rejects repeated continuation tokens instead of looping forever', async () => {
		const { client } = fixture([
			json({ value: [] }, 200, { 'x-ms-continuationtoken': 'same' }),
			json({ value: [] }, 200, { 'x-ms-continuationtoken': 'same' }),
		]);
		await assert.rejects(client.threads(42), /repeated continuation token/);
	});

	it('paginates pull requests with $skip and preserves search filters', async () => {
		const { client, calls } = fixture([json({ value: Array(100).fill(pr) }), json({ value: [pr] })]);
		assert.strictEqual((await client.pullRequests('all', { 'searchCriteria.creatorId': identity.id })).length, 101);
		assert.strictEqual(calls[0].url.searchParams.get('searchCriteria.status'), 'all');
		assert.strictEqual(calls[1].url.searchParams.get('$skip'), '100');
		assert.strictEqual(calls[1].url.searchParams.get('searchCriteria.creatorId'), identity.id);
	});

	it('creates a draft with full source and target refs', async () => {
		const { client, calls, body } = fixture([json(pr)]);
		await client.createPullRequest('Title', 'Body', 'refs/heads/topic', 'refs/heads/main', true);
		assert.strictEqual(calls[0].init.method, 'POST');
		assert.deepStrictEqual(body(), { title: 'Title', description: 'Body', sourceRefName: 'refs/heads/topic', targetRefName: 'refs/heads/main', isDraft: true });
	});

	it('creates cross-fork PRs with an explicit source repository', async () => {
		const { client, body } = fixture([json(pr)]);
		const forkSource = { repository: { id: 'fork', project: { id: 'source-project' } } };
		await client.createPullRequest('Title', 'Body', 'refs/heads/topic', 'refs/heads/main', false, forkSource);
		assert.deepStrictEqual(body().forkSource, { ...forkSource, name: 'refs/heads/topic' });
	});

	it('normalizes the connection-data identity and rejects missing authentication', async () => {
		const { client } = fixture([
			json({ authenticatedUser: { id: identity.id, providerDisplayName: identity.displayName } }),
			json({ authenticatedUser: {} }),
		]);
		assert.strictEqual((await client.currentUser()).displayName, identity.displayName);
		await assert.rejects(client.currentUser(), /authenticated identity/);
	});

	it('supports retargeting and explicitly clearing auto-complete', async () => {
		const { client, body } = fixture([json(pr)]);
		await client.updatePullRequest(42, { targetRefName: 'refs/heads/release', autoCompleteSetBy: null });
		assert.deepStrictEqual(body(), { targetRefName: 'refs/heads/release', autoCompleteSetBy: null });
	});

	it('updates PR state using PATCH without a GitHub-shaped payload', async () => {
		const { client, calls, body } = fixture([json(pr)]);
		await client.updatePullRequest(42, { status: 'abandoned', isDraft: true });
		assert.strictEqual(calls[0].init.method, 'PATCH');
		assert.deepStrictEqual(body(), { status: 'abandoned', isDraft: true });
	});

	it('completes against the reviewed source commit without bypassing policies', async () => {
		const { client, body } = fixture([json(pr)]);
		await client.completePullRequest(pr, 'squash', false);
		assert.deepStrictEqual(body(), {
			status: 'completed', lastMergeSourceCommit: { commitId: 'source' },
			completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: false, transitionWorkItems: false },
		});
	});

	it('uses the current identity for auto-complete rather than prematurely completing', async () => {
		const { client, body } = fixture([json({ authenticatedUser: identity }), json(pr)]);
		await client.completePullRequest(pr, 'noFastForward', true, true);
		assert.deepStrictEqual(body(1), {
			autoCompleteSetBy: { id: identity.id },
			completionOptions: { mergeStrategy: 'noFastForward', deleteSourceBranch: true, transitionWorkItems: false },
		});
	});

	it('paginates iteration changes and compares to the common ancestor', async () => {
		const first = { changeTrackingId: 1, changeType: 'add', item: { path: '/one.ts' } };
		const second = { changeTrackingId: 2, changeType: 'edit', item: { path: '/two.ts' } };
		const { client, calls } = fixture([
			json({ changeEntries: [first], nextSkip: 2000, nextTop: 2000 }),
			json({ changeEntries: [second], nextSkip: 0, nextTop: 0 }),
		]);
		assert.deepStrictEqual(await client.changes(42, 3), [first, second]);
		assert.strictEqual(calls[0].url.searchParams.get('$compareTo'), '0');
		assert.strictEqual(calls[1].url.searchParams.get('$skip'), '2000');
		assert.ok(calls[0].url.pathname.endsWith('/iterations/3/changes'));
	});

	it('rejects non-advancing changes pagination', async () => {
		const { client } = fixture([json({ changeEntries: [], nextSkip: 0, nextTop: 2000 })]);
		await assert.rejects(client.changes(42, 1), /invalid changes page/);
	});

	it('loads file content as text at an immutable commit', async () => {
		const { client, calls } = fixture([json({ content: 'const value = "not JSON";', contentMetadata: { isBinary: false } })]);
		assert.strictEqual(await client.file('/a b/#file.ts', 'commit-sha'), 'const value = "not JSON";');
		assert.strictEqual(calls[0].url.searchParams.get('path'), '/a b/#file.ts');
		assert.strictEqual(calls[0].url.searchParams.get('versionDescriptor.version'), 'commit-sha');
		assert.strictEqual(calls[0].url.searchParams.get('versionDescriptor.versionType'), 'commit');
		assert.strictEqual(calls[0].url.searchParams.get('includeContent'), 'true');
	});

	it('handles empty files but reports binary and absent content explicitly', async () => {
		const { client } = fixture([json({ content: '' }), json({ content: 'encoded', contentMetadata: { isBinary: true } }), json({})]);
		assert.strictEqual(await client.file('/empty', 'sha'), '');
		await assert.rejects(client.file('/image', 'sha'), /binary/);
		await assert.rejects(client.file('/missing', 'sha'), /did not return file content/);
	});

	it('asks Azure DevOps to track thread positions to the displayed iteration', async () => {
		const { client, calls } = fixture([json({ value: [] })]);
		await client.threads(42, 3);
		assert.strictEqual(calls[0].url.searchParams.get('iteration'), '3');
		assert.strictEqual(calls[0].url.searchParams.get('baseIteration'), '0');
	});

	it('creates line comments with one-based coordinates and iteration tracking', async () => {
		const { client, body } = fixture([json({ id: 3 })]);
		const context = { filePath: '/file.ts', rightFileStart: { line: 2, offset: 1 }, rightFileEnd: { line: 4, offset: 1 } };
		await client.createThread(42, 'Comment', context, 3, 7);
		assert.deepStrictEqual(body(), {
			comments: [{ parentCommentId: 0, content: 'Comment', commentType: 1 }], status: 1, threadContext: context,
			pullRequestThreadContext: { changeTrackingId: 7, iterationContext: { firstComparingIteration: 0, secondComparingIteration: 3 } },
		});
	});

	it('creates general comments without pretending they are line comments', async () => {
		const { client, body } = fixture([json({ id: 3 })]);
		await client.createThread(42, 'General comment');
		assert.strictEqual(body().threadContext, undefined);
		assert.strictEqual(body().pullRequestThreadContext, undefined);
	});

	it('replies, edits, deletes and resolves using Azure thread/comment IDs', async () => {
		const { client, calls, body } = fixture([json({ id: 5 }), json({ id: 5 }), new Response(null, { status: 204 }), json({ id: 3 }), json({ id: 3 })]);
		await client.reply(42, 3, 'Reply');
		await client.updateComment(42, 3, 5, 'Edited');
		await client.deleteComment(42, 3, 5);
		await client.resolveThread(42, 3, true);
		await client.resolveThread(42, 3, false);
		assert.ok(calls[0].url.pathname.endsWith('/threads/3/comments'));
		assert.deepStrictEqual(body(0), { content: 'Reply', parentCommentId: 1, commentType: 1 });
		assert.deepStrictEqual(body(1), { content: 'Edited' });
		assert.strictEqual(calls[1].init.method, 'PATCH');
		assert.strictEqual(calls[2].init.method, 'DELETE');
		assert.deepStrictEqual(body(3), { status: 2 });
		assert.deepStrictEqual(body(4), { status: 1 });
	});

	it('adds and removes Azure comment likes without inventing GitHub reaction types', async () => {
		const { client, calls } = fixture([new Response(null, { status: 204 }), new Response(null, { status: 204 })]);
		await client.likeComment(42, 3, 5, true);
		await client.likeComment(42, 3, 5, false);
		assert.ok(calls[0].url.pathname.endsWith('/threads/3/comments/5/likes'));
		assert.deepStrictEqual(calls.map(call => call.init.method), ['PUT', 'DELETE']);
	});

	it('uses the authenticated identity for review votes and supports removing reviewers', async () => {
		const { client, calls, body } = fixture([json({ authenticatedUser: identity }), json(identity), new Response(null, { status: 204 })]);
		await client.vote(42, -5);
		await client.removeReviewer(42, 'other-reviewer');
		assert.ok(calls[1].url.pathname.endsWith(`/reviewers/${identity.id}`));
		assert.strictEqual(calls[1].init.method, 'PUT');
		assert.deepStrictEqual(body(1), { vote: -5 });
		assert.ok(calls[2].url.pathname.endsWith('/reviewers/other-reviewer'));
		assert.strictEqual(calls[2].init.method, 'DELETE');
	});

	it('adds a reviewer without resolving the current identity', async () => {
		const { client, calls, body } = fixture([json(identity)]);
		await client.vote(42, 0, 'new-reviewer');
		assert.strictEqual(calls.length, 1);
		assert.ok(calls[0].url.pathname.endsWith('/reviewers/new-reviewer'));
		assert.deepStrictEqual(body(), { vote: 0 });
	});

	it('uses the project-scoped policy artifact ID', async () => {
		const { client, calls } = fixture([json({ value: [] })]);
		assert.deepStrictEqual(await client.policies(pr), []);
		assert.strictEqual(calls[0].url.searchParams.get('artifactId'), 'vstfs:///CodeReview/CodeReviewId/project-id/42');
		assert.strictEqual(calls[0].url.pathname, '/example/My%20Project/_apis/policy/evaluations');
	});

	it('lists project-team identities and deduplicates users in multiple teams', async () => {
		const other = { id: 'other', displayName: 'Other User' };
		const { client, calls } = fixture([
			json({ value: [{ id: 'team-1' }, { id: 'team-2' }] }),
			json({ value: [{ identity }, { identity: other }] }),
			json({ value: [{ identity }] }),
		]);
		assert.deepStrictEqual(await client.users(), [identity, other]);
		assert.strictEqual(calls[0].url.pathname, '/example/_apis/projects/My%20Project/teams');
		assert.ok(calls[1].url.pathname.endsWith('/teams/team-1/members'));
		assert.ok(calls[2].url.pathname.endsWith('/teams/team-2/members'));
	});

	it('paginates project teams and memberships', async () => {
		const { client, calls } = fixture([
			json({ value: [{ id: 'team' }] }),
			json({ value: Array(100).fill({ identity }) }),
			json({ value: [{ identity: { id: 'other', displayName: 'Other' } }] }),
		]);
		assert.strictEqual((await client.users()).length, 2);
		assert.strictEqual(calls[2].url.searchParams.get('$skip'), '100');
	});

	it('lists, adds and removes Azure PR labels', async () => {
		const label = { id: 'label-id', name: 'ready' };
		const { client, calls, body } = fixture([json({ value: [label] }), json(label), new Response(null, { status: 204 })]);
		assert.deepStrictEqual(await client.labels(42), [label]);
		await client.addLabel(42, 'ready');
		await client.removeLabel(42, 'label-id');
		assert.ok(calls[0].url.pathname.endsWith('/pullrequests/42/labels'));
		assert.deepStrictEqual(body(1), { name: 'ready' });
		assert.strictEqual(calls[2].init.method, 'DELETE');
	});

	it('hydrates linked work items and links them with Azure artifact relations', async () => {
		const { client, calls, body } = fixture([json({ value: [{ id: '12' }] }), json({ id: 12 }), json({ id: 12 })]);
		assert.deepStrictEqual(await client.linkedWorkItems(42), [{ id: 12 }]);
		await client.linkWorkItem(pr, 12);
		assert.ok(calls[1].url.pathname.endsWith('/wit/workitems/12'));
		assert.strictEqual(calls[2].init.method, 'PATCH');
		assert.deepStrictEqual(body(2), [{
			op: 'add', path: '/relations/-',
			value: {
				rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/project-id%2Frepository-id%2F42',
				attributes: { name: 'Pull Request' },
			},
		}]);
	});

	it('loads statuses, iterations, and commits through their own endpoints', async () => {
		const { client, calls } = fixture([json({ value: [] }), json({ value: [] }), json({ value: [] })]);
		await client.statuses(42);
		await client.iterations(42);
		await client.commits(42);
		assert.deepStrictEqual(calls.map(call => call.url.pathname.split('/').pop()), ['statuses', 'iterations', 'commits']);
	});

	it('executes WIQL and batches work item hydration in groups of at most 200', async () => {
		const workItems = Array.from({ length: 201 }, (_, i) => ({ id: i + 1 }));
		const { client, body } = fixture([
			json({ workItems }), json({ value: workItems.slice(0, 200) }), json({ value: workItems.slice(200) }),
		]);
		const query = 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project';
		assert.deepStrictEqual(await client.workItems(query), workItems);
		assert.deepStrictEqual(body(), { query });
		assert.strictEqual(body(1).ids.length, 200);
		assert.deepStrictEqual(body(2).ids, [201]);
	});

	it('does not call the work item batch endpoint for an empty query result', async () => {
		const { client, calls } = fixture([json({ workItems: [] })]);
		assert.deepStrictEqual(await client.workItems('query'), []);
		assert.strictEqual(calls.length, 1);
	});

	it('creates and edits work items using JSON Patch and process-specific types', async () => {
		const { client, calls, body } = fixture([json({ id: 12 }), json({ id: 12 })]);
		await client.saveWorkItem({ 'System.Title': 'Title' }, 'User Story');
		await client.saveWorkItem({ 'System.State': 'Active' }, undefined, 12);
		assert.ok(calls[0].url.pathname.endsWith('/wit/workitems/$User%20Story'));
		assert.strictEqual(calls[0].init.method, 'POST');
		assert.strictEqual(new Headers(calls[0].init.headers).get('content-type'), 'application/json-patch+json');
		assert.deepStrictEqual(body(), [{ op: 'add', path: '/fields/System.Title', value: 'Title' }]);
		assert.strictEqual(calls[1].init.method, 'PATCH');
		assert.deepStrictEqual(body(1), [{ op: 'add', path: '/fields/System.State', value: 'Active' }]);
	});

	it('uses the preview version required by work item comments', async () => {
		const { client, calls, body } = fixture([json({}), json({ comments: [{ text: 'Hello', createdBy: identity }], continuationToken: 'next' }), json({ comments: [] })]);
		await client.workItemComment(12, 'Comment');
		const comments = await client.workItemComments(12);
		assert.deepStrictEqual(body(), { text: 'Comment' });
		assert.strictEqual(calls[0].url.searchParams.get('api-version'), '7.1-preview.4');
		assert.deepStrictEqual(comments, [{ text: 'Hello', createdBy: identity }]);
		assert.strictEqual(calls[2].url.searchParams.get('continuationToken'), 'next');
	});

	it('builds Azure browser links instead of GitHub links', () => {
		const { client } = fixture([]);
		assert.strictEqual(client.pullRequestUrl(42), 'https://dev.azure.com/example/My%20Project/_git/My%20Repo/pullrequest/42');
		assert.strictEqual(client.workItemUrl(12), 'https://dev.azure.com/example/My%20Project/_workitems/edit/12');
	});
});
