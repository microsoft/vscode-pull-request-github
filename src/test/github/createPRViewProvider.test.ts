/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { createSandbox, SinonSandbox } from 'sinon';
import { CreatePullRequestNew, StackCandidate } from '../../../common/views';
import { RemoteInfo } from '../../../common/types';
import { GitApiImpl } from '../../api/api1';
import { Branch } from '../../api/api';
import { GitHubServerType } from '../../common/authentication';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { fromOpenOrCheckoutPullRequestWebviewUri } from '../../common/uri';
import { asPromise } from '../../common/utils';
import { IRequestMessage } from '../../common/webview';
import { CreatePullRequestViewProvider } from '../../github/createPRViewProvider';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { ViewerPermission } from '../../github/githubRepository';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { CreatePullRequestDataModel } from '../../view/createPullRequestDataModel';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockRepository } from '../mocks/mockRepository';
import { mockStackSetting } from '../mocks/mockStackSetting';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';

class TestCreatePullRequestViewProvider extends CreatePullRequestViewProvider {
	failTitleAndDescription = false;

	public override getStackCandidateForView(baseRemote: RemoteInfo | undefined, baseBranch: string | undefined, compareRemote: RemoteInfo | undefined, compareBranch: string | undefined) {
		return super.getStackCandidateForView(baseRemote, baseBranch, compareRemote, compareBranch);
	}

	public override _postMessage(message: any) {
		return super._postMessage(message);
	}

	protected override async getTitleAndDescription(_compareBranch: Branch, _baseBranch: string) {
		if (this.failTitleAndDescription) {
			throw new Error('Unable to compute the title');
		}
		return { title: '', description: '' };
	}

	getStackCandidateForTest(baseRemote: RemoteInfo, baseBranch: string, compareRemote: RemoteInfo, compareBranch: string) {
		return this.getStackCandidateForView(baseRemote, baseBranch, compareRemote, compareBranch);
	}

	public override _replyMessage(message: IRequestMessage<any>, response: any) {
		return super._replyMessage(message, response);
	}

	public override _throwError(message: IRequestMessage<any> | undefined, error: string) {
		return super._throwError(message, error);
	}

	public override postCreate(message: IRequestMessage<CreatePullRequestNew>, createdPR: PullRequestModel) {
		return super.postCreate(message, createdPR);
	}

	createForTest(message: { command: string; args: CreatePullRequestNew; req: string }) {
		return this.create(message);
	}
}

