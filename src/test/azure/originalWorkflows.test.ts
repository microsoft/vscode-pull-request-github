/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Response } from 'cross-fetch';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { GitApiImpl } from '../../api/api1';
import { AzureClient, PullRequest as AzurePullRequest, ReviewThread } from '../../azure/client';
import { AzureSessions } from '../../azure/sessions';
import { DiffSide } from '../../common/comment';
import { InMemFileChange } from '../../common/file';
import { EXTENSION_ID } from '../../constants';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager, ReposManagerState } from '../../github/folderRepositoryManager';
import { PRType, PullRequestMergeability } from '../../github/interface';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { PullRequest } from '../../github/views';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';

const EXTENSION_URI = vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri;
const org = 'https://dev.azure.com/Org';
const repositoryPath = '/Org/Project/_apis/git/repositories/Repo';
const viewer = { id: '11111111-1111-1111-1111-111111111111', displayName: 'Viewer' };

class AzureServer {
	head = 'head';
	failPolicies = false;
	status: AzurePullRequest['status'] = 'active';
	autoComplete: AzurePullRequest['autoCompleteSetBy'];
	readonly patches: unknown[] = [];
	readonly threads: ReviewThread[] = [];
	readonly votes: { reviewer: string; vote: number }[] = [];
	readonly requests: { method: string; url: URL; body?: unknown }[] = [];
	pr(): AzurePullRequest {
		return {
			pullRequestId: 42, title: 'Azure change', description: '**Bold** <script>alert(1)</script>', status: this.status, isDraft: false,
			autoCompleteSetBy: this.autoComplete, completionOptions: this.autoComplete ? { mergeStrategy: 'squash' } : undefined,
			createdBy: { id: 'author', displayName: 'Author' }, sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main',
			reviewers: this.votes.map(vote => ({ id: vote.reviewer, displayName: vote.reviewer, vote: vote.vote })),
			lastMergeSourceCommit: { commitId: this.head }, lastMergeTargetCommit: { commitId: 'target' }, mergeStatus: 'succeeded',
			creationDate: '2026-10-19T10:00:00Z', repository: { id: 'repo-id', name: 'Repo', project: { id: 'project-id', name: 'Project' } },
		};
	}

