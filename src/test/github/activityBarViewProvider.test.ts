/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import { GitApiImpl } from '../../api/api1';
import { GitHubServerType } from '../../common/authentication';
import Logger from '../../common/logger';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { EXTENSION_ID } from '../../constants';
import { PullRequestViewProvider } from '../../github/activityBarViewProvider';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { GithubItemStateEnum, MergeMethod, PullRequestMergeability, PullRequestStack } from '../../github/interface';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequest } from '../../github/views';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { ReviewManager } from '../../view/reviewManager';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockRepository } from '../mocks/mockRepository';
import { mockStackSetting } from '../mocks/mockStackSetting';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';

interface ViewMessage {
	command: string;
	pullrequest?: Partial<PullRequest>;
}

class TestPullRequestViewProvider extends PullRequestViewProvider {
	public readonly messages: ViewMessage[] = [];

	public attachView(panel: vscode.WebviewPanel): void {
		const visibility = this._register(new vscode.EventEmitter<void>());
		this._view = {
			viewType: this.viewType,
			webview: panel.webview,
			visible: true,
			title: '',
			onDidDispose: panel.onDidDispose,
			onDidChangeVisibility: visibility.event,
			show: () => undefined,
		};
	}

	protected override async _postMessage(message: ViewMessage): Promise<void> {
		this.messages.push(JSON.parse(JSON.stringify(message)));
	}
}

