/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { GitApiImpl, RefType } from '../../api/api1';
import { GitHubServerType } from '../../common/authentication';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { EXTENSION_ID } from '../../constants';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { GitHubRepository } from '../../github/githubRepository';
import { GithubItemStateEnum } from '../../github/interface';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { ActivePullRequestTool } from '../../lm/tools/activePullRequestTool';
import { OpenPullRequestTool } from '../../lm/tools/openPullRequestTool';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';

describe('ActivePullRequestTool', () => {
	let sandbox: SinonSandbox;
	let context: MockExtensionContext;
	let credentialStore: CredentialStore;
	let repositoriesManager: RepositoriesManager;
	let manager: FolderRepositoryManager;
	let repository: MockRepository;
	let githubRepository: GitHubRepository;
	let githubRepositories: GitHubRepository[];
	let pullRequest: PullRequestModel;
	let tool: ActivePullRequestTool;
	let findPullRequest: SinonStub;
	let initializeComments: SinonStub;
	let cancellation: vscode.CancellationTokenSource;

	beforeEach(async () => {
		sandbox = createSandbox();
		MockCommandRegistry.install(sandbox);
		context = new MockExtensionContext();
		const telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		repository = new MockRepository();
		await repository.createBranch('local-topic', true);
		await repository.setBranchUpstream('local-topic', 'refs/remotes/origin/remote-topic');
		manager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(repositoriesManager), credentialStore, new CreatePullRequestHelper(), new MockThemeWatcher());
		sandbox.stub(repositoriesManager, 'folderManagers').get(() => [manager]);
		const url = 'https://github.com/owner/repo';
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		githubRepository = new GitHubRepository(1, remote, repository.rootUri, credentialStore, telemetry);
		githubRepositories = [githubRepository];
		sandbox.stub(manager, 'gitHubRepositories').get(() => githubRepositories);
		sandbox.stub(githubRepository, 'getMetadata').resolves({ owner: { login: 'owner' }, name: 'repo' } as any);
		const item = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().build(), githubRepository);
		pullRequest = new PullRequestModel(credentialStore, telemetry, githubRepository, remote, item);
		findPullRequest = sandbox.stub(githubRepository, 'getPullRequestForBranch').resolves(pullRequest);
		sandbox.stub(pullRequest, 'getTimelineEvents').resolves([]);
		sandbox.stub(pullRequest, 'getFileChangesInfo').resolves([]);
		initializeComments = sandbox.stub(pullRequest, 'initializeReviewThreadCacheAndReviewComments').callsFake(async () => {
			sandbox.stub(pullRequest, 'reviewThreadsCacheReady').get(() => true);
		});
		cancellation = new vscode.CancellationTokenSource();
		tool = new ActivePullRequestTool(repositoriesManager);
	});

	afterEach(() => {
		cancellation.dispose();
		pullRequest.dispose();
		githubRepository.dispose();
		manager.dispose();
		repositoriesManager.dispose();
		credentialStore.dispose();
		context.dispose();
		sandbox.restore();
	});

	async function invoke(refresh = false): Promise<vscode.ExtendedLanguageModelToolResult> {
		const result = await tool.invoke({ input: { refresh }, toolInvocationToken: undefined }, cancellation.token);
		assert.ok(result);
		return result;
	}

	function text(result: vscode.LanguageModelToolResult): string {
		assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
		return result.content[0].value;
	}

	it('keeps the cached active pull request without querying GitHub for the branch', async () => {
		manager.activePullRequest = pullRequest;

		const result = await invoke();

		assert.strictEqual(JSON.parse(text(result)).title, pullRequest.title);
		assert.strictEqual(findPullRequest.called, false);
	});

	it('finds an externally created pull request using the tracked branch without refresh', async () => {
		const result = await invoke();

		assert.ok(findPullRequest.calledOnceWithExactly('remote-topic', 'owner'));
		assert.strictEqual(JSON.parse(text(result)).title, pullRequest.title);
		assert.deepStrictEqual(result.toolResultDetails, [vscode.Uri.parse(pullRequest.html_url)]);
		assert.strictEqual(manager.activePullRequest, undefined);
		assert.strictEqual(initializeComments.calledOnce, true);
	});

	it('uses the fork owner when looking up a pull request in the parent repository', async () => {
		const url = 'https://github.com/contributor/repo';
		const remote = new GitHubRemote('fork', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		const fork = new GitHubRepository(2, remote, repository.rootUri, credentialStore, new MockTelemetry());
		await repository.setBranchUpstream('local-topic', 'refs/remotes/fork/remote-topic');
		githubRepositories.push(fork);
		sandbox.stub(fork, 'getMetadata').resolves({
			owner: { login: 'contributor' }, name: 'repo', fork: true,
			parent: { owner: { login: 'owner' }, name: 'repo' },
		} as any);
		try {
			const result = await invoke();

			assert.ok(findPullRequest.calledOnceWithExactly('remote-topic', 'contributor'));
			assert.strictEqual(JSON.parse(text(result)).title, pullRequest.title);
		} finally {
			fork.dispose();
		}
	});

	it('prepares the confirmation with the discovered pull request', async () => {
		const prepared = await tool.prepareInvocation();

		assert.strictEqual(prepared.invocationMessage, `Reading pull request "${pullRequest.title} (#${pullRequest.number})"`);
		assert.strictEqual(findPullRequest.calledOnce, true);
	});

	it('refreshes a discovered pull request when requested', async () => {
		const refresh = sandbox.stub(githubRepository, 'getPullRequest').resolves(pullRequest);

		await invoke(true);

		assert.ok(refresh.calledOnceWithExactly(pullRequest.number, 'ActivePullRequestTool.invoke'));
		assert.strictEqual(initializeComments.calledOnce, true);
	});

	it('retries discovery after a previously missing pull request', async () => {
		findPullRequest.onFirstCall().resolves(undefined);

		assert.match(text(await invoke()), /An open pull request may still exist for the checked-out branch/);
		assert.strictEqual(JSON.parse(text(await invoke())).title, pullRequest.title);
		assert.strictEqual(findPullRequest.calledTwice, true);
	});

	for (const state of [GithubItemStateEnum.Closed, GithubItemStateEnum.Merged]) {
		it(`does not treat a ${state.toLowerCase()} pull request as an open branch match`, async () => {
			pullRequest.state = state;

			assert.match(text(await invoke()), /No active pull request was found/);
			assert.strictEqual(initializeComments.called, false);
		});
	}

	it('does not query GitHub for an untracked branch', async () => {
		await repository.createBranch('untracked-topic', true);

		assert.match(text(await invoke()), /An open pull request may still exist for the checked-out branch/);
		assert.strictEqual(findPullRequest.called, false);
	});

	it('does not query GitHub for a detached HEAD', async () => {
		sandbox.stub(repository, 'state').value({ HEAD: { type: RefType.Head, commit: 'abcdef' } });

		assert.match(text(await invoke()), /An open pull request may still exist for the checked-out branch/);
		assert.strictEqual(findPullRequest.called, false);
	});

	it('does not query GitHub when there is no HEAD', async () => {
		sandbox.stub(repository, 'state').value({ HEAD: undefined });

		assert.match(text(await invoke()), /No active pull request was found/);
		assert.strictEqual(findPullRequest.called, false);
	});

	it('preserves synchronous lookup for the open pull request tool', async () => {
		sandbox.stub(PullRequestOverviewPanel, 'getActivePanel').returns({ getCurrentItem: () => pullRequest } as any);
		const openTool = new OpenPullRequestTool(repositoriesManager);

		const result = await openTool.invoke({ input: {}, toolInvocationToken: undefined }, cancellation.token);

		assert.ok(result);
		assert.strictEqual(JSON.parse(text(result)).title, pullRequest.title);
		assert.strictEqual(findPullRequest.called, false);
	});

	it('is unavailable in the agents window', () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension);
		const contribution = extension.packageJSON.contributes.languageModelTools.find(
			tool => tool.name === ActivePullRequestTool.toolId,
		);

		assert.strictEqual(contribution.when, 'config.githubPullRequests.experimental.chat && !isSessionsWindow');
	});
});