	handle(url: URL, init: RequestInit): unknown {
		const method = init.method ?? 'GET';
		const body = init.body ? JSON.parse(String(init.body)) : undefined;
		this.requests.push({ method, url, body });
		const path = decodeURIComponent(url.pathname);
		if (path === '/Org/_apis/connectionData') {
			return { authenticatedUser: viewer };
		}
		if (path.startsWith('/Org/_apis/permissions/')) {
			return { count: 1, value: [true] };
		}
		if (path === '/Org/_apis/projects/Project/teams') {
			return { value: [{ id: 'team', name: 'Team' }] };
		}
		if (path === '/Org/_apis/projects/Project/teams/team/members') {
			return { value: [{ identity: { id: 'other', displayName: 'Other Reviewer' } }] };
		}
		if (path === '/Org/Project/_apis/policy/evaluations') {
			if (this.failPolicies) {
				throw new Error('Policy service unavailable');
			}
			return { value: [{ evaluationId: 'policy', status: 'approved', configuration: { isBlocking: true, type: { displayName: 'Minimum reviewers' } } }] };
		}
		if (path === repositoryPath) {
			return { id: 'repo-id', name: 'Repo', defaultBranch: 'refs/heads/main', project: { id: 'project-id', name: 'Project' } };
		}
		if (path === `${repositoryPath}/pullrequests`) {
			return { value: [this.pr()] };
		}
		if (path === `${repositoryPath}/items`) {
			const version = url.searchParams.get('versionDescriptor.version');
			return { content: version === 'base' ? 'a\nb\nc\n' : 'a\nB\nc\n' };
		}
		const pr = `${repositoryPath}/pullrequests/42`;
		if (path === pr && method === 'PATCH') {
			this.patches.push(body);
			if (body.status) {
				this.status = body.status;
			}
			if ('autoCompleteSetBy' in body) {
				this.autoComplete = body.autoCompleteSetBy ? viewer : undefined;
			}
			return this.pr();
		}
		if (path === pr) {
			return this.pr();
		}
		if (path === `${pr}/iterations`) {
			return { value: [{ id: 2, sourceRefCommit: { commitId: this.head }, targetRefCommit: { commitId: 'target' }, commonRefCommit: { commitId: 'base' } }] };
		}
		if (path === `${pr}/iterations/2/changes`) {
			return { changeEntries: [{ changeTrackingId: 1, changeType: 'edit', item: { path: '/src/file.ts', objectId: 'blob' } }] };
		}
		if (path === `${pr}/threads` && method === 'POST') {
			const thread: ReviewThread = {
				id: this.threads.length + 1, status: 1, threadContext: body.threadContext, pullRequestThreadContext: body.pullRequestThreadContext,
				comments: [{ id: 1, content: body.comments[0].content, author: viewer, publishedDate: '2026-10-19T11:00:00Z' }],
			};
			this.threads.push(thread);
			return thread;
		}
		if (path === `${pr}/threads`) {
			return { value: this.threads };
		}
		const reviewer = new RegExp(`^${pr}/reviewers/(?<id>[^/]+)$`).exec(path);
		if (reviewer?.groups && method === 'PUT') {
			this.votes.push({ reviewer: reviewer.groups.id, vote: body.vote });
			return { id: reviewer.groups.id, displayName: reviewer.groups.id, vote: body.vote };
		}
		if (path === `${repositoryPath}/diffs/commits`) {
			return { aheadCount: 1, behindCount: 0 };
		}
		if ([`${pr}/labels`, `${pr}/statuses`].includes(path)) {
			return { value: [] };
		}
		if (path === `${pr}/commits`) {
			return { value: [{ commitId: this.head, comment: 'Change', author: { name: 'Author', date: '2026-10-19T10:00:00Z' } }] };
		}
		throw new Error(`Unexpected Azure request: ${method} ${path}`);
	}
}