describe('Create pull request stack', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let credentials: CredentialStore;
	let folderManager: FolderRepositoryManager;
	let repository: MockRepository;
	let githubRepository: MockGitHubRepository;
	let provider: TestCreatePullRequestViewProvider;
	let model: CreatePullRequestDataModel;
	let setStacksEnabled: (enabled: boolean) => void;

	beforeEach(async function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		setStacksEnabled = mockStackSetting(sinon);
		context = new MockExtensionContext();
		const telemetry = new MockTelemetry();
		credentials = new CredentialStore(telemetry, context);
		repository = new MockRepository();
		const manager = new RepositoriesManager(credentials, telemetry);
		folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(manager), credentials, new CreatePullRequestHelper(), new MockThemeWatcher());
		const url = 'https://github.com/github/test';
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		githubRepository = new MockGitHubRepository(remote, credentials, telemetry, sinon);
		sinon.stub(folderManager, 'gitHubRepositories').get(() => [githubRepository]);
		sinon.stub(folderManager, 'findRepo').callsFake(predicate => predicate(githubRepository) ? githubRepository : undefined);
		await repository.createBranch('D4', false, 'commit-sha');
		await repository.setBranchUpstream('D4', 'refs/remotes/origin/D4');
		sinon.stub(githubRepository, 'hasBranch').resolves('commit-sha');
		model = new CreatePullRequestDataModel(folderManager, 'github', 'D3', 'github', 'D4', 'test');
		provider = new TestCreatePullRequestViewProvider(telemetry, model, vscode.Uri.file(__dirname), folderManager, { owner: 'github', repo: 'test', base: 'main' });
	});

	afterEach(function () {
		model.dispose();
		folderManager.dispose();
		githubRepository.dispose();
		credentials.dispose();
		context.dispose();
		sinon.restore();
	});

	it('does not look for stack candidates while stacks are disabled', async function () {
		setStacksEnabled(false);
		const lookup = sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName');

		const candidate = await provider.getStackCandidateForTest(
			{ owner: 'github', repositoryName: 'test' }, 'D3',
			{ owner: 'github', repositoryName: 'test' }, 'D4',
		);

		assert.strictEqual(candidate, undefined);
		assert(lookup.notCalled);
	});

	it('rejects a stale stack selection before creating a pull request when disabled', async function () {
		setStacksEnabled(false);
		const cancellation = new vscode.CancellationTokenSource();
		sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) => task({ report: () => undefined }, cancellation.token));
		const create = sinon.stub(folderManager, 'createPullRequest');
		const throwError = sinon.stub(provider, '_throwError').resolves();
		sinon.stub(provider, '_replyMessage').resolves();

		await provider.createForTest({
			command: 'pr.create', req: '1',
			args: {
				title: 'Fourth change', body: '', owner: 'github', repo: 'test', base: 'D3',
				compareOwner: 'github', compareRepo: 'test', compareBranch: 'D4',
				draft: false, autoMerge: false, labels: [], projects: [], assignees: [], reviewers: [],
				addToStack: true, stackParentPullRequest: 795, stackNumber: 12,
			},
		});

		assert(create.notCalled);
		assert.match(throwError.firstCall.args[1], /stack features are disabled/);
		cancellation.dispose();
	});

	it('links to the parent PR webview from the stack option', async function () {
		sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName').resolves(githubRepository);
		sinon.stub(githubRepository, 'getStackCandidate').resolves({
			parentPullRequestNumber: 795,
			stackNumber: 12,
			size: 3,
			url: 'https://github.com/github/test/pull/795',
		});

		const candidate = await provider.getStackCandidateForTest(
			{ owner: 'github', repositoryName: 'test' }, 'D3',
			{ owner: 'github', repositoryName: 'test' }, 'D4',
		);
		assert(candidate);
		const link = vscode.Uri.parse(candidate.url);
		assert.strictEqual(link.path, '/open-pull-request-webview');
		assert.deepStrictEqual(fromOpenOrCheckoutPullRequestWebviewUri(link), { owner: 'github', repo: 'test', pullRequestNumber: 795 });
	});

	it('updates compare owner before detecting stacks after switching to a fork with the same branch name', async function () {
		await repository.createBranch('D3', false, 'new-commit-sha');
		sinon.stub(githubRepository, 'getViewerPermission').resolves(ViewerPermission.Write);
		sinon.stub(githubRepository, 'getDefaultBranch').resolves('main');
		sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName').resolves(githubRepository);
		const getCandidate = sinon.stub(githubRepository, 'getStackCandidate').resolves({
			parentPullRequestNumber: 795, stackNumber: 12, size: 3, url: 'https://github.com/github/test/pull/795',
		});

		const result = await provider['processRemoteAndBranchResult'](githubRepository, {
			remote: { owner: 'fork', repositoryName: 'test' },
			branch: 'D3',
		}, false);

		assert.strictEqual(model.compareOwner, 'fork');
		assert.strictEqual(result.stackCandidate?.parentPullRequestNumber, 795);
		assert(getCandidate.calledWithExactly('D3'));
	});

	it('does not post a stale default compare branch after its stack lookup completes', async function () {
		let releaseLookup!: (candidate: StackCandidate | undefined) => void;
		const pendingLookup = new Promise<StackCandidate | undefined>(resolve => { releaseLookup = resolve; });
		let lookupStarted!: () => void;
		const started = new Promise<void>(resolve => { lookupStarted = resolve; });
		sinon.stub(provider, 'getStackCandidateForView').callsFake(async () => {
			lookupStarted();
			return pendingLookup;
		});
		const postMessage = sinon.stub(provider, '_postMessage').resolves();

		const update = provider.setDefaultCompareBranch(await repository.getBranch('D4'));
		await started;
		await repository.createBranch('D5', false, 'new-commit-sha');
		await model.setCompareBranch('D5');
		releaseLookup({ parentPullRequestNumber: 795, size: 1, url: 'https://github.com/github/test/pull/795' });
		await update;

		assert(postMessage.getCalls().every(call => call.args[0].params?.compareBranch !== 'D4'));
	});

	it('keeps the old owner when the selected compare branch is not available locally', async function () {
		sinon.stub(githubRepository, 'getViewerPermission').resolves(ViewerPermission.Write);
		sinon.stub(githubRepository, 'getDefaultBranch').resolves('main');

		await assert.rejects(provider['processRemoteAndBranchResult'](githubRepository, {
			remote: { owner: 'fork', repositoryName: 'test' },
			branch: 'not-local',
		}, false), /unrecognized name/);

		assert.strictEqual(model.compareOwner, 'github');
		assert.strictEqual(model.compareBranch, 'D4');
	});

	it('rolls back both owner and branch when a later compare update fails', async function () {
		await repository.createBranch('D3', false, 'new-commit-sha');
		sinon.stub(githubRepository, 'getViewerPermission').resolves(ViewerPermission.Write);
		sinon.stub(githubRepository, 'getDefaultBranch').resolves('main');
		provider.failTitleAndDescription = true;

		await assert.rejects(provider['processRemoteAndBranchResult'](githubRepository, {
			remote: { owner: 'fork', repositoryName: 'test' },
			branch: 'D3',
		}, false), /Unable to compute the title/);

		assert.strictEqual(model.compareOwner, 'github');
		assert.strictEqual(model.compareBranch, 'D4');
	});

	it('restores upstream state when switching repositories without changing the branch name fails', async function () {
		assert.strictEqual(await model.getCompareHasUpstream(), true);
		sinon.stub(githubRepository, 'getViewerPermission').resolves(ViewerPermission.Write);
		sinon.stub(githubRepository, 'getDefaultBranch').resolves('main');
		provider.failTitleAndDescription = true;

		await assert.rejects(provider['processRemoteAndBranchResult'](githubRepository, {
			remote: { owner: 'fork', repositoryName: 'test' },
			branch: 'D4',
		}, false), /Unable to compute the title/);

		assert.strictEqual(model.compareOwner, 'github');
		assert.strictEqual(model.compareBranch, 'D4');
		assert.strictEqual(await model.getCompareHasUpstream(), true);
	});

	it('notifies the user when stack eligibility cannot be checked', async function () {
		const error = new Error('GraphQL unavailable');
		sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName').resolves(githubRepository);
		sinon.stub(githubRepository, 'getStackCandidate').rejects(error);
		const warn = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);

		const result = await provider.getStackCandidateForTest(
			{ owner: 'github', repositoryName: 'test' }, 'D3',
			{ owner: 'github', repositoryName: 'test' }, 'D4',
		);

		assert.strictEqual(result, undefined);
		assert(warn.calledOnce);
		assert.match(warn.firstCall.args[0], /GraphQL unavailable/);
	});

	for (const stackNumber of [undefined, 12]) {
		it(`${stackNumber === undefined ? 'creates' : 'extends'} a stack without querying or refreshing webviews directly`, async function () {
			const cancellation = new vscode.CancellationTokenSource();
			sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) => task({ report: () => undefined }, cancellation.token));
			const candidate: StackCandidate = { parentPullRequestNumber: 795, stackNumber, size: stackNumber === undefined ? 1 : 3, url: 'https://github.com/github/test/pull/795' };
			const getCandidate = sinon.stub(githubRepository, 'getStackCandidate').resolves(candidate);
			sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName').resolves(githubRepository);
			sinon.stub(model, 'filesHaveChanges').resolves(false);
			repository.expectFetch('origin', 'D4');
			const createdPR = new PullRequestModel(credentials, new MockTelemetry(), githubRepository, githubRepository.remote,
				convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(796).build(), githubRepository));
			const create = sinon.stub(folderManager, 'createPullRequest').resolves(createdPR);
			const numbers = stackNumber === undefined ? [795, 796] : [793, 794, 795, 796];
			const addToStack = sinon.stub(githubRepository, 'addPullRequestToStack').resolves(numbers);
			const getStack = sinon.stub(createdPR, 'getStack').rejects(new Error('Unexpected stack refetch'));
			sinon.stub(provider, 'postCreate').resolves();
			sinon.stub(provider, '_replyMessage').resolves();
			const throwError = sinon.stub(provider, '_throwError').resolves();
			const done = asPromise(provider.onDone);

			await provider.createForTest({
				command: 'pr.create', req: '1',
				args: {
					title: 'Fourth change', body: '', owner: 'github', repo: 'test', base: 'D3',
					compareOwner: 'github', compareRepo: 'test', compareBranch: 'D4',
					draft: false, autoMerge: false, labels: [], projects: [], assignees: [], reviewers: [],
					addToStack: true, stackParentPullRequest: 795, stackNumber,
				},
			});
			assert.strictEqual(await done, createdPR, throwError.firstCall?.args[1] ?? 'Pull request creation did not complete.');
			assert(getCandidate.calledWithExactly('D3'));
			assert(create.calledOnce);
			assert(addToStack.calledOnceWithExactly(candidate, 796));
			assert(getStack.notCalled);
			sinon.assert.callOrder(getCandidate, create, addToStack);
			cancellation.dispose();
		});
	}

	it('does not create a pull request when the selected stack parent has changed', async function () {
		const cancellation = new vscode.CancellationTokenSource();
		sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) => task({ report: () => undefined }, cancellation.token));
		sinon.stub(githubRepository, 'getStackCandidate').resolves({ parentPullRequestNumber: 795, stackNumber: 12, size: 3, url: 'https://github.com/github/test/pull/795' });
		sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName').resolves(githubRepository);
		sinon.stub(model, 'filesHaveChanges').resolves(false);
		const create = sinon.stub(folderManager, 'createPullRequest');
		const throwError = sinon.stub(provider, '_throwError').resolves();
		let finish!: () => void;
		const finished = new Promise<void>(resolve => { finish = resolve; });
		sinon.stub(provider, '_replyMessage').callsFake(async () => { finish(); });

		await provider.createForTest({
			command: 'pr.create', req: '2',
			args: {
				title: 'Fourth change', body: '', owner: 'github', repo: 'test', base: 'D3',
				compareOwner: 'github', compareRepo: 'test', compareBranch: 'D4',
				draft: false, autoMerge: false, labels: [], projects: [], assignees: [], reviewers: [],
				addToStack: true, stackParentPullRequest: 794, stackNumber: 12,
			},
		});
		await finished;

		assert(create.notCalled);
		assert(throwError.calledOnce);
		assert.match(throwError.firstCall.args[1], /no longer at the top/);
		cancellation.dispose();
	});

	it('reports a failed stack addition while still applying PR details', async function () {
		const cancellation = new vscode.CancellationTokenSource();
		sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) => task({ report: () => undefined }, cancellation.token));
		const candidate: StackCandidate = { parentPullRequestNumber: 795, stackNumber: 12, size: 3, url: 'https://github.com/github/test/pull/795' };
		sinon.stub(githubRepository, 'getStackCandidate').resolves(candidate);
		sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName').resolves(githubRepository);
		sinon.stub(model, 'filesHaveChanges').resolves(false);
		repository.expectFetch('origin', 'D4');
		const createdPR = new PullRequestModel(credentials, new MockTelemetry(), githubRepository, githubRepository.remote,
			convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(796).build(), githubRepository));
		sinon.stub(folderManager, 'createPullRequest').resolves(createdPR);
		const setDetails = sinon.stub(provider, 'postCreate').resolves();
		sinon.stub(githubRepository, 'addPullRequestToStack').rejects(new Error('Stack is locked'));
		const getStack = sinon.stub(createdPR, 'getStack');
		const showError = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
		const done = asPromise(provider.onDone);

		await provider.createForTest({
			command: 'pr.create', req: '3',
			args: {
				title: 'Fourth change', body: '', owner: 'github', repo: 'test', base: 'D3',
				compareOwner: 'github', compareRepo: 'test', compareBranch: 'D4',
				draft: false, autoMerge: false, labels: [], projects: [], assignees: [], reviewers: [],
				addToStack: true, stackParentPullRequest: 795, stackNumber: 12,
			},
		});
		assert((await done) === createdPR);
		assert(setDetails.calledOnce);
		assert(getStack.notCalled);
		assert(showError.calledOnce);
		assert.match(showError.firstCall.args[0], /#796 was created but could not be added to its stack: Stack is locked/);
		cancellation.dispose();
	});
});
