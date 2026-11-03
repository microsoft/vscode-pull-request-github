/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import { CreatePullRequestNew, StackCandidate } from '../../../common/views';
import { RemoteInfo } from '../../../common/types';
import { GitApiImpl, GitErrorCodes, RefType } from '../../api/api1';
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
import { PullRequestGitHelper } from '../../github/pullRequestGitHelper';
import { PullRequestModel } from '../../github/pullRequestModel';
import { IssueModel } from '../../github/issueModel';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { StateManager } from '../../issues/stateManager';
import { CreatePullRequestDataModel } from '../../view/createPullRequestDataModel';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';

class TestCreatePullRequestViewProvider extends CreatePullRequestViewProvider {
	failTitleAndDescription = false;

	public getDefaultTitleAndDescription(compareBranch: Branch, baseBranch: string) {
		return super.getTitleAndDescription(compareBranch, baseBranch);
	}

	public override _onDidReceiveMessage(message: IRequestMessage<unknown>) {
		return super._onDidReceiveMessage(message);
	}

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

	public override detectBaseMetadata(defaultCompareBranch: Branch) {
		return super.detectBaseMetadata(defaultCompareBranch);
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
	let stateManager: StateManager;

	beforeEach(async function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		context = new MockExtensionContext();
		const telemetry = new MockTelemetry();
		credentials = new CredentialStore(telemetry, context);
		repository = new MockRepository();
		const manager = new RepositoriesManager(credentials, telemetry);
		stateManager = new StateManager(new GitApiImpl(manager), manager, context);
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
		provider.dispose();
		model.dispose();
		folderManager.dispose();
		githubRepository.dispose();
		credentials.dispose();
		context.dispose();
		sinon.restore();
	});