describe('Original application workflows backed by Azure DevOps', function () {
	let sandbox: SinonSandbox;
	let server: AzureServer;
	let manager: FolderRepositoryManager;
	let local: MockRepository;
	const disposables: vscode.Disposable[] = [];

	beforeEach(async function () {
		sandbox = createSandbox();
		sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('Unexpected global authentication request'));
		server = new AzureServer();
		const context = new MockExtensionContext();
		const secretsChanged = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
		context.secrets = {
			onDidChange: secretsChanged.event,
			async get(key) { return key === `azureDevOps.pat:${org.toLowerCase()}` ? 'test-token' : undefined; },
			async keys() { return []; },
			async store() { throw new Error('Unexpected secret write'); },
			async delete() { throw new Error('Unexpected secret delete'); },
		};
		const sessions = new AzureSessions(context, (remote, authorization) => new AzureClient(remote, authorization, async (url, init = {}) => {
			try {
				return new Response(JSON.stringify(server.handle(new URL(url), init)), { status: 200 });
			} catch (error) {
				return new Response(JSON.stringify({ message: String(error) }), { status: 404 });
			}
		}));
		const telemetry = new MockTelemetry();
		const credentials = new CredentialStore(telemetry, context, sessions);
		const repositories = new RepositoriesManager(credentials, telemetry);
		const git = new GitApiImpl(repositories);
		local = new MockRepository();
		local.state.remotes.push({ name: 'origin', fetchUrl: `${org}/Project/_git/Repo`, isReadOnly: false });
		sandbox.stub(local, 'getConfigs').resolves([]);
		const helper = new CreatePullRequestHelper();
		manager = new FolderRepositoryManager(0, context, local, telemetry, git, credentials, helper, new MockThemeWatcher());
		repositories.insertFolderManager(manager);
		disposables.push(secretsChanged, credentials, repositories, git, helper, manager);
		assert.strictEqual(await manager.updateRepositories(), true);
		assert.strictEqual(manager.state, ReposManagerState.RepositoriesLoaded);
	});

	afterEach(function () {
		PullRequestOverviewPanel.clearAll();
		for (const disposable of disposables.splice(0).reverse()) {
			disposable.dispose();
		}
		sandbox.restore();
	});

	async function model() {
		const pullRequest = await manager.gitHubRepositories[0].getPullRequest(42, 'azure-vertical-test');
		assert.ok(pullRequest);
		return pullRequest;
	}

	it('feeds the original category queries with Azure search criteria and rejects unsupported qualifiers', async function () {
		const response = await manager.getPullRequests(PRType.Query, { fetchNextPage: false }, 'is:open review-requested:${user}');
		assert.deepStrictEqual(response.items.map(item => item.number), [42]);
		const request = server.requests.find(request => request.url.pathname.endsWith('/pullrequests'));
		assert.strictEqual(request?.url.searchParams.get('searchCriteria.reviewerId'), viewer.id);
		assert.strictEqual(request?.url.searchParams.get('searchCriteria.status'), 'active');
		await assert.rejects(manager.getPullRequests(PRType.Query, { fetchNextPage: false }, 'is:open label:bug'), /not supported for Azure DevOps/);
		assert.deepStrictEqual((await manager.getPullRequests(PRType.All, { fetchNextPage: false })).items.map(item => item.number), [42]);
	});

	it('initializes the original overview with sanitized Azure content, real permissions and policy-aware completion', async function () {
		const messages: { command: string; pullrequest?: Partial<PullRequest> }[] = [];
		sandbox.stub(PullRequestOverviewPanel.prototype as unknown as { _postMessage: (message: unknown) => Promise<void> }, '_postMessage')
			.callsFake(async message => { messages.push(message as { command: string; pullrequest?: Partial<PullRequest> }); });
		const pullRequest = await model();
		await PullRequestOverviewPanel.createOrShow(new MockTelemetry(), EXTENSION_URI, manager, { owner: 'Project', repo: 'Repo', number: 42 }, pullRequest);
		const initialize = messages.find(message => message.command === 'pr.initialize')?.pullrequest;
		assert.ok(initialize);
		assert.strictEqual(initialize.title, 'Azure change');
		assert.ok(initialize.bodyHTML?.includes('<strong>Bold</strong>'));
		assert.ok(initialize.bodyHTML?.includes('&lt;script&gt;'));
		assert.ok(!initialize.bodyHTML?.includes('<script>'));
		assert.strictEqual(initialize.hasWritePermission, true);
		assert.strictEqual(initialize.mergeable, PullRequestMergeability.Mergeable);
		assert.strictEqual(initialize.checksError, null);
		assert.strictEqual(initialize.revertable, false);
		for (let attempt = 0; attempt < 50 && !messages.some(message => message.pullrequest?.status); attempt++) {
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		assert.strictEqual(messages.find(message => message.pullrequest?.status)?.pullrequest?.status?.statuses[0].context, 'Minimum reviewers');
		assert.ok(server.requests.every(request => request.url.origin === 'https://dev.azure.com'));
	});

	it('shows policy failures inline and withholds completion instead of reporting success', async function () {
		server.failPolicies = true;
		const messages: { command: string; pullrequest?: Partial<PullRequest> }[] = [];
		sandbox.stub(PullRequestOverviewPanel.prototype as unknown as { _postMessage: (message: unknown) => Promise<void> }, '_postMessage')
			.callsFake(async message => { messages.push(message as { command: string; pullrequest?: Partial<PullRequest> }); });
		const pullRequest = await model();
		await PullRequestOverviewPanel.createOrShow(new MockTelemetry(), EXTENSION_URI, manager, { owner: 'Project', repo: 'Repo', number: 42 }, pullRequest);
		const initialize = messages.find(message => message.command === 'pr.initialize')?.pullrequest;
		assert.ok(initialize?.checksError?.includes('HTTP 404'));
		assert.strictEqual(initialize?.mergeable, PullRequestMergeability.Unknown);
		assert.strictEqual(initialize?.title, 'Azure change');
		assert.strictEqual((await pullRequest.getMergeability()).mergeability, PullRequestMergeability.Unknown);
	});

	it('completes and toggles auto-complete through the original model against the reviewed source', async function () {
		const pullRequest = await model();
		await pullRequest.enableAutoMerge('squash');
		assert.strictEqual(pullRequest.autoMerge, true);
		assert.strictEqual(pullRequest.autoMergeMethod, 'squash');
		await pullRequest.disableAutoMerge();
		assert.strictEqual(pullRequest.autoMerge, false);
		const result = await pullRequest.merge(local, 'Title', 'Body', 'squash');
		assert.strictEqual(result.merged, true);
		const completion = server.patches.at(-1) as { status: string; lastMergeSourceCommit: { commitId: string }; completionOptions: { mergeStrategy: string; transitionWorkItems: boolean; mergeCommitMessage: string } };
		assert.strictEqual(completion.status, 'completed');
		assert.strictEqual(completion.lastMergeSourceCommit.commitId, 'head');
		assert.deepStrictEqual(completion.completionOptions, { mergeStrategy: 'squash', deleteSourceBranch: false, transitionWorkItems: false, mergeCommitMessage: 'Title\n\nBody' });
	});

	it('computes the original diff hunks from the Azure merge base and source revisions', async function () {
		const pullRequest = await model();
		const changes = await pullRequest.getFileChangesInfo();
		assert.strictEqual(pullRequest.mergeBase, 'base');
		assert.strictEqual(changes.length, 1);
		const change = changes[0];
		assert.ok(change instanceof InMemFileChange);
		assert.strictEqual(change.fileName, 'src/file.ts');
		assert.strictEqual(change.patch, '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
	});

	it('keeps review comments private until the original approve action publishes them and votes', async function () {
		const pullRequest = await model();
		await pullRequest.startReview();
		const thread = await pullRequest.createReviewThread('Draft note', 'src/file.ts', 2, 2, DiffSide.RIGHT);
		assert.ok(thread?.comments[0].isDraft);
		assert.strictEqual(server.threads.length, 0);
		assert.strictEqual(await pullRequest.getPendingReviewId() !== undefined, true);
		await pullRequest.approve(local, 'Looks good');
		assert.deepStrictEqual(server.threads.map(thread => (thread.comments[0].content ?? '').split('\n\n<!--')[0]), ['Draft note', 'Looks good']);
		assert.deepStrictEqual(server.threads[0].threadContext?.rightFileStart, { line: 2, offset: 1 });
		assert.deepStrictEqual(server.votes, [{ reviewer: viewer.id, vote: 10 }]);
		assert.strictEqual(pullRequest.hasPendingReview, false);
		assert.strictEqual(await pullRequest.getPendingReviewId(), undefined);
	});

	it('publishes single comments directly without creating a review or vote', async function () {
		const pullRequest = await model();
		await pullRequest.createReviewThread('Immediate', 'src/file.ts', 1, 1, DiffSide.RIGHT, true);
		await pullRequest.submitReview();
		assert.deepStrictEqual(server.threads.map(thread => thread.comments[0].content), ['Immediate']);
		assert.deepStrictEqual(server.votes, []);
		assert.strictEqual(await pullRequest.getPendingReviewId(), undefined);
	});

	it('does not publish drafts or vote after the source changes during review', async function () {
		const pullRequest = await model();
		await pullRequest.startReview();
		await pullRequest.createReviewThread('Draft note', 'src/file.ts', 2, 2, DiffSide.RIGHT);
		server.head = 'pushed';
		await assert.rejects(pullRequest.submitReview(undefined, 'Summary'), /source changed/);
		assert.deepStrictEqual(server.threads, []);
		assert.deepStrictEqual(server.votes, []);
		assert.ok(await pullRequest.getPendingReviewId(), 'The private draft must be kept.');
	});
});