describe('Active pull request stack changes', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let credentials: CredentialStore;
	let repositoriesManager: RepositoriesManager;
	let folderManager: FolderRepositoryManager;
	let repo: MockGitHubRepository;
	let provider: TestPullRequestViewProvider;
	let models: Map<number, PullRequestModel>;
	let model: PullRequestModel;
	let stackQuery: SinonStub<[], Promise<PullRequestStack | undefined>>;
	let queueMethod: SinonStub;
	let setStacksEnabled: (enabled: boolean) => void;
	const stack: PullRequestStack = {
		position: 2, size: 3, base: 'main',
		pullRequests: [999, 1000, 1001].map((number, index) => ({
			position: index + 1, number, title: `Change ${index + 1}`, url: '', head: `D${index + 1}`,
			state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable,
		})),
	};

	function createModel(number: number) {
		const item = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(number).build(), repo);
		const result = new PullRequestModel(credentials, folderManager.telemetry, repo, repo.remote, item);
		models.set(number, result);
		sinon.stub(result, 'getTimelineEvents').resolves([]);
		sinon.stub(result, 'getReviewRequests').resolves([]);
		sinon.stub(result, 'canEdit').resolves(true);
		sinon.stub(result, 'validateDraftMode').resolves(false);
		sinon.stub(result, 'getCoAuthors').resolves([]);
		return result;
	}

	async function settleUpdates(): Promise<void> {
		await new Promise<void>(resolve => setImmediate(resolve));
	}

	async function initialize(): Promise<void> {
		await provider.updatePullRequest(model);
		await settleUpdates();
		provider.messages.length = 0;
		stackQuery.resetHistory();
	}

	function latestStackUpdate(): Partial<PullRequest> {
		const updates = provider.messages.filter(message => message.command === 'pr.update');
		assert(updates.length > 0);
		return updates[updates.length - 1].pullrequest!;
	}

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		sinon.stub(vscode.window, 'showErrorMessage').callsFake(message => {
			assert.fail(message);
		});
		setStacksEnabled = mockStackSetting(sinon);
		context = new MockExtensionContext();
		context.extensionUri = vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri;
		const telemetry = new MockTelemetry();
		credentials = new CredentialStore(telemetry, context);
		repositoriesManager = new RepositoriesManager(credentials, telemetry);
		folderManager = new FolderRepositoryManager(0, context, new MockRepository(), telemetry,
			new GitApiImpl(repositoriesManager), credentials, new CreatePullRequestHelper(), new MockThemeWatcher());
		const url = 'https://github.com/aaa/bbb';
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		repo = new MockGitHubRepository(remote, credentials, telemetry, sinon);
		models = new Map();
		model = createModel(1000);
		stackQuery = sinon.stub(model, 'getStack').resolves(stack);
		sinon.stub(folderManager, 'resolvePullRequest').callsFake(async (_owner, _repo, number) => models.get(number));
		sinon.stub(folderManager, 'getPullRequestRepositoryAccessAndMergeMethods').resolves({
			hasWritePermission: true,
			mergeMethodsAvailability: { merge: true, squash: true, rebase: true },
			viewerCanAutoMerge: false,
		});
		sinon.stub(folderManager, 'getBranchNameForPullRequest').resolves(undefined);
		sinon.stub(folderManager, 'getPullRequestRepositoryDefaultBranch').resolves('main');
		sinon.stub(folderManager, 'getCurrentUser').resolves(model.author);
		queueMethod = sinon.stub(folderManager, 'mergeQueueMethodForBranch').resolves(undefined);
		provider = new TestPullRequestViewProvider(context.extensionUri, folderManager,
			sinon.createStubInstance(ReviewManager), model);
		const panel = vscode.window.createWebviewPanel('testActivePullRequest', '', vscode.ViewColumn.One, {});
		context.subscriptions.push(panel);
		provider.attachView(panel);
	});

	afterEach(function () {
		provider.dispose();
		for (const item of models.values()) {
			item.dispose();
		}
		folderManager.dispose();
		repositoriesManager.dispose();
		repo.dispose();
		credentials.dispose();
		context.dispose();
		sinon.restore();
	});

	it('clears a three-pull-request stack from the sidebar after unstacking', async function () {
		await initialize();
		stackQuery.resolves(undefined);
		repo.notifyStackChanged([999, 1000, 1001]);
		await settleUpdates();

		assert(stackQuery.calledOnce);
		assert.deepStrictEqual(latestStackUpdate(), {
			stack: null, stackLoaded: true, stackLoadError: false, mergeQueueMethod: null,
		});
	});

	it('updates the remaining stack after partially unstacking', async function () {
		await initialize();
		const remaining = { ...stack, size: 2, pullRequests: stack.pullRequests.slice(0, 2) };
		stackQuery.resolves(remaining);
		repo.notifyStackChanged([999, 1000, 1001]);
		await settleUpdates();

		assert.deepStrictEqual(latestStackUpdate().stack, remaining);
	});

	it('detects a stack added to a previously unstacked pull request', async function () {
		stackQuery.resolves(undefined);
		await initialize();
		stackQuery.resolves(stack);
		repo.notifyStackChanged([999, 1000, 1001]);
		await settleUpdates();

		assert.deepStrictEqual(latestStackUpdate().stack, stack);
	});

	for (const method of [undefined, 'merge'] as (MergeMethod | undefined)[]) {
		it(`restores the pull request base branch queue method (${method ?? 'none'}) after unstacking`, async function () {
			queueMethod.callsFake(async branch => branch === stack.base ? 'squash' : method);
			await initialize();
			stackQuery.resolves(undefined);
			repo.notifyStackChanged([1000]);
			await settleUpdates();

			assert('mergeQueueMethod' in latestStackUpdate());
			assert.strictEqual(latestStackUpdate().mergeQueueMethod, method ?? null);
			assert(queueMethod.lastCall.calledWithExactly(model.base.ref, model.remote.owner, model.remote.repositoryName));
		});
	}

	it('ignores notifications for unrelated pull requests and repositories', async function () {
		await initialize();
		const url = 'https://github.com/other/repository';
		const other = new MockGitHubRepository(new GitHubRemote('other', url, new Protocol(url), GitHubServerType.GitHubDotCom),
			credentials, folderManager.telemetry, sinon);
		try {
			repo.notifyStackChanged([2000]);
			other.notifyStackChanged([1000]);
			await settleUpdates();
			assert(stackQuery.notCalled);
			assert.strictEqual(provider.messages.length, 0);
		} finally {
			other.dispose();
		}
	});

	it('does not load stacks when the feature is disabled', async function () {
		setStacksEnabled(false);
		await initialize();
		repo.notifyStackChanged([1000]);
		await settleUpdates();

		assert(stackQuery.notCalled);
		assert.strictEqual(provider.messages.length, 0);
	});

	it('ignores an older stack load that completes after unstacking', async function () {
		let release!: (value: PullRequestStack) => void;
		stackQuery.onFirstCall().returns(new Promise<PullRequestStack>(resolve => { release = resolve; }));
		await provider.updatePullRequest(model);
		assert.strictEqual(stackQuery.callCount, 1);
		provider.messages.length = 0;
		stackQuery.onSecondCall().resolves(undefined);
		repo.notifyStackChanged([1000]);
		await settleUpdates();
		assert.strictEqual(stackQuery.callCount, 2);
		assert.strictEqual(latestStackUpdate().stack, null);
		release(stack);
		await settleUpdates();

		assert.strictEqual(provider.messages.length, 1);
		assert.strictEqual(latestStackUpdate().stack, null);
	});

	it('reports stack load failures and clears the error after a successful refresh', async function () {
		await initialize();
		const logError = sinon.stub(Logger, 'error');
		stackQuery.rejects(new Error('Stack unavailable'));
		repo.notifyStackChanged([1000]);
		await settleUpdates();
		assert.strictEqual(latestStackUpdate().stackLoadError, true);
		assert(logError.calledOnce);

		stackQuery.resolves(undefined);
		repo.notifyStackChanged([1000]);
		await settleUpdates();
		assert.strictEqual(latestStackUpdate().stackLoadError, false);
	});

	it('registers stack listeners for the new active pull request', async function () {
		await initialize();
		const next = createModel(2000);
		const nextStackQuery = sinon.stub(next, 'getStack').resolves(undefined);
		await provider.updatePullRequest(next);
		await settleUpdates();
		provider.messages.length = 0;
		nextStackQuery.resetHistory();

		repo.notifyStackChanged([1000]);
		await settleUpdates();
		assert(nextStackQuery.notCalled);
		repo.notifyStackChanged([2000]);
		await settleUpdates();
		assert(nextStackQuery.calledOnce);
		assert.strictEqual(latestStackUpdate().stack, null);
	});

	it('does not refresh or publish a pending stack load after disposal', async function () {
		await initialize();
		let release!: (value: PullRequestStack) => void;
		stackQuery.returns(new Promise<PullRequestStack>(resolve => { release = resolve; }));
		repo.notifyStackChanged([1000]);
		provider.dispose();
		repo.notifyStackChanged([1000]);
		release(stack);
		await settleUpdates();

		assert(stackQuery.calledOnce);
		assert.strictEqual(provider.messages.length, 0);
	});
});