	describe('pull request template variables', function () {
		beforeEach(function () {
			const configuration: vscode.WorkspaceConfiguration = {
				...vscode.workspace.getConfiguration('githubPullRequests', undefined),
				get: sinon.stub().returns('template'),
			};
			sinon.stub(vscode.workspace, 'getConfiguration').callThrough().withArgs('githubPullRequests').returns(configuration);
			sinon.stub(folderManager, 'getOrigin').resolves(githubRepository);
			sinon.stub(githubRepository, 'compareCommits').resolves(undefined);
			sinon.stub(model, 'gitCommits').resolves([]);
			sinon.stub(folderManager, 'getTipCommitMessage').resolves('A change\n\nCommit body ${issueNumber}');
		});

		async function associateIssue(owner = 'github', repo = 'test', branch = 'D4') {
			const issue = new IssueModel(new MockTelemetry(), githubRepository, new GitHubRemote('origin',
				`https://github.com/${owner}/${repo}`, new Protocol(`https://github.com/${owner}/${repo}`), GitHubServerType.GitHubDotCom),
				convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(42).title('Fix the bug').build(), githubRepository));
			await stateManager.setSavedIssueState(issue, { branch });
			return sinon.stub(folderManager, 'resolveIssue').resolves(issue);
		}

		async function description(branch = 'D4') {
			return (await provider.getDefaultTitleAndDescription(await repository.getBranch(branch), 'D3')).description;
		}

		it('resolves issue variables in the default template without changing commit text', async function () {
			const resolveIssue = await associateIssue();
			sinon.stub(folderManager, 'getPullRequestTemplateBody').resolves('${issueTitle}\nCloses ${issueNumberLabel}\nIssue ${issueNumber}\n${unknown}');

			assert.strictEqual(await description(), 'Commit body ${issueNumber}\n\nFix the bug\nCloses #42\nIssue 42\n${unknown}');
			assert(resolveIssue.calledOnceWithExactly('github', 'test', 42));
		});

		it('resolves issue variables for the described branch rather than the selected compare branch', async function () {
			await repository.createBranch('issue-42', false, 'commit-sha');
			await associateIssue('github', 'test', 'issue-42');
			sinon.stub(folderManager, 'getPullRequestTemplateBody').resolves('Closes ${issueNumberLabel}');

			assert.strictEqual(model.compareBranch, 'D4');
			assert.strictEqual(await description('issue-42'), 'Commit body ${issueNumber}\n\nCloses #42');
		});

		it('qualifies issue links when the issue belongs to another repository', async function () {
			await associateIssue('other', 'issues');
			sinon.stub(folderManager, 'getPullRequestTemplateBody').resolves('Closes ${issueNumberLabel}');

			assert.strictEqual(await description(), 'Commit body ${issueNumber}\n\nCloses other/issues#42');
		});

		it('preserves unresolved variables when the compare branch has no associated issue', async function () {
			sinon.stub(folderManager, 'getPullRequestTemplateBody').resolves('Closes ${issueNumberLabel}');
			const resolveIssue = sinon.stub(folderManager, 'resolveIssue');

			assert.strictEqual(await description(), 'Commit body ${issueNumber}\n\nCloses ${issueNumberLabel}');
			sinon.assert.notCalled(resolveIssue);
		});

		it('resolves the remaining variables if issue resolution fails', async function () {
			const resolveIssue = await associateIssue();
			resolveIssue.rejects(new Error('Offline'));
			sinon.stub(folderManager, 'getPullRequestTemplateBody').resolves('Closes ${issueNumberLabel} in ${owner}/${repository}');

			assert.strictEqual(await description(), 'Commit body ${issueNumber}\n\nCloses ${issueNumberLabel} in github/test');
		});

		it('resolves the remaining variables if user resolution fails', async function () {
			await associateIssue();
			sinon.stub(folderManager, 'getCurrentUser').throws(new Error('No GitHub repositories'));
			sinon.stub(folderManager, 'getPullRequestTemplateBody').resolves('Closes ${issueNumberLabel} by ${user}');

			assert.strictEqual(await description(), 'Commit body ${issueNumber}\n\nCloses #42 by ${user}');
		});

		it('preserves variables when the associated issue cannot be found', async function () {
			const resolveIssue = await associateIssue();
			resolveIssue.resolves(undefined);
			sinon.stub(folderManager, 'getPullRequestTemplateBody').resolves('Closes ${issueNumberLabel}');

			assert.strictEqual(await description(), 'Commit body ${issueNumber}\n\nCloses ${issueNumberLabel}');
		});

		it('resolves repository variables without an associated issue', async function () {
			sinon.stub(folderManager, 'getPullRequestTemplateBody').resolves('${owner}/${repository}');

			assert.strictEqual(await description(), 'Commit body ${issueNumber}\n\ngithub/test');
		});

		it('does not resolve issues for templates without variables', async function () {
			const resolveIssue = await associateIssue();
			sinon.stub(folderManager, 'getPullRequestTemplateBody').resolves('## Description');

			assert.strictEqual(await description(), 'Commit body ${issueNumber}\n\n## Description');
			sinon.assert.notCalled(resolveIssue);
		});

		it('resolves variables when switching templates', async function () {
			await associateIssue();
			sinon.stub(folderManager, 'getAllPullRequestTemplates').resolves(['Closes ${issueNumberLabel}']);
			const selectedTemplate = {
				label: 'Closes ${issueNumberLabel}', description: '', template: 'Closes ${issueNumberLabel}'
			};
			sinon.stub(vscode.window, 'showQuickPick').resolves(selectedTemplate);
			const reply = sinon.stub(provider, '_replyMessage').resolves();
			const message: IRequestMessage<unknown> = { command: 'pr.changeTemplate', req: 'template', args: undefined };

			await provider._onDidReceiveMessage(message);

			assert(reply.calledOnceWithExactly(message, { description: 'Closes #42' }));
		});
	});

	function stubStackParent(autoMerge: boolean = false): PullRequestModel {
		const parent = new PullRequestModel(credentials, new MockTelemetry(), githubRepository, githubRepository.remote,
			convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(795).build(), githubRepository));
		parent.item.autoMerge = autoMerge;
		sinon.stub(githubRepository, 'getPullRequest').callsFake(async number => number === parent.number ? parent : undefined);
		return parent;
	}

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

	it('does not warn about stack eligibility once the view is disposed', async function () {
		let fail!: (error: Error) => void;
		sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName').resolves(githubRepository);
		sinon.stub(githubRepository, 'getStackCandidate').returns(new Promise((_resolve, reject) => { fail = reject; }));
		const warn = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);

		const result = provider.getStackCandidateForTest(
			{ owner: 'github', repositoryName: 'test' }, 'D3',
			{ owner: 'github', repositoryName: 'test' }, 'D4',
		);
		provider.dispose();
		fail(new Error('Persistent store not initialized.'));

		assert.strictEqual(await result, undefined);
		assert(warn.notCalled);
	});

	for (const stackNumber of [undefined, 12]) {
		it(`${stackNumber === undefined ? 'creates' : 'extends'} a stack without querying or refreshing webviews directly`, async function () {
			const cancellation = new vscode.CancellationTokenSource();
			sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) => task({ report: () => undefined }, cancellation.token));
			const candidate: StackCandidate = { parentPullRequestNumber: 795, stackNumber, size: stackNumber === undefined ? 1 : 3, url: 'https://github.com/github/test/pull/795' };
			const getCandidate = sinon.stub(githubRepository, 'getStackCandidate').resolves(candidate);
			sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName').resolves(githubRepository);
			stubStackParent();
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

	it('disables auto-merge on the stack parent after confirming, before adding the new pull request', async function () {
		const cancellation = new vscode.CancellationTokenSource();
		sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) => task({ report: () => undefined }, cancellation.token));
		const candidate: StackCandidate = { parentPullRequestNumber: 795, size: 1, url: 'https://github.com/github/test/pull/795' };
		sinon.stub(githubRepository, 'getStackCandidate').resolves(candidate);
		sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName').resolves(githubRepository);
		const parent = stubStackParent(true);
		const disable = sinon.stub(parent, 'disableAutoMerge').resolves();
		const confirm = sinon.stub(vscode.window, 'showWarningMessage').resolves('Disable Auto-Merge' as never);
		sinon.stub(model, 'filesHaveChanges').resolves(false);
		repository.expectFetch('origin', 'D4');
		const createdPR = new PullRequestModel(credentials, new MockTelemetry(), githubRepository, githubRepository.remote,
			convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(796).build(), githubRepository));
		const create = sinon.stub(folderManager, 'createPullRequest').resolves(createdPR);
		const addToStack = sinon.stub(githubRepository, 'addPullRequestToStack').resolves([795, 796]);
		sinon.stub(provider, 'postCreate').resolves();
		const throwError = sinon.stub(provider, '_throwError').resolves();
		const done = asPromise(provider.onDone);

		await provider.createForTest({
			command: 'pr.create', req: '4',
			args: {
				title: 'Second change', body: '', owner: 'github', repo: 'test', base: 'D3',
				compareOwner: 'github', compareRepo: 'test', compareBranch: 'D4',
				draft: false, autoMerge: false, labels: [], projects: [], assignees: [], reviewers: [],
				addToStack: true, stackParentPullRequest: 795,
			},
		});
		assert.strictEqual(await done, createdPR, throwError.firstCall?.args[1] ?? 'Pull request creation did not complete.');
		assert(confirm.calledOnce);
		assert.match(confirm.firstCall.args[1].detail ?? '', /so it will be disabled for #795\.$/);
		sinon.assert.callOrder(confirm, create, disable, addToStack);
		cancellation.dispose();
	});

	it('does not create a pull request when disabling auto-merge on the stack parent is declined', async function () {
		const cancellation = new vscode.CancellationTokenSource();
		sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) => task({ report: () => undefined }, cancellation.token));
		sinon.stub(githubRepository, 'getStackCandidate').resolves({ parentPullRequestNumber: 795, size: 1, url: 'https://github.com/github/test/pull/795' });
		sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName').resolves(githubRepository);
		const disable = sinon.stub(stubStackParent(true), 'disableAutoMerge').resolves();
		sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
		sinon.stub(model, 'filesHaveChanges').resolves(false);
		const create = sinon.stub(folderManager, 'createPullRequest');
		const throwError = sinon.stub(provider, '_throwError').resolves();
		let finish!: () => void;
		const finished = new Promise<void>(resolve => { finish = resolve; });
		sinon.stub(provider, '_replyMessage').callsFake(async () => { finish(); });

		await provider.createForTest({
			command: 'pr.create', req: '5',
			args: {
				title: 'Second change', body: '', owner: 'github', repo: 'test', base: 'D3',
				compareOwner: 'github', compareRepo: 'test', compareBranch: 'D4',
				draft: false, autoMerge: false, labels: [], projects: [], assignees: [], reviewers: [],
				addToStack: true, stackParentPullRequest: 795,
			},
		});
		await finished;

		assert(create.notCalled);
		assert(disable.notCalled);
		assert(throwError.notCalled);
		cancellation.dispose();
	});

	it('reports a failed stack addition while still applying PR details', async function () {
		const cancellation = new vscode.CancellationTokenSource();
		sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) => task({ report: () => undefined }, cancellation.token));
		const candidate: StackCandidate = { parentPullRequestNumber: 795, stackNumber: 12, size: 3, url: 'https://github.com/github/test/pull/795' };
		sinon.stub(githubRepository, 'getStackCandidate').resolves(candidate);
		sinon.stub(folderManager, 'createGitHubRepositoryFromOwnerName').resolves(githubRepository);
		stubStackParent();
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

describe('Create pull request with unpushed commits', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;
	let credentials: CredentialStore;
	let folderManager: FolderRepositoryManager;
	let repository: MockRepository;
	let origin: MockGitHubRepository;
	let createdRepositories: MockGitHubRepository[];
	let gitHubRepositories: MockGitHubRepository[];
	let provider: TestCreatePullRequestViewProvider;
	let model: CreatePullRequestDataModel;
	let cancellation: vscode.CancellationTokenSource;
	let postMessage: SinonStub;
	let throwError: SinonStub;
	let finishWithoutPullRequest: () => void;

	function createRepository(remoteName: string, owner: string, url = `https://github.com/${owner}/test`, serverType = GitHubServerType.GitHubDotCom): MockGitHubRepository {
		const remote = new GitHubRemote(remoteName, url, new Protocol(url), serverType);
		const githubRepository = new MockGitHubRepository(remote, credentials, telemetry, sinon);
		createdRepositories.push(githubRepository);
		return githubRepository;
	}

	/** Like forking: `origin` points to the fork, and the original remote, which the branch then tracks, is renamed to `upstream`. */
	async function forkOrigin(fork: MockGitHubRepository, upstream: MockGitHubRepository): Promise<string> {
		gitHubRepositories = [fork, upstream];
		await repository.removeRemote('origin');
		await repository.addRemote('upstream', upstream.remote.url);
		await repository.addRemote('origin', fork.remote.url);
		await repository.setBranchUpstream('D4', 'refs/remotes/upstream/D4');
		return 'origin';
	}

	function createMessage(req: string): { command: string; args: CreatePullRequestNew; req: string } {
		return {
			command: 'pr.create', req,
			args: {
				title: 'Fix typo', body: '', owner: 'github', repo: 'test', base: 'main',
				compareOwner: 'github', compareRepo: 'test', compareBranch: 'D4',
				draft: false, autoMerge: false, labels: [], projects: [], assignees: [], reviewers: [],
			},
		};
	}

	function createPullRequestModel(githubRepository: MockGitHubRepository): PullRequestModel {
		return new PullRequestModel(credentials, new MockTelemetry(), githubRepository, githubRepository.remote,
			convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(796).build(), githubRepository));
	}

	/** Creates the pull request from the view, and resolves with whether it was created. */
	async function createFromView(req: string): Promise<boolean> {
		const created = asPromise(provider.onDone).then(() => true);
		const notCreated = new Promise<boolean>(resolve => { finishWithoutPullRequest = () => resolve(false); });
		await provider.createForTest(createMessage(req));
		return Promise.race([created, notCreated]);
	}

	beforeEach(async function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentials = new CredentialStore(telemetry, context);
		repository = new MockRepository();
		const manager = new RepositoriesManager(credentials, telemetry);
		folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(manager), credentials, new CreatePullRequestHelper(), new MockThemeWatcher());
		createdRepositories = [];
		origin = createRepository('origin', 'github');
		await repository.addRemote('origin', origin.remote.url);
		gitHubRepositories = [origin];
		sinon.stub(folderManager, 'gitHubRepositories').get(() => gitHubRepositories);
		sinon.stub(folderManager, 'findRepo').callsFake(predicate => gitHubRepositories.find(predicate));
		sinon.stub(folderManager, 'getGitHubRemotes').callsFake(async () => gitHubRepositories.map(githubRepository => githubRepository.remote));
		// Like the real method, returns the known repository for a remote, and otherwise adds one (created by the test).
		sinon.stub(folderManager, 'createGitHubRepository').callsFake(async remote => {
			const matches = (githubRepository: MockGitHubRepository) => (githubRepository.remote.remoteName === remote.remoteName)
				&& (githubRepository.remote.owner === remote.owner) && (githubRepository.remote.repositoryName === remote.repositoryName);
			const known = gitHubRepositories.find(matches);
			if (known) {
				return known;
			}
			const added = createdRepositories.find(matches);
			if (!added) {
				throw new Error(`Unexpected repository ${remote.owner}/${remote.repositoryName}`);
			}
			gitHubRepositories.push(added);
			return added;
		});
		await repository.createBranch('D4', false, 'commit-sha');
		await repository.setBranchUpstream('D4', 'refs/remotes/origin/D4');
		// D4 has a commit that hasn't been pushed to the branch it tracks yet.
		const getBranch = repository.getBranch.bind(repository);
		sinon.stub(repository, 'getBranch').callsFake(async name => ({ ...(await getBranch(name)), ahead: 1, behind: 0 }));
		sinon.stub(repository, 'status').resolves();
		repository.expectFetch('origin', 'D4');
		sinon.stub(origin, 'hasBranch').resolves('parent-sha');
		// The view's lookups for existing and stacked pull requests don't finish during these tests, so the view only
		// gets what creating the pull request sends to it directly.
		sinon.stub(PullRequestGitHelper, 'getMatchingPullRequestMetadataForBranches').returns(new Promise(() => { }));
		model = new CreatePullRequestDataModel(folderManager, 'github', 'main', 'github', 'D4', 'test');
		provider = new TestCreatePullRequestViewProvider(telemetry, model, vscode.Uri.file(__dirname), folderManager, { owner: 'github', repo: 'test', base: 'main' });
		cancellation = new vscode.CancellationTokenSource();
		sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) => task({ report: () => undefined }, cancellation.token));
		sinon.stub(model, 'filesHaveChanges').resolves(false);
		sinon.stub(provider, 'postCreate').resolves();
		postMessage = sinon.stub(provider, '_postMessage').resolves();
		throwError = sinon.stub(provider, '_throwError').resolves();
		// Creating the pull request replies to the view only when it finishes without a pull request.
		sinon.stub(provider, '_replyMessage').callsFake(async () => finishWithoutPullRequest());
	});

	afterEach(function () {
		provider.dispose();
		model.dispose();
		folderManager.dispose();
		createdRepositories.forEach(githubRepository => githubRepository.dispose());
		cancellation.dispose();
		credentials.dispose();
		context.dispose();
		sinon.restore();
	});

	it('pushes the commits to the tracked remote when the user can push to it', async function () {
		sinon.stub(origin, 'getViewerPermission').resolves(ViewerPermission.Write);
		const prompt = sinon.stub(vscode.window, 'showInformationMessage').resolves('Push Commits' as never);
		const doFork = sinon.stub(folderManager, 'doFork');
		repository.expectPush('origin', 'D4', true);
		const push = sinon.spy(repository, 'push');
		const createdPR = createPullRequestModel(origin);
		const create = sinon.stub(folderManager, 'createPullRequest').resolves(createdPR);

		assert(await createFromView('1'), throwError.firstCall?.args[1] ?? 'The pull request was not created.');
		assert(prompt.calledOnce);
		assert(doFork.notCalled);
		assert(push.calledOnceWithExactly('origin', 'D4', true));
		assert(create.calledOnce);
		assert.strictEqual(create.firstCall.args[0].head, 'github:D4');
		sinon.assert.callOrder(push, create);
	});

	it('offers to fork and creates the pull request from the fork when the user cannot push to the tracked remote', async function () {
		sinon.stub(origin, 'getViewerPermission').resolves(ViewerPermission.Read);
		const prompt = sinon.stub(vscode.window, 'showInformationMessage');
		prompt.onFirstCall().resolves('Push Commits' as never);
		prompt.onSecondCall().resolves('Fork' as never);
		const fork = createRepository('origin', 'contributor');
		const upstream = createRepository('upstream', 'github');
		const doFork = sinon.stub(folderManager, 'doFork').callsFake(() => forkOrigin(fork, upstream));
		repository.expectPush('origin', 'D4', true);
		const push = sinon.spy(repository, 'push');
		const createdPR = createPullRequestModel(upstream);
		let viewSelectedForkBeforeCreate = false;
		const create = sinon.stub(folderManager, 'createPullRequest').callsFake(async () => {
			viewSelectedForkBeforeCreate = postMessage.calledWithMatch({ command: 'pr.initialize', params: { compareRemote: { owner: 'contributor', repositoryName: 'test' } } });
			return createdPR;
		});

		assert(await createFromView('2'), throwError.firstCall?.args[1] ?? 'The pull request was not created.');
		assert(prompt.calledTwice);
		assert.match(prompt.secondCall.args[0], /^You don't have permission to push to github\/test\./);
		assert(doFork.calledOnce);
		assert.strictEqual(doFork.firstCall.args[0], origin);
		assert(push.calledOnceWithExactly('origin', 'D4', true));
		assert(create.calledOnce);
		const params = create.firstCall.args[0];
		assert.strictEqual(params.owner, 'github');
		assert.strictEqual(params.repo, 'test');
		assert.strictEqual(params.head, 'contributor:D4');
		sinon.assert.callOrder(doFork, push, create);
		// The view selects the fork before the pull request is created, so that a retry from it also uses the fork as the head.
		assert.strictEqual(model.compareOwner, 'contributor');
		assert(viewSelectedForkBeforeCreate);
	});

	it('pushes to the fork without forking again when retrying after the push to a new fork failed', async function () {
		sinon.stub(origin, 'getViewerPermission').resolves(ViewerPermission.Read);
		const prompt = sinon.stub(vscode.window, 'showInformationMessage');
		prompt.onFirstCall().resolves('Push Commits' as never);
		prompt.onSecondCall().resolves('Fork' as never);
		prompt.onThirdCall().resolves('Push Commits' as never);
		const warning = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
		const fork = createRepository('origin', 'contributor');
		const upstream = createRepository('upstream', 'github');
		sinon.stub(fork, 'getRepositoryForkDetails').resolves({ isFork: true, parent: { owner: { login: 'github' }, name: 'test' } });
		sinon.stub(fork, 'getViewerPermission').resolves(ViewerPermission.Write);
		sinon.stub(upstream, 'getViewerPermission').resolves(ViewerPermission.Read);
		const doFork = sinon.stub(folderManager, 'doFork').callsFake(() => forkOrigin(fork, upstream));
		const push = sinon.stub(repository, 'push');
		push.onFirstCall().rejects(Object.assign(new Error('Updates were rejected'), { gitErrorCode: GitErrorCodes.PushRejected }));
		push.onSecondCall().resolves();
		repository.expectFetch('upstream', 'D4');
		const createdPR = createPullRequestModel(upstream);
		const create = sinon.stub(folderManager, 'createPullRequest').resolves(createdPR);

		assert.strictEqual(await createFromView('4'), false);
		assert(doFork.calledOnce);
		assert(warning.calledOnce);
		assert(create.notCalled);

		assert(await createFromView('5'), throwError.firstCall?.args[1] ?? 'The pull request was not created.');
		assert.strictEqual(prompt.callCount, 3);
		assert(doFork.calledOnce);
		assert(push.calledTwice);
		assert(push.alwaysCalledWithExactly('origin', 'D4', true));
		assert(create.calledOnce);
		assert.strictEqual(create.firstCall.args[0].head, 'contributor:D4');
	});

	for (const pushUrl of ['https://github.com/contributor/test', 'ssh://git@ssh.github.com:443/contributor/test.git']) {
		it(`pushes the commits to the repository that the tracked remote's push URL points to: ${pushUrl}`, async function () {
			// `origin` fetches from github/test, which the user can't push to, but pushes to their fork.
			await repository.removeRemote('origin');
			await repository.addRemote('origin', origin.remote.url, pushUrl);
			sinon.stub(origin, 'getViewerPermission').resolves(ViewerPermission.Read);
			const pushTarget = createRepository('origin', 'contributor');
			sinon.stub(pushTarget, 'getViewerPermission').resolves(ViewerPermission.Write);
			const prompt = sinon.stub(vscode.window, 'showInformationMessage').resolves('Push Commits' as never);
			const doFork = sinon.stub(folderManager, 'doFork');
			repository.expectPush('origin', 'D4', true);
			const push = sinon.spy(repository, 'push');
			const createdPR = createPullRequestModel(origin);
			const create = sinon.stub(folderManager, 'createPullRequest').resolves(createdPR);

			assert(await createFromView('6'), throwError.firstCall?.args[1] ?? 'The pull request was not created.');
			assert(prompt.calledOnce);
			assert(doFork.notCalled);
			assert(push.calledOnceWithExactly('origin', 'D4', true));
			assert(create.calledOnce);
			assert.strictEqual(create.firstCall.args[0].head, 'contributor:D4');
			assert.strictEqual(model.compareOwner, 'contributor');
		});
	}

	for (const { description, remoteName, url, pushUrl, serverType } of [
		{ description: 'is on another server', remoteName: 'fork', url: 'https://ghe.example.com/contributor/test', pushUrl: 'https://ghe.example.com/contributor/test', serverType: GitHubServerType.Enterprise },
		{ description: 'pushes to another repository', remoteName: 'fork', url: 'https://github.com/contributor/test', pushUrl: 'https://github.com/github/test', serverType: GitHubServerType.GitHubDotCom },
		// A repository that is only known through the API uses its name as the remote name.
		{ description: 'has no Git remote', remoteName: 'test', url: 'https://github.com/contributor/test', pushUrl: undefined, serverType: GitHubServerType.GitHubDotCom },
	]) {
		it(`offers to fork instead of pushing to a writable fork that ${description}`, async function () {
			sinon.stub(origin, 'getViewerPermission').resolves(ViewerPermission.Read);
			const fork = createRepository(remoteName, 'contributor', url, serverType);
			gitHubRepositories.push(fork);
			if (pushUrl) {
				await repository.addRemote(remoteName, url, pushUrl);
			}
			sinon.stub(fork, 'getRepositoryForkDetails').resolves({ isFork: true, parent: { owner: { login: 'github' }, name: 'test' } });
			sinon.stub(fork, 'getViewerPermission').resolves(ViewerPermission.Write);
			const prompt = sinon.stub(vscode.window, 'showInformationMessage');
			prompt.onFirstCall().resolves('Push Commits' as never);
			prompt.onSecondCall().resolves('Don\'t Fork' as never);
			const push = sinon.spy(repository, 'push');
			const create = sinon.stub(folderManager, 'createPullRequest');

			assert.strictEqual(await createFromView('7'), false);
			assert(prompt.calledTwice);
			assert.match(prompt.secondCall.args[0], /^You don't have permission to push to github\/test\./);
			assert(push.notCalled);
			assert(create.notCalled);
		});
	}

	it('does not create a pull request when forking is declined', async function () {
		sinon.stub(origin, 'getViewerPermission').resolves(ViewerPermission.Read);
		const prompt = sinon.stub(vscode.window, 'showInformationMessage');
		prompt.onFirstCall().resolves('Push Commits' as never);
		prompt.onSecondCall().resolves('Don\'t Fork' as never);
		const doFork = sinon.stub(folderManager, 'doFork');
		const push = sinon.spy(repository, 'push');
		const create = sinon.stub(folderManager, 'createPullRequest');

		assert.strictEqual(await createFromView('3'), false);
		assert(prompt.calledTwice);
		assert(doFork.notCalled);
		assert(push.notCalled);
		assert(create.notCalled);
		assert(throwError.notCalled);
	});
});

describe('Create pull request for a branch created from the remote HEAD', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let credentials: CredentialStore;
	let folderManager: FolderRepositoryManager;
	let repository: MockRepository;
	let githubRepository: MockGitHubRepository;
	let provider: TestCreatePullRequestViewProvider;
	let model: CreatePullRequestDataModel;
	let cancellation: vscode.CancellationTokenSource;
	let getBranch: SinonStub;
	let showInformationMessage: SinonStub;

	beforeEach(async function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		context = new MockExtensionContext();
		const telemetry = new MockTelemetry();
		credentials = new CredentialStore(telemetry, context);
		repository = new MockRepository();
		const manager = new RepositoriesManager(credentials, telemetry);
		folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(manager), credentials, new CreatePullRequestHelper(), new MockThemeWatcher());
		const url = 'https://github.com/github/test';
		await repository.addRemote('origin', url);
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		githubRepository = new MockGitHubRepository(remote, credentials, telemetry, sinon);
		sinon.stub(folderManager, 'gitHubRepositories').get(() => [githubRepository]);
		sinon.stub(folderManager, 'findRepo').callsFake(predicate => predicate(githubRepository) ? githubRepository : undefined);
		// `git switch -c feature origin/HEAD` sets the upstream to `origin/main`, not `origin/feature`.
		await repository.createBranch('feature', false, 'feature-sha');
		await repository.setBranchUpstream('feature', 'refs/remotes/origin/main');
		sinon.stub(githubRepository, 'hasBranch').resolves('feature-sha');
		model = new CreatePullRequestDataModel(folderManager, 'github', 'main', 'github', 'feature', 'test');
		provider = new TestCreatePullRequestViewProvider(telemetry, model, vscode.Uri.file(__dirname), folderManager, { owner: 'github', repo: 'test', base: 'main' });
		cancellation = new vscode.CancellationTokenSource();
		sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) => task({ report: () => undefined }, cancellation.token));
		sinon.stub(model, 'filesHaveChanges').resolves(false);
		getBranch = sinon.stub(repository, 'getBranch').callThrough();
		showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage');
		// Pushing commits publishes the branch, which checks the permission to push to the remote first.
		sinon.stub(folderManager, 'createGitHubRepository').resolves(githubRepository);
		sinon.stub(githubRepository, 'getViewerPermission').resolves(ViewerPermission.Write);
		sinon.stub(repository, 'status').resolves();
	});

	afterEach(function () {
		cancellation.dispose();
		provider.dispose();
		model.dispose();
		folderManager.dispose();
		githubRepository.dispose();
		credentials.dispose();
		context.dispose();
		sinon.restore();
	});

	function stubFeatureBranch(ahead: number) {
		getBranch.withArgs('feature').resolves({ type: RefType.Head, name: 'feature', commit: 'feature-sha', upstream: { remote: 'origin', name: 'main' }, ahead, behind: 0 });
	}

	async function createPullRequest(): Promise<void> {
		const createdPR = new PullRequestModel(credentials, new MockTelemetry(), githubRepository, githubRepository.remote,
			convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(796).build(), githubRepository));
		const create = sinon.stub(folderManager, 'createPullRequest').resolves(createdPR);
		sinon.stub(provider, 'postCreate').resolves();
		const throwError = sinon.stub(provider, '_throwError').resolves();
		const done = asPromise(provider.onDone);

		await provider.createForTest({
			command: 'pr.create', req: '1',
			args: {
				title: 'Feature', body: '', owner: 'github', repo: 'test', base: 'main',
				compareOwner: 'github', compareRepo: 'test', compareBranch: 'feature',
				draft: false, autoMerge: false, labels: [], projects: [], assignees: [], reviewers: [],
			},
		});
		assert.strictEqual(await done, createdPR, throwError.firstCall?.args[1] ?? 'Pull request creation did not complete.');
		assert(create.calledOnce);
		assert.strictEqual(create.firstCall.args[0].head, 'github:feature');
	}

	it('uses the default branch as the base instead of HEAD', async function () {
		sinon.stub(repository, 'getBranchBase').resolves({ type: RefType.RemoteHead, name: 'HEAD', remote: 'origin', commit: 'main-sha' });
		githubRepository.buildMetadata(metadata => metadata.default_branch('develop'));

		const baseMetadata = await provider.detectBaseMetadata(await repository.getBranch('feature'));

		assert.deepStrictEqual(baseMetadata, { branch: 'develop', owner: 'github', repositoryName: 'test' });
	});

	it('does not ask to push commits that are already on the remote branch', async function () {
		stubFeatureBranch(1);
		getBranch.withArgs('refs/remotes/origin/feature').resolves({ type: RefType.RemoteHead, name: 'feature', remote: 'origin', commit: 'feature-sha' });
		repository.expectFetch('origin', 'main');
		repository.expectFetch('origin', 'feature');
		const push = sinon.spy(repository, 'push');

		await createPullRequest();

		assert(showInformationMessage.notCalled);
		assert(push.notCalled);
	});

	it('asks to push only the commits that are not on the remote branch', async function () {
		stubFeatureBranch(3);
		getBranch.withArgs('refs/remotes/origin/feature').resolves({ type: RefType.RemoteHead, name: 'feature', remote: 'origin', commit: 'pushed-sha' });
		repository.expectFetch('origin', 'main');
		repository.expectFetch('origin', 'feature');
		const log = sinon.stub(repository, 'log').resolves([{ hash: 'feature-sha', message: 'Unpushed change', parents: ['pushed-sha'] }]);
		showInformationMessage.resolves('Push Commits');
		// Publishing the branch also makes it track `origin/feature` instead of `origin/main`.
		repository.expectPush('origin', 'feature', true);
		const push = sinon.spy(repository, 'push');

		await createPullRequest();

		assert(log.calledOnceWithExactly({ range: 'refs/remotes/origin/feature..refs/heads/feature' }));
		assert(showInformationMessage.calledOnce);
		assert.match(showInformationMessage.firstCall.args[0], /^You have 1 unpushed commit\(s\) on 'feature'\./);
		assert(push.calledOnceWithExactly('origin', 'feature', true));
	});

	it('asks to push all the commits ahead of the upstream when the branch has not been pushed', async function () {
		stubFeatureBranch(2);
		repository.expectFetch('origin', 'main');
		const fetch = sinon.stub(repository, 'fetch').callThrough();
		fetch.withArgs('origin', 'feature').rejects(new Error('fatal: couldn\'t find remote ref feature'));
		showInformationMessage.resolves('Push Commits');
		repository.expectPush('origin', 'feature', true);
		const push = sinon.spy(repository, 'push');

		await createPullRequest();

		assert(showInformationMessage.calledOnce);
		assert.match(showInformationMessage.firstCall.args[0], /^You have 2 unpushed commit\(s\) on 'feature'\./);
		assert(push.calledOnceWithExactly('origin', 'feature', true));
	});
});
