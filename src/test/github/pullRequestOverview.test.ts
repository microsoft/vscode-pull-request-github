/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { SinonSandbox, SinonStub, createSandbox, match as sinonMatch } from 'sinon';

import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockRepository } from '../mocks/mockRepository';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { IssueOverviewPanel, panelKey } from '../../github/issueOverview';
import { IssueModel } from '../../github/issueModel';
import { PullRequestModel } from '../../github/pullRequestModel';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { Protocol } from '../../common/protocol';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { Repository } from '../../api/api';
import { GitApiImpl } from '../../api/api1';
import { RemoteOnlyRepository } from '../../api/remoteOnlyRepository';
import { FolderRepositoryManagerResolver } from '../../github/folderRepositoryManagerResolver';
import { openDescription } from '../../commands';
import { EXTENSION_ID } from '../../constants';
import { CredentialStore } from '../../github/credentials';
import { GitHubServerType } from '../../common/authentication';
import { GitHubRemote } from '../../common/remote';
import { CheckState, GithubItemStateEnum, IAccount, MergeMethod, MergeQueueState, PullRequestMergeability, PullRequestStack } from '../../github/interface';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';
import { GitHubRef } from '../../common/githubRef';
import { mockStackSetting } from '../mocks/mockStackSetting';
import { TimelineEvent } from '../../common/timelineEvent';
import { PullRequestReviewCommon, ReviewContext } from '../../github/pullRequestReviewCommon';
import { COPILOT_REVIEWER_ACCOUNT } from '../../common/copilot';
import * as emoji from '../../common/emoji';
import Logger from '../../common/logger';
import { Issue, IssuePreview, OverviewItemPreview, PullRequest, PullRequestPreview } from '../../github/views';
import { IRequestMessage } from '../../common/webview';

const EXTENSION_URI = vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri;

class TestPullRequestOverviewPanel extends PullRequestOverviewPanel {
	constructor(telemetry: MockTelemetry, folderRepositoryManager: FolderRepositoryManager) {
		super(telemetry, EXTENSION_URI, vscode.ViewColumn.One, '#1000', folderRepositoryManager);
	}

	public override processLinksInBodyHtml(bodyHTML: string | undefined): Promise<string | undefined> {
		return super.processLinksInBodyHtml(bodyHTML);
	}

	public override _postMessage(message: { command: string; isCurrentlyCheckedOut?: boolean; pullrequest?: Partial<PullRequest> }): Promise<void> {
		return super._postMessage(message);
	}

	public setItem(item: PullRequestModel): void {
		this._item = item;
		this._identity = { owner: item.remote.owner, repo: item.remote.repositoryName, number: item.number };
		TestPullRequestOverviewPanel._panels.set(panelKey(item.remote.owner, item.remote.repositoryName, item.number), this);
		this.registerPrListeners();
	}

	public get folderRepositoryManager(): FolderRepositoryManager {
		return this._folderRepositoryManager;
	}

	public override _onDidReceiveMessage(message: IRequestMessage<unknown>) {
		return super._onDidReceiveMessage(message);
	}

	public override _replyMessage(message: IRequestMessage<unknown>, response: unknown): Promise<void> {
		return super._replyMessage(message, response);
	}
}

describe('PullRequestOverview', function () {
	let sinon: SinonSandbox;
	let pullRequestManager: FolderRepositoryManager;
	let context: MockExtensionContext;
	let remote: GitHubRemote;
	let repo: MockGitHubRepository;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;
	let mockThemeWatcher: MockThemeWatcher;
	let repositoriesManager: RepositoriesManager;
	let setStacksEnabled: (enabled: boolean) => void;
	let panelServices: ReturnType<typeof stubPanelServices> | undefined;

	beforeEach(async function () {
		sinon = createSandbox();
		panelServices = undefined;
		MockCommandRegistry.install(sinon);
		setStacksEnabled = mockStackSetting(sinon);
		context = new MockExtensionContext();

		const repository = new MockRepository();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		mockThemeWatcher = new MockThemeWatcher();
		const createPrHelper = new CreatePullRequestHelper();
		repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		pullRequestManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(repositoriesManager), credentialStore, createPrHelper, mockThemeWatcher);

		const url = 'https://github.com/aaa/bbb';
		remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		repo = new MockGitHubRepository(remote, pullRequestManager.credentialStore, telemetry, sinon);
	});

	afterEach(function () {
		// Dispose all open panels
		for (const panel of (PullRequestOverviewPanel as any)._panels.values()) {
			panel.dispose();
		}
		IssueOverviewPanel.clearAll();

		pullRequestManager.dispose();
		repositoriesManager.dispose();
		repo.dispose();
		credentialStore.dispose();
		context.dispose();
		try {
			if (panelServices) {
				sinon.assert.notCalled(panelServices.query);
			}
		} finally {
			sinon.restore();
		}
	});

	function previewLoadingTests<TItem extends IssueModel, TPreview extends OverviewItemPreview>(fixture: () => {
		model: TItem;
		preview: TPreview;
		getPreview: SinonStub<[number], Promise<TPreview>>;
		getRepository: SinonStub<Parameters<FolderRepositoryManager['createGitHubRepositoryFromOwnerName']>, ReturnType<FolderRepositoryManager['createGitHubRepositoryFromOwnerName']>>;
		getRepositoryAccess: SinonStub<Parameters<FolderRepositoryManager['getPullRequestRepositoryAccessAndMergeMethods']>, ReturnType<FolderRepositoryManager['getPullRequestRepositoryAccessAndMergeMethods']>>;
		getAssignableUsers: SinonStub<Parameters<FolderRepositoryManager['getAssignableUsers']>, ReturnType<FolderRepositoryManager['getAssignableUsers']>>;
		openPanel: (model?: TItem | Promise<TItem>) => Promise<void>;
		messages: { command: string; pullrequest?: Partial<Issue> }[];
		webviewPanel: vscode.WebviewPanel;
	}) {
		it('shows the title and description while the full model is still pending', async function () {
			const { model, preview, openPanel, messages, getAssignableUsers } = fixture();
			let resolveModel!: (model: TItem) => void;
			const opening = openPanel(new Promise<TItem>(resolve => resolveModel = resolve));
			try {
				await new Promise(resolve => setImmediate(resolve));
				assert.deepStrictEqual(messages.find(message => message.command === 'pr.preview')?.pullrequest, preview);
				assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
				sinon.assert.notCalled(getAssignableUsers);
			} finally {
				resolveModel(model);
				await opening;
			}
			assert.ok(messages.some(message => message.command === 'pr.initialize'));
		});

		it('does not fetch a preview for an already available model', async function () {
			const { openPanel, getPreview, getRepository } = fixture();
			await openPanel();
			sinon.assert.notCalled(getRepository);
			sinon.assert.notCalled(getPreview);
		});

		for (const previewHasStarted of [false, true]) {
			it(`shows a preview during slow initialization when the model resolves ${previewHasStarted ? 'after' : 'before'} the preview query starts`, async function () {
				const { model, preview, getPreview, getRepositoryAccess, openPanel, messages } = fixture();
				let resolveModel: ((model: TItem) => void) | undefined;
				let resolvePreview!: (preview: TPreview) => void;
				let resolveAccess!: (access: Awaited<ReturnType<FolderRepositoryManager['getPullRequestRepositoryAccessAndMergeMethods']>>) => void;
				getRepositoryAccess.returns(new Promise(resolve => resolveAccess = resolve));
				getPreview.returns(new Promise(resolve => resolvePreview = resolve));
				const pendingModel = previewHasStarted
					? new Promise<TItem>(resolve => resolveModel = resolve)
					: Promise.resolve(model);
				const opening = openPanel(pendingModel);
				try {
					if (previewHasStarted) {
						await new Promise(resolve => setImmediate(resolve));
						sinon.assert.calledOnce(getPreview);
						resolveModel!(model);
					}
					await new Promise(resolve => setImmediate(resolve));
					sinon.assert.calledOnce(getRepositoryAccess);
					assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);

					resolvePreview(preview);
					await new Promise(resolve => setImmediate(resolve));
					assert.deepStrictEqual(messages.filter(message => message.command === 'pr.preview').pop()?.pullrequest, preview);
					assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
				} finally {
					resolveModel?.(model);
					resolvePreview(preview);
					resolveAccess({
						hasWritePermission: true,
						mergeMethodsAvailability: { merge: true, squash: true, rebase: true },
						viewerCanAutoMerge: false,
					});
					await opening;
				}
				assert.ok(messages.some(message => message.command === 'pr.initialize'));
			});
		}

		it('ignores a preview from an older lookup while a newer lookup is pending', async function () {
			const { model, preview, getPreview, openPanel, messages } = fixture();
			let resolvePreview!: (value: TPreview) => void;
			let resolveFirst!: (value: TItem) => void;
			let resolveSecond!: (value: TItem) => void;
			getPreview.onFirstCall().returns(new Promise(resolve => resolvePreview = resolve));
			const first = openPanel(new Promise<TItem>(resolve => resolveFirst = resolve));
			await new Promise(resolve => setImmediate(resolve));
			const second = openPanel(new Promise<TItem>(resolve => resolveSecond = resolve));
			try {
				await new Promise(resolve => setImmediate(resolve));
				messages.length = 0;
				resolvePreview(preview);
				await new Promise(resolve => setImmediate(resolve));
				assert.strictEqual(messages.some(message => message.command === 'pr.preview'), false);
			} finally {
				resolveFirst(model);
				resolveSecond(model);
				await Promise.all([first, second]);
			}
		});

		it('does not let a late preview replace the complete model', async function () {
			const { model, preview, getPreview, openPanel, messages } = fixture();
			let resolvePreview!: (value: TPreview) => void;
			let resolveModel!: (value: TItem) => void;
			getPreview.returns(new Promise(resolve => resolvePreview = resolve));
			const opening = openPanel(new Promise<TItem>(resolve => resolveModel = resolve));
			await new Promise(resolve => setImmediate(resolve));
			resolveModel(model);
			await opening;
			const previews = messages.filter(message => message.command === 'pr.preview');
			resolvePreview(preview);
			await new Promise(resolve => setImmediate(resolve));

			assert.deepStrictEqual(messages.filter(message => message.command === 'pr.preview'), previews);
			assert.ok(messages.some(message => message.command === 'pr.initialize'));
		});

		it('ignores a preview that finishes after the panel is closed', async function () {
			const { model, preview, getPreview, openPanel, messages, webviewPanel } = fixture();
			let resolvePreview!: (value: TPreview) => void;
			let resolveModel!: (value: TItem) => void;
			getPreview.returns(new Promise(resolve => resolvePreview = resolve));
			const opening = openPanel(new Promise<TItem>(resolve => resolveModel = resolve));
			await new Promise(resolve => setImmediate(resolve));
			webviewPanel.dispose();
			resolvePreview(preview);
			resolveModel(model);
			await opening;

			assert.strictEqual(messages.some(message => message.command === 'pr.preview'), false);
		});

		it('logs a preview failure without preventing full initialization', async function () {
			const { model, preview, getPreview, openPanel, messages } = fixture();
			let resolveModel!: (value: TItem) => void;
			getPreview.rejects(new Error('Preview unavailable'));
			const logError = sinon.spy(Logger, 'error');
			const opening = openPanel(new Promise<TItem>(resolve => resolveModel = resolve));
			try {
				await new Promise(resolve => setImmediate(resolve));
				sinon.assert.calledWith(logError,
					`Unable to load ${preview.isIssue ? 'Issue' : 'PR'} overview preview: Preview unavailable`,
					preview.isIssue ? IssueOverviewPanel.ID : PullRequestOverviewPanel.ID);
			} finally {
				resolveModel(model);
				await opening;
			}
			assert.ok(messages.some(message => message.command === 'pr.initialize'));
		});

		it('loads the webview before a supplied model resolves', async function () {
			const { model, openPanel, messages, webviewPanel, getAssignableUsers } = fixture();
			let resolveModel!: (model: TItem) => void;
			const opening = openPanel(new Promise<TItem>(resolve => resolveModel = resolve));
			try {
				assert.ok(webviewPanel.webview.html.includes('webview-pr-description.js'));
				assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
				sinon.assert.notCalled(getAssignableUsers);
			} finally {
				resolveModel(model);
				await opening;
			}
			assert.strictEqual(messages.find(message => message.command === 'pr.initialize')?.pullrequest?.title, model.title);
		});

		it('does not initialize a closed panel when its model resolves', async function () {
			const { model, openPanel, messages, webviewPanel, getAssignableUsers } = fixture();
			let resolveModel!: (model: TItem) => void;
			const opening = openPanel(new Promise<TItem>(resolve => resolveModel = resolve));
			webviewPanel.dispose();
			resolveModel(model);
			await opening;

			assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
			sinon.assert.notCalled(getAssignableUsers);
		});

		it('does not overwrite a newer model when an older lookup finishes', async function () {
			const { model, openPanel, messages, getAssignableUsers } = fixture();
			let resolveModel!: (model: TItem) => void;
			const opening = openPanel(new Promise<TItem>(resolve => resolveModel = resolve));
			await openPanel();
			messages.length = 0;
			resolveModel(model);
			await opening;

			assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
			sinon.assert.calledOnce(getAssignableUsers);
		});

		it('skips an older repository lookup while a newer model lookup is still pending', async function () {
			const { model, getRepository, getPreview, openPanel } = fixture();
			let resolveRepository!: (repository: MockGitHubRepository) => void;
			let resolveFirst!: (model: TItem) => void;
			let resolveSecond!: (model: TItem) => void;
			getRepository.onFirstCall().returns(new Promise(resolve => resolveRepository = resolve));
			const first = openPanel(new Promise<TItem>(resolve => resolveFirst = resolve));
			const second = openPanel(new Promise<TItem>(resolve => resolveSecond = resolve));
			try {
				await new Promise(resolve => setImmediate(resolve));
				sinon.assert.calledOnce(getPreview);
				resolveRepository(repo);
				await new Promise(resolve => setImmediate(resolve));
				sinon.assert.calledOnce(getPreview);
			} finally {
				resolveRepository(repo);
				resolveFirst(model);
				resolveSecond(model);
				await Promise.all([first, second]);
			}
		});

		for (const state of ['initialized', 'disposed']) {
			it(`skips the preview query when repository lookup finishes after the load is ${state}`, async function () {
				const { model, getRepository, getPreview, openPanel, webviewPanel } = fixture();
				let resolveRepository!: (repository: MockGitHubRepository) => void;
				let resolveModel!: (model: TItem) => void;
				getRepository.onFirstCall().returns(new Promise(resolve => resolveRepository = resolve));
				const opening = openPanel(new Promise<TItem>(resolve => resolveModel = resolve));
				try {
					sinon.assert.calledOnce(getRepository);
					if (state === 'disposed') {
						webviewPanel.dispose();
					}
					resolveModel(model);
					await opening;
				} finally {
					resolveRepository(repo);
					resolveModel(model);
					await opening;
				}
				await new Promise(resolve => setImmediate(resolve));
				sinon.assert.notCalled(getPreview);
			});
		}
	}

	describe('checkout status', function () {
		describe('remote-only manager upgrades', function () {
			let panel: TestPullRequestOverviewPanel;
			let model: PullRequestModel;
			let temporaryManager: FolderRepositoryManager;
			let discovered: boolean;
			let postMessage: SinonStub;

			beforeEach(function () {
				setStacksEnabled(false);
				discovered = false;
				sinon.stub(pullRequestManager, 'gitHubRepositories').get(() => discovered ? [repo] : []);
				repositoriesManager.insertFolderManager(pullRequestManager);
				PullRequestOverviewPanel.registerGlobalCommands(context, telemetry, repositoriesManager);
				const resolver = new FolderRepositoryManagerResolver(context, repositoriesManager, telemetry);
				context.subscriptions.push(resolver);
				temporaryManager = resolver.getRemoteOnlyManager();
				model = new PullRequestModel(credentialStore, telemetry, repo, remote,
					convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo));
				panel = new TestPullRequestOverviewPanel(telemetry, temporaryManager);
				panel.setItem(model);
				context.subscriptions.push(panel);
				postMessage = sinon.stub(panel, '_postMessage').resolves();
			});

			it('keeps the temporary manager when the repository has not been discovered', async function () {
				const openChanges = sinon.stub(PullRequestModel, 'openChanges').resolves();

				await panel._onDidReceiveMessage({ req: 'changes', command: 'pr.open-changes', args: undefined });

				assert.strictEqual(panel.folderRepositoryManager, temporaryManager);
				assert.ok(panel.folderRepositoryManager.repository instanceof RemoteOnlyRepository);
				sinon.assert.calledWithExactly(openChanges, temporaryManager, model, false);
			});

			it('upgrades on an operation after discovery without needing a checkout event', async function () {
				const openChanges = sinon.stub(PullRequestModel, 'openChanges').resolves();
				discovered = true;

				await panel._onDidReceiveMessage({ req: 'changes', command: 'pr.open-changes', args: { openToTheSide: true } });

				assert.strictEqual(panel.folderRepositoryManager, pullRequestManager);
				sinon.assert.calledWithExactly(openChanges, pullRequestManager, model, true);
			});

			it('checks out main and cleans up through the upgraded local manager', async function () {
				await pullRequestManager.repository.createBranch('pr-branch', true);
				await pullRequestManager.repository.createBranch('main', false);
				await pullRequestManager.repository.setBranchUpstream('main', 'refs/remotes/origin/main');
				pullRequestManager.activePullRequest = model;
				assert.strictEqual(panel.folderRepositoryManager, temporaryManager);
				discovered = true;
				const checkout = sinon.spy(pullRequestManager, 'checkoutDefaultBranch');
				const cleanup = sinon.stub(pullRequestManager, 'cleanupAfterPullRequest').resolves();
				const reply = sinon.stub(panel, '_replyMessage').resolves();
				const message = { req: 'exit', command: 'pr.checkout-default-branch', args: 'main' };

				await panel._onDidReceiveMessage(message);

				assert.strictEqual(pullRequestManager.repository.state.HEAD?.name, 'main');
				assert.strictEqual(panel.folderRepositoryManager, pullRequestManager);
				sinon.assert.calledWithExactly(checkout, 'main', model);
				sinon.assert.calledWithExactly(cleanup, 'pr-branch', model);
				sinon.assert.calledWithExactly(reply, message, {});
			});

			it('updates checkout status and moves listeners when the local repository becomes active', function () {
				discovered = true;
				pullRequestManager.activePullRequest = model;

				assert.strictEqual(panel.folderRepositoryManager, pullRequestManager);
				sinon.assert.calledOnce(postMessage);
				sinon.assert.calledWithMatch(postMessage, { command: 'pr.update-checkout-status', isCurrentlyCheckedOut: true });
				postMessage.resetHistory();
				temporaryManager.activePullRequest = model;
				sinon.assert.notCalled(postMessage);
				pullRequestManager.activePullRequest = undefined;
				sinon.assert.calledOnce(postMessage);
				sinon.assert.calledWithMatch(postMessage, { command: 'pr.update-checkout-status', isCurrentlyCheckedOut: false });
			});

			it('retains the upgraded local manager without looking it up again', function () {
				discovered = true;
				assert.strictEqual(panel.folderRepositoryManager, pullRequestManager);
				const lookup = sinon.spy(repositoriesManager, 'getManagerForRepository');
				discovered = false;

				assert.strictEqual(panel.folderRepositoryManager, pullRequestManager);
				sinon.assert.notCalled(lookup);
			});

			it('upgrades safely on the first access after the panel identity is set', function () {
				panel.dispose();
				discovered = true;
				panel = new TestPullRequestOverviewPanel(telemetry, temporaryManager);
				context.subscriptions.push(panel);
				assert.strictEqual(panel.folderRepositoryManager, temporaryManager);
				panel.setItem(model);
				postMessage = sinon.stub(panel, '_postMessage').resolves();

				assert.strictEqual(panel.folderRepositoryManager, pullRequestManager);
				pullRequestManager.activePullRequest = model;
				sinon.assert.calledOnce(postMessage);
			});
		});

		describe('repository ownership', function () {
			let panel: TestPullRequestOverviewPanel;
			let model: PullRequestModel;
			let postMessage: SinonStub;

			beforeEach(async function () {
				setStacksEnabled(false);
				await pullRequestManager.repository.addRemote('origin', remote.url);
				repositoriesManager.insertFolderManager(pullRequestManager);
				sinon.stub(pullRequestManager, 'gitHubRepositories').get(() => [repo]);
				const resolver = new FolderRepositoryManagerResolver(context, repositoriesManager, telemetry);
				context.subscriptions.push(resolver);
				const manager = resolver.getManagerForRepository(remote.owner, remote.repositoryName);
				assert.strictEqual(manager, pullRequestManager);
				PullRequestOverviewPanel.registerGlobalCommands(context, telemetry, repositoriesManager);
				model = new PullRequestModel(credentialStore, telemetry, repo, remote,
					convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo));
				panel = new TestPullRequestOverviewPanel(telemetry, manager);
				panel.setItem(model);
				context.subscriptions.push(panel);
				postMessage = sinon.stub(panel, '_postMessage').resolves();
			});

			it('checks out the default branch through the selected local manager', async function () {
				await pullRequestManager.repository.createBranch('pr-branch', true);
				await pullRequestManager.repository.createBranch('main', false);
				await pullRequestManager.repository.setBranchUpstream('main', 'refs/remotes/origin/main');
				pullRequestManager.activePullRequest = model;
				const checkout = sinon.spy(pullRequestManager, 'checkoutDefaultBranch');
				const cleanup = sinon.stub(pullRequestManager, 'cleanupAfterPullRequest').resolves();
				const reply = sinon.stub(panel, '_replyMessage').resolves();
				const message = { req: 'exit', command: 'pr.checkout-default-branch', args: 'main' };

				await panel._onDidReceiveMessage(message);

				assert.strictEqual(pullRequestManager.repository.state.HEAD?.name, 'main');
				sinon.assert.calledWithExactly(checkout, 'main', model);
				sinon.assert.calledWithExactly(cleanup, 'pr-branch', model);
				sinon.assert.calledWithExactly(reply, message, {});
			});

			it('does not change ownership when the same PR becomes active in another local repository', function () {
				const otherRepository = new MockRepository();
				otherRepository.rootUri = vscode.Uri.file('/other');
				const otherManager = new FolderRepositoryManager(2, context, otherRepository, telemetry,
					new GitApiImpl(repositoriesManager), credentialStore, new CreatePullRequestHelper(), mockThemeWatcher);
				repositoriesManager.insertFolderManager(otherManager);

				otherManager.activePullRequest = model;

				assert.strictEqual(panel.folderRepositoryManager, pullRequestManager);
				sinon.assert.calledWithMatch(postMessage, { command: 'pr.update-checkout-status', isCurrentlyCheckedOut: false });
				postMessage.resetHistory();
				pullRequestManager.activePullRequest = model;
				sinon.assert.calledOnce(postMessage);
				sinon.assert.calledWithMatch(postMessage, { command: 'pr.update-checkout-status', isCurrentlyCheckedOut: true });
			});

			it('reports checkout in the local repository when the checkout command completes', async function () {
				const executeCommand = sinon.stub(vscode.commands, 'executeCommand').callThrough();
				executeCommand.withArgs('pr.pick', model).callsFake(async () => {
					pullRequestManager.activePullRequest = model;
				});
				const reply = sinon.stub(panel, '_replyMessage').resolves();
				const message = { req: 'checkout', command: 'pr.checkout', args: undefined };

				await panel._onDidReceiveMessage(message);
				await new Promise(resolve => setImmediate(resolve));

				sinon.assert.calledWithExactly(reply, message, { isCurrentlyCheckedOut: true });
				assert.strictEqual(panel.folderRepositoryManager, pullRequestManager);
			});

			it('retains its original manager when an existing panel is reopened with a different manager', async function () {
				panel.dispose();
				const opened = await createPanel();
				const remoteRepository = new RemoteOnlyRepository();
				const otherManager = new FolderRepositoryManager(1, context, remoteRepository, telemetry,
					new GitApiImpl(repositoriesManager), credentialStore, new CreatePullRequestHelper(), mockThemeWatcher);
				context.subscriptions.push(remoteRepository, otherManager);
				opened.currentUser.resetHistory();
				const identity = { owner: remote.owner, repo: remote.repositoryName, number: opened.model.number };

				await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, otherManager, identity, opened.model);

				assert.strictEqual(PullRequestOverviewPanel.findPanel(identity.owner, identity.repo, identity.number), opened.panel);
				sinon.assert.calledOnce(opened.currentUser);
			});
		});

		for (const initiallyCheckedOut of [false, true]) {
			it(`initializes with the latest checkout state when ${initiallyCheckedOut ? 'leaving' : 'entering'} review mode during loading`, async function () {
				setStacksEnabled(false);
				const model = new PullRequestModel(credentialStore, telemetry, repo, remote,
					convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo));
				const identity = { owner: remote.owner, repo: remote.repositoryName, number: model.number };
				pullRequestManager.activePullRequest = initiallyCheckedOut ? model : undefined;
				sinon.stub(pullRequestManager, 'getCurrentUser').resolves(model.author);
				sinon.stub(model, 'getTimelineEvents').resolves([]);
				sinon.stub(model, 'getReviewRequests').resolves([]);
				sinon.stub(model, 'validateDraftMode').resolves(false);
				sinon.stub(model, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);
				const panel = new TestPullRequestOverviewPanel(telemetry, pullRequestManager);
				context.subscriptions.push(panel);
				const postMessage = sinon.spy(panel, '_postMessage');
				let releaseBody: (bodyHTML: string | undefined) => void;
				const blockedBody = new Promise<string | undefined>(resolve => releaseBody = resolve);
				let bodyProcessingStarted: () => void;
				const bodyStarted = new Promise<void>(resolve => bodyProcessingStarted = resolve);
				sinon.stub(panel, 'processLinksInBodyHtml').callsFake(() => {
					bodyProcessingStarted();
					return blockedBody;
				});

				const opening = panel.updateWithIdentity(identity, model);
				await bodyStarted;
				pullRequestManager.activePullRequest = initiallyCheckedOut ? undefined : model;
				releaseBody!(model.bodyHTML);
				await opening;

				const calls = postMessage.getCalls();
				const checkoutUpdate = calls.find(call => call.args[0].command === 'pr.update-checkout-status');
				assert(checkoutUpdate);
				assert.strictEqual(checkoutUpdate.args[0].isCurrentlyCheckedOut, !initiallyCheckedOut);
				const initialize = calls.find(call => call.args[0].command === 'pr.initialize');
				assert(initialize);
				assert.strictEqual(initialize.args[0].pullrequest?.isCurrentlyCheckedOut, !initiallyCheckedOut);
				assert(calls.indexOf(checkoutUpdate) < calls.indexOf(initialize));
			});
		}
	});

	describe('createOrShow', function () {
		it('does not load stack membership when stacks are disabled', async function () {
			setStacksEnabled(false);
			const model = new PullRequestModel(credentialStore, telemetry, repo, remote,
				convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo));
			const getStack = sinon.stub(model, 'getStack');
			const postMessage = sinon.spy(PullRequestOverviewPanel.prototype as any, '_postMessage');
			sinon.stub(pullRequestManager, 'getCurrentUser').resolves(model.author);

			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager,
				{ owner: remote.owner, repo: remote.repositoryName, number: model.number }, model);

			assert(getStack.notCalled);
			const initialize = postMessage.getCalls().find(call => call.args[0].command === 'pr.initialize'
				&& call.args[0].pullrequest?.stackLoaded !== undefined);
			assert(initialize);
			assert.strictEqual(initialize?.args[0].pullrequest.stackLoaded, true);
			assert.strictEqual(initialize?.args[0].pullrequest.stack, undefined);
		});

		it('creates a new panel', async function () {
			assert.strictEqual(PullRequestOverviewPanel.findPanel('aaa', 'bbb', 1000), undefined);
			const createWebviewPanel = sinon.spy(vscode.window, 'createWebviewPanel');

			repo.addGraphQLPullRequest(builder => {
				builder.pullRequest(response => {
					response.repository(r => {
						r.pullRequest(pr => pr.number(1000));
					});
				});
			});

			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo);
			const prModel = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem);
			const identity = { owner: prModel.remote.owner, repo: prModel.remote.repositoryName, number: prModel.number };

			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity, prModel);

			assert(
				createWebviewPanel.calledWith(sinonMatch.string, '#1000', vscode.ViewColumn.One, {
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [vscode.Uri.joinPath(EXTENSION_URI, 'dist')],
					enableFindWidget: true
				}),
			);
			assert.notStrictEqual(PullRequestOverviewPanel.findPanel('aaa', 'bbb', 1000), undefined);
		});

		it('uses a serializer-provided panel when no panel is cached', async function () {
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo);
			const prModel = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem);
			const identity = { owner: prModel.remote.owner, repo: prModel.remote.repositoryName, number: prModel.number };
			const restoredWebviewPanel = vscode.window.createWebviewPanel(PullRequestOverviewPanel.viewType, '#1000', vscode.ViewColumn.One, {});

			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity, prModel, false, true, restoredWebviewPanel);

			const restoredPanel = PullRequestOverviewPanel.findPanel(identity.owner, identity.repo, identity.number);
			assert.strictEqual((restoredPanel as any)._panel, restoredWebviewPanel);
			restoredWebviewPanel.dispose();
		});

		it('clears all open pull request panels', function () {
			const dispose = sinon.spy();
			(PullRequestOverviewPanel as any)._panels.set(panelKey('aaa', 'bbb', 1000), { dispose });

			PullRequestOverviewPanel.clearAll();

			assert.strictEqual(dispose.calledOnce, true);
			assert.strictEqual(PullRequestOverviewPanel.findPanel('aaa', 'bbb', 1000), undefined);
		});

		it('builds the active PR URL before the PR has loaded', async function () {
			repo.addGraphQLPullRequest(builder => {
				builder.pullRequest(response => {
					response.repository(r => {
						r.pullRequest(pr => pr.number(1000));
					});
				});
			});

			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo);
			const prModel = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem);
			const identity = { owner: prModel.remote.owner, repo: prModel.remote.repositoryName, number: prModel.number };

			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity, prModel);
			const panel = PullRequestOverviewPanel.findPanel(identity.owner, identity.repo, identity.number)!;
			sinon.stub(PullRequestOverviewPanel, 'getActivePanel').returns(panel);
			(pullRequestManager as any)._githubRepositories = [repo];
			(panel as any)._item = undefined;

			assert.strictEqual(PullRequestOverviewPanel.getCurrentPullRequestUrl()?.toString(), 'https://github.com/aaa/bbb/pull/1000');
		});

		it('reveals an existing panel for the same PR', async function () {
			const createWebviewPanel = sinon.spy(vscode.window, 'createWebviewPanel');

			repo.addGraphQLPullRequest(builder => {
				builder.pullRequest(response => {
					response.repository(r => {
						r.pullRequest(pr => pr.number(1000));
					});
				});
			});
			repo.addGraphQLPullRequest(builder => {
				builder.pullRequest(response => {
					response.repository(r => {
						r.pullRequest(pr => pr.number(2000));
					});
				});
			});

			const prItem0 = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo);
			const prModel0 = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem0);
			const identity0 = { owner: prModel0.remote.owner, repo: prModel0.remote.repositoryName, number: prModel0.number };
			const resolveStub = sinon.stub(pullRequestManager, 'resolvePullRequest').resolves(prModel0);
			sinon.stub(prModel0, 'getReviewRequests').resolves([]);
			sinon.stub(prModel0, 'getTimelineEvents').resolves([]);
			sinon.stub(prModel0, 'validateDraftMode').resolves(true);
			sinon.stub(prModel0, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity0, prModel0);

			const panel0 = PullRequestOverviewPanel.findPanel(identity0.owner, identity0.repo, identity0.number);
			assert.notStrictEqual(panel0, undefined);
			assert.strictEqual(createWebviewPanel.callCount, 1);
			assert.strictEqual(panel0!.getCurrentTitle(), '#1000 New feature');

			// Opening the same PR again should reuse the existing panel
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity0, prModel0);

			assert.strictEqual(panel0, PullRequestOverviewPanel.findPanel(identity0.owner, identity0.repo, identity0.number));
			assert.strictEqual(createWebviewPanel.callCount, 1);

			const restoredWebviewPanel = vscode.window.createWebviewPanel(PullRequestOverviewPanel.viewType, '#1000', vscode.ViewColumn.One, {});
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity0, prModel0, false, true, restoredWebviewPanel);

			const restoredPanel = PullRequestOverviewPanel.findPanel(identity0.owner, identity0.repo, identity0.number);
			assert.notStrictEqual(restoredPanel, panel0);
			assert.strictEqual((restoredPanel as any)._panel, restoredWebviewPanel);
			restoredWebviewPanel.dispose();
		});

		it('coalesces an update requested during initialization', async function () {
			const firstItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).title('Initial title').build(), repo);
			const firstModel = new PullRequestModel(credentialStore, telemetry, repo, remote, firstItem);
			const updatedItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).title('Updated title').build(), repo);
			const updatedModel = new PullRequestModel(credentialStore, telemetry, repo, remote, updatedItem);
			const identity = { owner: firstModel.remote.owner, repo: firstModel.remote.repositoryName, number: firstModel.number };
			let releaseInitialization: (defaultBranch: string) => void;
			const blockedInitialization = new Promise<string>(resolve => releaseInitialization = resolve);
			sinon.stub(pullRequestManager, 'getPullRequestRepositoryDefaultBranch')
				.onFirstCall().returns(blockedInitialization)
				.onSecondCall().resolves('main');
			for (const model of [firstModel, updatedModel]) {
				sinon.stub(model, 'getReviewRequests').resolves([]);
				sinon.stub(model, 'getTimelineEvents').resolves([]);
				sinon.stub(model, 'validateDraftMode').resolves(false);
				sinon.stub(model, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);
			}

			const initialOpen = PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity, firstModel);
			await new Promise(resolve => setImmediate(resolve));
			const updatedOpen = PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity, updatedModel);
			releaseInitialization!('main');
			await Promise.all([initialOpen, updatedOpen]);

			const panel = PullRequestOverviewPanel.findPanel(identity.owner, identity.repo, identity.number);
			assert.strictEqual(panel?.getCurrentTitle(), '#1000 Updated title');
			assert.strictEqual(panel?.getCurrentItem(), updatedModel);
		});

		it('does not post a stale timeline after a newer update', async function () {
			const firstItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).title('Initial title').build(), repo);
			const firstModel = new PullRequestModel(credentialStore, telemetry, repo, remote, firstItem);
			const updatedItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).title('Updated title').build(), repo);
			const updatedModel = new PullRequestModel(credentialStore, telemetry, repo, remote, updatedItem);
			const identity = { owner: firstModel.remote.owner, repo: firstModel.remote.repositoryName, number: firstModel.number };
			const staleEvents: TimelineEvent[] = [];
			let resolveTimeline: (events: TimelineEvent[]) => void;
			const timelinePromise = new Promise<TimelineEvent[]>(resolve => resolveTimeline = resolve);
			sinon.stub(firstModel, 'getReviewRequests').resolves([]);
			sinon.stub(firstModel, 'getTimelineEvents').returns(timelinePromise);
			sinon.stub(firstModel, 'validateDraftMode').resolves(false);
			sinon.stub(firstModel, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);
			sinon.stub(updatedModel, 'getReviewRequests').resolves([]);
			sinon.stub(updatedModel, 'getTimelineEvents').resolves([]);
			sinon.stub(updatedModel, 'validateDraftMode').resolves(false);
			sinon.stub(updatedModel, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);

			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity, firstModel);
			const panel = PullRequestOverviewPanel.findPanel(identity.owner, identity.repo, identity.number)!;
			let releaseTimelineProcessing: () => void;
			const timelineProcessingBlocked = new Promise<void>(resolve => releaseTimelineProcessing = resolve);
			sinon.stub(panel as any, 'processTimelineEvents').callsFake(async (events: TimelineEvent[]) => {
				if (events === staleEvents) {
					await timelineProcessingBlocked;
				}
				return events;
			});
			const postMessage = sinon.spy(panel as any, '_postMessage');

			resolveTimeline!(staleEvents);
			await new Promise(resolve => setImmediate(resolve));
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity, updatedModel);
			releaseTimelineProcessing!();
			await new Promise(resolve => setImmediate(resolve));

			const postedStaleTimeline = postMessage.getCalls().some(call =>
				call.args[0]?.command === 'pr.update' && call.args[0].pullrequest?.events === staleEvents
			);
			assert.strictEqual(postedStaleTimeline, false);
		});

		it('creates separate panels for different PRs', async function () {
			const createWebviewPanel = sinon.spy(vscode.window, 'createWebviewPanel');

			repo.addGraphQLPullRequest(builder => {
				builder.pullRequest(response => {
					response.repository(r => {
						r.pullRequest(pr => pr.number(1000));
					});
				});
			});
			repo.addGraphQLPullRequest(builder => {
				builder.pullRequest(response => {
					response.repository(r => {
						r.pullRequest(pr => pr.number(2000));
					});
				});
			});

			const prItem0 = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo);
			const prModel0 = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem0);
			const identity0 = { owner: prModel0.remote.owner, repo: prModel0.remote.repositoryName, number: prModel0.number };
			const resolveStub = sinon.stub(pullRequestManager, 'resolvePullRequest').resolves(prModel0);
			sinon.stub(prModel0, 'getReviewRequests').resolves([]);
			sinon.stub(prModel0, 'getTimelineEvents').resolves([]);
			sinon.stub(prModel0, 'validateDraftMode').resolves(true);
			sinon.stub(prModel0, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity0, prModel0);

			const panel0 = PullRequestOverviewPanel.findPanel(identity0.owner, identity0.repo, identity0.number);
			assert.notStrictEqual(panel0, undefined);
			assert.strictEqual(createWebviewPanel.callCount, 1);

			const prItem1 = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(2000).build(), repo);
			const prModel1 = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem1);
			const identity1 = { owner: prModel1.remote.owner, repo: prModel1.remote.repositoryName, number: prModel1.number };
			resolveStub.resolves(prModel1);
			sinon.stub(prModel1, 'getReviewRequests').resolves([]);
			sinon.stub(prModel1, 'getTimelineEvents').resolves([]);
			sinon.stub(prModel1, 'validateDraftMode').resolves(true);
			sinon.stub(prModel1, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity1, prModel1);

			const panel1 = PullRequestOverviewPanel.findPanel(identity1.owner, identity1.repo, identity1.number);
			assert.notStrictEqual(panel1, undefined);
			assert.notStrictEqual(panel0, panel1);
			assert.strictEqual(createWebviewPanel.callCount, 2);
			assert.strictEqual(panel0!.getCurrentTitle(), '#1000 New feature');
			assert.strictEqual(panel1!.getCurrentTitle(), '#2000 New feature');
		});
	});

	describe('deferred assignable users', function () {
		let prModel: PullRequestModel;
		let webviewPanel: vscode.WebviewPanel;
		let messages: { command: string; pullrequest?: Partial<PullRequest> }[];
		let onDidReceiveMessage: vscode.EventEmitter<{ command: string; args?: { url: string } }>;
		let onDidChangeViewState: vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>;
		let pollInterval: number;
		let resolveUsers: (users: { [key: string]: IAccount[] }) => void;
		let rejectUsers: (error: Error) => void;
		let usersPromise: Promise<{ [key: string]: IAccount[] }>;
		let getAssignableUsers: SinonStub<Parameters<FolderRepositoryManager['getAssignableUsers']>, ReturnType<FolderRepositoryManager['getAssignableUsers']>>;
		let getReviewRequests: SinonStub<[], ReturnType<PullRequestModel['getReviewRequests']>>;
		let getPreview: SinonStub<[number], Promise<PullRequestPreview>>;
		let getRepository: SinonStub<Parameters<FolderRepositoryManager['createGitHubRepositoryFromOwnerName']>, ReturnType<FolderRepositoryManager['createGitHubRepositoryFromOwnerName']>>;
		let getRepositoryAccess: SinonStub<Parameters<FolderRepositoryManager['getPullRequestRepositoryAccessAndMergeMethods']>, ReturnType<FolderRepositoryManager['getPullRequestRepositoryAccessAndMergeMethods']>>;
		let getMergeQueueMethod: SinonStub;
		const preview: PullRequestPreview = {
			number: 1000, title: 'Preview title', titleHTML: 'Preview title',
			body: 'Preview description', bodyHTML: '<p>Preview description</p>', url: 'https://github.com/aaa/bbb/pull/1000',
			author: COPILOT_REVIEWER_ACCOUNT, createdAt: '2026-10-01T10:00:00Z',
			state: GithubItemStateEnum.Open, isDraft: false, base: 'aaa/bbb:main', head: 'aaa/bbb:feature',
		};

		beforeEach(function () {
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo);
			prModel = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem);
			getRepository = sinon.stub(pullRequestManager, 'createGitHubRepositoryFromOwnerName').resolves(repo);
			getPreview = sinon.stub(repo, 'getPullRequestPreview').resolves(preview);
			getRepositoryAccess = sinon.stub(pullRequestManager, 'getPullRequestRepositoryAccessAndMergeMethods').resolves({
				hasWritePermission: true,
				mergeMethodsAvailability: { merge: true, squash: true, rebase: true },
				viewerCanAutoMerge: false,
			});
			sinon.stub(pullRequestManager, 'getCurrentUser').resolves(prModel.author);
			sinon.stub(prModel, 'canEdit').resolves(true);
			getReviewRequests = sinon.stub(prModel, 'getReviewRequests').resolves([]);
			sinon.stub(prModel, 'getTimelineEvents').resolves([]);
			sinon.stub(prModel, 'validateDraftMode').resolves(false);
			sinon.stub(prModel, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);
			sinon.stub(prModel, 'getMergeability').resolves({ mergeability: PullRequestMergeability.Mergeable });
			sinon.stub(pullRequestManager, 'getBranchNameForPullRequest').resolves(undefined);
			getMergeQueueMethod = sinon.stub(pullRequestManager, 'mergeQueueMethodForBranch').resolves(undefined);
			sinon.stub(pullRequestManager, 'isHeadUpToDateWithBase').resolves(true);
			sinon.stub(pullRequestManager, 'getPreferredEmail').resolves(undefined);
			sinon.stub(pullRequestManager, 'checkBranchUpToDate').resolves();
			usersPromise = new Promise((resolve, reject) => {
				resolveUsers = resolve;
				rejectUsers = reject;
			});
			getAssignableUsers = sinon.stub(pullRequestManager, 'getAssignableUsers').returns(usersPromise);

			messages = [];
			webviewPanel = vscode.window.createWebviewPanel(PullRequestOverviewPanel.viewType, '#1000', vscode.ViewColumn.One, {});
			onDidReceiveMessage = new vscode.EventEmitter();
			onDidChangeViewState = new vscode.EventEmitter();
			pollInterval = 1000 * (vscode.workspace.getConfiguration().get<number>('githubPullRequests.webviewRefreshInterval') || 60);
			context.subscriptions.push(webviewPanel, onDidReceiveMessage, onDidChangeViewState);
			sinon.stub(webviewPanel.webview, 'onDidReceiveMessage').callsFake(onDidReceiveMessage.event);
			sinon.stub(webviewPanel, 'onDidChangeViewState').callsFake(onDidChangeViewState.event);
			sinon.stub(webviewPanel.webview, 'postMessage').callsFake(async message => {
				messages.push(message.res);
				return true;
			});
		});

		async function openPanel(model: PullRequestModel | Promise<PullRequestModel> = prModel): Promise<void> {
			const identity = { owner: remote.owner, repo: remote.repositoryName, number: prModel.number };
			const opening = PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity, model, false, true, webviewPanel);
			onDidReceiveMessage.fire({ command: 'ready' });
			await opening;
			await new Promise(resolve => setImmediate(resolve));
		}

		afterEach(async function () {
			resolveUsers({});
			await new Promise(resolve => setImmediate(resolve));
		});

		previewLoadingTests(() => ({ model: prModel, preview, getPreview, getRepository, getRepositoryAccess, getAssignableUsers, openPanel, messages, webviewPanel }));

		it('keeps the stack queue method when deferred PR data arrives after the stack', async function () {
			sinon.stub(vscode.env, 'asExternalUri').callsFake(async uri => uri);
			sinon.stub(prModel, 'getStack').resolves({
				position: 1, size: 1, base: 'stack-target',
				pullRequests: [{
					position: 1, number: prModel.number, title: prModel.title, head: 'feature',
					url: prModel.html_url, state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable,
				}],
			});
			getMergeQueueMethod.callsFake(async branch => branch === 'stack-target' ? 'squash' : 'merge');
			let releaseReviewRequests!: (value: Awaited<ReturnType<PullRequestModel['getReviewRequests']>>) => void;
			getReviewRequests.returns(new Promise(resolve => { releaseReviewRequests = resolve; }));

			await openPanel();
			assert.strictEqual(messages.find(message => message.pullrequest?.stackLoaded)?.pullrequest?.mergeQueueMethod, 'squash');

			releaseReviewRequests([]);
			await new Promise(resolve => setImmediate(resolve));

			const deferred = messages.find(message => message.pullrequest?.status);
			assert(deferred);
			assert.strictEqual('mergeQueueMethod' in deferred.pullrequest!, false);
		});

		it('resets stack-loaded state when another full overview update starts', async function () {
			const getStack = sinon.stub(prModel, 'getStack').resolves(undefined);
			await openPanel();
			const panel = PullRequestOverviewPanel.findPanel(remote.owner, remote.repositoryName, prModel.number)!;
			assert.strictEqual((panel as any)._stackLoaded, true);
			let releaseStack!: (stack: PullRequestStack | undefined) => void;
			getStack.returns(new Promise(resolve => { releaseStack = resolve; }));
			getMergeQueueMethod.resolves('merge');
			messages.length = 0;

			await openPanel();

			assert.strictEqual((panel as any)._stackLoaded, false);
			assert.strictEqual(messages.find(message => message.pullrequest?.status)?.pullrequest?.mergeQueueMethod, 'merge');
			releaseStack(undefined);
			await new Promise(resolve => setImmediate(resolve));
			assert.strictEqual((panel as any)._stackLoaded, true);
		});

		it('serializes initial stack loads across full overview updates and ignores the obsolete result', async function () {
			let releaseStack!: (stack: PullRequestStack | undefined) => void;
			const getStack = sinon.stub(prModel, 'getStack').resolves(undefined);
			getStack.onFirstCall().returns(new Promise(resolve => { releaseStack = resolve; }));
			await openPanel();
			const panel = PullRequestOverviewPanel.findPanel(remote.owner, remote.repositoryName, prModel.number)!;

			await openPanel();

			assert(getStack.calledOnce);
			assert.strictEqual(messages.some(message => message.pullrequest?.stackLoaded), false);
			releaseStack(undefined);
			await (panel as any)._stackRefreshPromise;

			assert(getStack.calledTwice);
			assert.strictEqual(messages.filter(message => message.pullrequest?.stackLoaded).length, 1);
			assert.strictEqual((panel as any)._stackLoaded, true);
		});

		it('skips polling a pending model and resumes once the PR is available', async function () {
			const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const getLastUpdateTime = sinon.stub(prModel, 'getLastUpdateTime').resolves(new Date(0));
			let resolveModel: (model: PullRequestModel) => void;
			const opening = openPanel(new Promise<PullRequestModel>(resolve => resolveModel = resolve));
			try {
				onDidChangeViewState.fire({ webviewPanel });
				clock.tick(pollInterval);
				await new Promise(resolve => setImmediate(resolve));
				sinon.assert.notCalled(getLastUpdateTime);
				assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
			} finally {
				resolveModel!(prModel);
				await opening;
			}
			clock.tick(pollInterval);
			await new Promise(resolve => setImmediate(resolve));
			sinon.assert.calledOnce(getLastUpdateTime);
		});

		it('logs poll failures and continues polling on the next interval', async function () {
			const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const getLastUpdateTime = sinon.stub(prModel, 'getLastUpdateTime');
			getLastUpdateTime.onFirstCall().rejects(new Error('Temporary polling failure'));
			getLastUpdateTime.onSecondCall().resolves(new Date(0));
			const logError = sinon.spy(Logger, 'error');
			await openPanel();

			clock.tick(pollInterval);
			await new Promise(resolve => setImmediate(resolve));
			assert.ok(logError.getCalls().some(call => call.args[0] === 'Failed to poll overview updates: Temporary polling failure'));
			clock.tick(pollInterval);
			await new Promise(resolve => setImmediate(resolve));
			sinon.assert.calledTwice(getLastUpdateTime);
		});

		it('does not refresh or restart polling after an in-flight poll is disposed', async function () {
			const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			let resolvePoll: (date: Date) => void;
			const getLastUpdateTime = sinon.stub(prModel, 'getLastUpdateTime').returns(new Promise(resolve => resolvePoll = resolve));
			await openPanel();
			const panel = PullRequestOverviewPanel.findPanel(remote.owner, remote.repositoryName, prModel.number)!;
			const refresh = sinon.stub(panel, 'refreshPanel').resolves();

			clock.tick(pollInterval);
			webviewPanel.dispose();
			resolvePoll!(new Date(Date.now() + 1000));
			await new Promise(resolve => setImmediate(resolve));
			clock.tick(pollInterval);
			await new Promise(resolve => setImmediate(resolve));

			sinon.assert.notCalled(refresh);
			sinon.assert.calledOnce(getLastUpdateTime);
		});

		it('opens a preview link with the default browser before the full PR resolves', async function () {
			const openExternal = sinon.stub(vscode.env, 'openExternal').resolves(true);
			let resolveModel: (model: PullRequestModel) => void;
			const opening = openPanel(new Promise<PullRequestModel>(resolve => resolveModel = resolve));
			try {
				await new Promise(resolve => setImmediate(resolve));
				onDidReceiveMessage.fire({ command: 'pr.openOnGitHub', args: { url: preview.url } });
				await new Promise(resolve => setImmediate(resolve));

				sinon.assert.calledOnce(openExternal);
				assert.strictEqual(openExternal.firstCall.args[0].toString(), preview.url);
				assert.deepStrictEqual(openExternal.firstCall.args[1], { allowContributedOpeners: 'default' });
				assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
			} finally {
				resolveModel!(prModel);
				await opening;
			}
		});

		it('initializes the PR and loads checks before cold assignable users finish', async function () {
			const opening = openPanel();
			await new Promise(resolve => setImmediate(resolve));
			try {
				const initial = messages.find(message => message.command === 'pr.initialize')?.pullrequest;
				assert.ok(initial, 'PR initialization must not wait for assignable users');
				assert.strictEqual(initial.title, prModel.title);
				assert.strictEqual(initial.body, prModel.body);
				assert.strictEqual(initial.canAssignCopilot, false);
				assert.strictEqual(initial.canRequestCopilotReview, false);
				assert.ok(messages.some(message => message.command === 'pr.update' && message.pullrequest?.status?.state === CheckState.Success));
			} finally {
				resolveUsers({ [remote.remoteName]: [COPILOT_REVIEWER_ACCOUNT] });
				await opening;
				await new Promise(resolve => setImmediate(resolve));
			}

			assert.ok(messages.some(message => message.command === 'pr.update'
				&& message.pullrequest?.canAssignCopilot === true
				&& message.pullrequest.canRequestCopilotReview === true));
		});

		it('keeps Copilot actions unavailable when no assignable Copilot account exists', async function () {
			resolveUsers({ [remote.remoteName]: [prModel.author] });
			await openPanel();

			assert.ok(messages.some(message => message.command === 'pr.update'
				&& message.pullrequest?.canAssignCopilot === false
				&& message.pullrequest.canRequestCopilotReview === false));
		});

		it('does not offer another Copilot review when one is already requested', async function () {
			getReviewRequests.resolves([COPILOT_REVIEWER_ACCOUNT]);
			resolveUsers({ [remote.remoteName]: [COPILOT_REVIEWER_ACCOUNT] });
			await openPanel();

			assert.ok(messages.some(message => message.command === 'pr.update'
				&& message.pullrequest?.canAssignCopilot === true
				&& message.pullrequest.canRequestCopilotReview === false));
		});

		it('logs assignable-user failures without preventing PR initialization', async function () {
			const logError = sinon.spy(Logger, 'error');
			await openPanel();
			rejectUsers(new Error('Assignable users unavailable'));
			await new Promise(resolve => setImmediate(resolve));

			assert.ok(messages.some(message => message.command === 'pr.initialize'));
			sinon.assert.calledWith(logError, 'Failed to update deferred assignable users: Assignable users unavailable', PullRequestOverviewPanel.ID);
			assert.strictEqual(messages.some(message => message.pullrequest?.canAssignCopilot === true), false);
		});

		it('ignores assignable users from an older update', async function () {
			await openPanel();
			getAssignableUsers.resolves({});
			await openPanel();
			messages.length = 0;

			resolveUsers({ [remote.remoteName]: [COPILOT_REVIEWER_ACCOUNT] });
			await new Promise(resolve => setImmediate(resolve));

			assert.deepStrictEqual(messages, []);
		});

		it('ignores assignable users after the panel is disposed', async function () {
			await openPanel();
			webviewPanel.dispose();
			messages.length = 0;

			resolveUsers({ [remote.remoteName]: [COPILOT_REVIEWER_ACCOUNT] });
			await new Promise(resolve => setImmediate(resolve));

			assert.deepStrictEqual(messages, []);
		});
	});

	describe('issue preview loading', function () {
		let issueModel: IssueModel;
		let webviewPanel: vscode.WebviewPanel;
		let messages: { command: string; pullrequest?: Partial<Issue> }[];
		let onDidReceiveMessage: vscode.EventEmitter<{ command: string }>;
		let getPreview: SinonStub<[number], Promise<IssuePreview>>;
		let getRepository: SinonStub<Parameters<FolderRepositoryManager['createGitHubRepositoryFromOwnerName']>, ReturnType<FolderRepositoryManager['createGitHubRepositoryFromOwnerName']>>;
		let getRepositoryAccess: SinonStub<Parameters<FolderRepositoryManager['getPullRequestRepositoryAccessAndMergeMethods']>, ReturnType<FolderRepositoryManager['getPullRequestRepositoryAccessAndMergeMethods']>>;
		let getAssignableUsers: SinonStub<Parameters<FolderRepositoryManager['getAssignableUsers']>, ReturnType<FolderRepositoryManager['getAssignableUsers']>>;
		let showError: SinonStub<Parameters<typeof vscode.window.showErrorMessage>, ReturnType<typeof vscode.window.showErrorMessage>>;
		let loadEmojis: SinonStub<Parameters<typeof emoji.ensureEmojis>, ReturnType<typeof emoji.ensureEmojis>>;
		const preview: IssuePreview = {
			number: 1000, title: 'Preview title', titleHTML: 'Preview title',
			body: 'Preview description', bodyHTML: '<p>Preview description</p>', url: 'https://github.com/aaa/bbb/issues/1000',
			author: COPILOT_REVIEWER_ACCOUNT, createdAt: '2026-10-01T10:00:00Z',
			state: GithubItemStateEnum.Open, isIssue: true,
		};

		beforeEach(function () {
			context.extensionUri = EXTENSION_URI;
			loadEmojis = sinon.stub(emoji, 'ensureEmojis').resolves({});
			showError = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
			const item = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo);
			issueModel = new IssueModel(telemetry, repo, remote, { ...item, url: 'https://github.com/aaa/bbb/issues/1000' });
			context.subscriptions.push(issueModel);
			getRepository = sinon.stub(pullRequestManager, 'createGitHubRepositoryFromOwnerName').resolves(repo);
			getPreview = sinon.stub(repo, 'getIssuePreview').resolves(preview);
			sinon.stub(pullRequestManager, 'resolveIssue').resolves(issueModel);
			sinon.stub(issueModel, 'getIssueTimelineEvents').resolves([]);
			sinon.stub(issueModel, 'canEdit').resolves(true);
			sinon.stub(pullRequestManager, 'getCurrentUser').resolves(issueModel.author);
			getAssignableUsers = sinon.stub(pullRequestManager, 'getAssignableUsers').resolves({});
			getRepositoryAccess = sinon.stub(pullRequestManager, 'getPullRequestRepositoryAccessAndMergeMethods').resolves({
				hasWritePermission: true,
				mergeMethodsAvailability: { merge: true, squash: true, rebase: true },
				viewerCanAutoMerge: false,
			});

			messages = [];
			webviewPanel = vscode.window.createWebviewPanel(IssueOverviewPanel.viewType, '#1000', vscode.ViewColumn.One, {});
			onDidReceiveMessage = new vscode.EventEmitter();
			context.subscriptions.push(webviewPanel, onDidReceiveMessage);
			sinon.stub(webviewPanel.webview, 'onDidReceiveMessage').callsFake(onDidReceiveMessage.event);
			sinon.stub(webviewPanel.webview, 'postMessage').callsFake(async message => {
				messages.push(message.res);
				return true;
			});
		});

		afterEach(function () {
			sinon.assert.notCalled(showError);
		});

		async function openPanel(model: IssueModel | Promise<IssueModel> = issueModel): Promise<void> {
			const identity = { owner: remote.owner, repo: remote.repositoryName, number: issueModel.number };
			const opening = IssueOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity, model, false, true, webviewPanel);
			onDidReceiveMessage.fire({ command: 'ready' });
			await opening;
			await new Promise(resolve => setImmediate(resolve));
		}

		for (const bodyHTML of ['<p>Rendered issue description</p>', undefined]) {
			it(`shows a model-backed preview when opening an issue through the description command ${bodyHTML === undefined ? 'without' : 'with'} body HTML`, async function () {
				issueModel.bodyHTML = bodyHTML;
				let resolveUsers!: (users: { [key: string]: IAccount[] }) => void;
				getAssignableUsers.returns(new Promise(resolve => resolveUsers = resolve));
				const createPanel = sinon.stub(vscode.window, 'createWebviewPanel').returns(webviewPanel);
				const opening = openDescription(telemetry, issueModel, undefined, pullRequestManager, false);
				onDidReceiveMessage.fire({ command: 'ready' });
				try {
					await new Promise(resolve => setImmediate(resolve));
					assert.deepStrictEqual(messages.find(message => message.command === 'pr.preview')?.pullrequest, {
						number: issueModel.number,
						title: issueModel.title,
						titleHTML: issueModel.titleHTML,
						url: issueModel.html_url,
						body: issueModel.body,
						bodyHTML: issueModel.bodyHTML,
						author: issueModel.author,
						createdAt: issueModel.createdAt,
						state: issueModel.state,
						stateReason: issueModel.stateReason,
						isIssue: true,
					});
					assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
					sinon.assert.calledOnce(createPanel);
					sinon.assert.notCalled(getRepository);
					sinon.assert.notCalled(getPreview);
				} finally {
					resolveUsers({});
					await opening;
				}
				assert.ok(messages.some(message => message.command === 'pr.initialize'));
			});
		}

		it('shows the model-backed preview before emoji resources finish loading', async function () {
			let resolveEmojis!: (emojis: Record<string, string>) => void;
			loadEmojis.returns(new Promise(resolve => resolveEmojis = resolve));
			const opening = openPanel();
			try {
				await new Promise(resolve => setImmediate(resolve));
				sinon.assert.calledOnce(loadEmojis);
				const modelPreview = messages.find(message => message.command === 'pr.preview')?.pullrequest;
				assert.strictEqual(modelPreview?.title, issueModel.title);
				assert.strictEqual(modelPreview?.body, issueModel.body);
				assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
			} finally {
				resolveEmojis({});
				await opening;
			}
			assert.ok(messages.some(message => message.command === 'pr.initialize'));
		});

		it('keeps the complete issue visible while refreshing an existing panel', async function () {
			await openPanel();
			messages.length = 0;
			let resolveUsers!: (users: { [key: string]: IAccount[] }) => void;
			getAssignableUsers.returns(new Promise(resolve => resolveUsers = resolve));
			const refreshing = openPanel();
			try {
				await new Promise(resolve => setImmediate(resolve));
				assert.strictEqual(messages.some(message => message.command === 'pr.preview' || message.command === 'pr.clear'), false);
				assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
			} finally {
				resolveUsers({});
				await refreshing;
			}
			assert.ok(messages.some(message => message.command === 'pr.initialize'));
			sinon.assert.notCalled(getPreview);
		});

		previewLoadingTests(() => ({ model: issueModel, preview, getPreview, getRepository, getRepositoryAccess, getAssignableUsers, openPanel, messages, webviewPanel }));
	});

	describe('mergePullRequest', function () {
		it('prompts to delete the local branch when GitHub deletes branches after merge', async function () {
			repo.buildMetadata(repository => repository.delete_branch_on_merge!(true));
			const { panel, model: prModel, branch } = await createPanel();
			sinon.stub(prModel, 'merge').resolves({ merged: true, message: '', timeline: [] });
			branch.resolves({
				branch: 'new-feature',
				createdForPullRequest: false,
			});
			const showWarningMessage = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
			const replyMessage = sinon.stub(panel as any, '_replyMessage');

			await (panel as any).mergePullRequest({
				command: 'pr.merge',
				args: { title: '', description: '', method: 'squash' },
			});

			assert.strictEqual(showWarningMessage.calledOnce, true);
			assert.strictEqual((showWarningMessage.firstCall.args[1] as vscode.MessageOptions).modal, true);
			const actions = showWarningMessage.firstCall.args.slice(2) as vscode.MessageItem[];
			assert.strictEqual(actions.some(action => action.title === 'Delete Local Branch'), true);
			assert.strictEqual(replyMessage.firstCall.args[1].state, GithubItemStateEnum.Merged);
			sinon.assert.callOrder(replyMessage, showWarningMessage);
		});
	});

	describe('mergeStack', function () {
		const stack: PullRequestStack = {
			position: 2,
			size: 2,
			base: 'production',
			pullRequests: [
				{ position: 1, number: 999, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				{ position: 2, number: 1000, title: 'Second', url: '', head: 'D2', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		};

		function createMergeContext() {
			const item = new PullRequestModel(credentialStore, telemetry, repo, remote,
				convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo));
			sinon.stub(item, 'getStack').resolves(stack);
			return {
				item,
				folderRepositoryManager: pullRequestManager,
				existingReviewers: [],
				postMessage: sinon.stub().resolves(),
				replyMessage: sinon.spy(),
				throwError: sinon.spy(),
				getTimeline: sinon.stub().resolves([]),
			} satisfies ReviewContext;
		}

		it('uses the stack target branch merge queue and reports enqueue without marking the PR merged', async function () {
			const ctx = createMergeContext();
			sinon.stub(repo, 'getPullRequest').resolves(ctx.item);
			const queue = sinon.stub(pullRequestManager, 'mergeQueueMethodForBranch').resolves('squash');
			const merge = sinon.stub(ctx.item, 'mergeStack').resolves('enqueued');
			const information = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
			const message = { req: '1', command: 'pr.merge-stack', args: { method: 'squash' as const } };

			await PullRequestReviewCommon.mergeStack(ctx, message);

			assert(queue.calledOnceWithExactly('production', remote.owner, remote.repositoryName));
			assert(merge.calledOnceWithExactly(pullRequestManager.repository, stack, 'squash', 'merge_queue'));
			sinon.assert.calledWithExactly(ctx.replyMessage, message, { status: 'enqueued', state: undefined });
			assert(information.calledOnce);
			assert(ctx.throwError.notCalled);
		});

		it('reports a rejected merge rather than sending a successful response', async function () {
			const ctx = createMergeContext();
			sinon.stub(ctx.item, 'mergeStack').rejects(new Error('Required checks failed'));
			const showError = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
			const message = { req: '2', command: 'pr.merge-stack', args: { method: 'merge' as const } };

			await PullRequestReviewCommon.mergeStack(ctx, message);

			assert(showError.calledOnce);
			assert(ctx.replyMessage.notCalled);
			sinon.assert.calledWithExactly(ctx.throwError, message, 'Required checks failed');
		});

		it('does not merge a stack when the feature is disabled', async function () {
			setStacksEnabled(false);
			const ctx = createMergeContext();
			const getStack = ctx.item.getStack as ReturnType<SinonSandbox['stub']>;
			const showError = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
			const message = { req: '3', command: 'pr.merge-stack', args: { method: 'merge' as const } };

			await PullRequestReviewCommon.mergeStack(ctx, message);

			assert(getStack.notCalled);
			assert(ctx.replyMessage.notCalled);
			sinon.assert.calledWithExactly(ctx.throwError, message, 'Pull request stack features are disabled.');
			assert(showError.calledOnce);
		});
	});

	function stubPanelServices() {
		const models = new Map<number, PullRequestModel>();
		const access = sinon.stub(pullRequestManager, 'getPullRequestRepositoryAccessAndMergeMethods').resolves({
			hasWritePermission: true,
			mergeMethodsAvailability: { merge: true, squash: true, rebase: true },
			viewerCanAutoMerge: false,
		});
		sinon.stub(pullRequestManager, 'getPullRequestRepositoryDefaultBranch').resolves('main');
		const currentUser = sinon.stub(pullRequestManager, 'getCurrentUser').callsFake(async () => {
			const model = models.values().next().value;
			assert(model);
			return model.author;
		});
		sinon.stub(pullRequestManager, 'getAssignableUsers').resolves({});
		const branch = sinon.stub(pullRequestManager, 'getBranchNameForPullRequest').resolves(undefined);
		const queueMethod = sinon.stub(pullRequestManager, 'mergeQueueMethodForBranch').resolves(undefined);
		sinon.stub(pullRequestManager, 'isHeadUpToDateWithBase').resolves(true);
		sinon.stub(pullRequestManager, 'getPreferredEmail').resolves(undefined);
		sinon.stub(pullRequestManager, 'checkBranchUpToDate').resolves();
		sinon.stub(pullRequestManager, 'resolvePullRequest').callsFake(async (_owner, _repo, number) => models.get(number));
		const externalUri = sinon.stub(vscode.env, 'asExternalUri').callsFake(async uri => uri);
		const showError = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
		const query = sinon.spy(repo, 'query');
		return { models, access, currentUser, branch, queueMethod, externalUri, showError, query };
	}

	async function createPanel(number = 1000) {
		const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(number).build(), repo);
		const model = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem);
		const services = panelServices ??= stubPanelServices();
		services.models.set(number, model);
		sinon.stub(model, 'canEdit').resolves(true);
		sinon.stub(model, 'getReviewRequests').resolves([]);
		sinon.stub(model, 'getTimelineEvents').resolves([]);
		sinon.stub(model, 'validateDraftMode').resolves(false);
		sinon.stub(model, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);
		sinon.stub(model, 'getMergeability').resolves({ mergeability: PullRequestMergeability.Mergeable });
		sinon.stub(model, 'getCoAuthors').resolves([]);
		sinon.stub(model, 'getLastUpdateTime').resolves(new Date(0));
		const stackQuery = sinon.stub(model, 'getStack').resolves(undefined);
		const received = new vscode.EventEmitter<{ command: string }>();
		const webviewPanel = vscode.window.createWebviewPanel(PullRequestOverviewPanel.viewType, `#${number}`, vscode.ViewColumn.One, {});
		context.subscriptions.push(received, webviewPanel);
		sinon.stub(webviewPanel.webview, 'onDidReceiveMessage').callsFake(received.event);
		const pendingUpdates = new Set(['status', 'events', 'canAssignCopilot']);
		let finishInitialization!: () => void;
		const initialized = new Promise<void>(resolve => { finishInitialization = resolve; });
		const webviewPostMessage = sinon.stub(webviewPanel.webview, 'postMessage').callsFake(async (message: {
			res?: { command?: string; pullrequest?: Partial<PullRequest> };
		}) => {
			const response = message.res;
			if (response?.command === 'pr.initialize' && response.pullrequest?.stackLoaded === false) {
				pendingUpdates.add('stackLoaded');
			} else if (response?.command === 'pr.update' && response.pullrequest) {
				for (const key of pendingUpdates) {
					if (key in response.pullrequest) {
						pendingUpdates.delete(key);
					}
				}
				if (pendingUpdates.size === 0) {
					finishInitialization();
				}
			}
			return true;
		});
		const identity = { owner: remote.owner, repo: remote.repositoryName, number: model.number };
		const opening = PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager,
			identity, model, false, true, webviewPanel);
		received.fire({ command: 'ready' });
		await opening;
		await initialized;
		assert(services.query.notCalled);
		const panel = PullRequestOverviewPanel.findPanel(identity.owner, identity.repo, identity.number)!;
		stackQuery.resetHistory();
		stackQuery.resolves({
			position: 2, size: 2, base: 'main',
			pullRequests: [
				{ position: 1, number: 999, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Merged, isDraft: false, mergeable: PullRequestMergeability.Unknown },
				{ position: 2, number: 1000, title: 'Second', url: '', head: 'D2', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		});
		return { ...services, panel, model, stackQuery, webviewPostMessage };
	}

	describe('stack panel fixture', function () {
		it('posts replies without depending on the renderer sending a ready message', async function () {
			const { panel, webviewPostMessage } = await createPanel();
			webviewPostMessage.resetHistory();
			const message = { req: 'fixture', command: 'pr.update-stack' };
			const response = { updatedPullRequests: [] };

			await (panel as any)._replyMessage(message, response);

			assert(webviewPostMessage.calledOnce);
			assert.deepStrictEqual(webviewPostMessage.firstCall.args[0], { seq: message.req, res: response });
		});
	});

	describe('loadStack', function () {
		it('marks the stack loaded before posting linked stack details', async function () {
			const { panel, model, stackQuery, externalUri } = await createPanel();
			externalUri.callsFake(async uri => uri.with({ scheme: 'test-external' }));
			externalUri.resetHistory();
			const postMessage = sinon.stub(panel as any, '_postMessage').callsFake(async (message: { pullrequest?: { stackLoaded?: boolean } }) => {
				if (message.pullrequest?.stackLoaded) {
					assert.strictEqual((panel as any)._stackLoaded, true);
				}
			});

			await (panel as any).loadStack(model, (panel as any)._updateSequence);

			assert(stackQuery.calledOnce);
			const update = postMessage.getCalls().find(call => call.args[0].pullrequest?.stackLoaded);
			assert(update);
			assert.strictEqual(update.args[0].pullrequest.stack.pullRequests.length, 2);
			assert(externalUri.calledTwice);
			assert(update.args[0].pullrequest.stack.pullRequests.every(entry => entry.url.includes('/open-pull-request-webview')));
			assert(update.args[0].pullrequest.stack.pullRequests.every(entry => entry.url.startsWith('test-external:')));
			assert.deepStrictEqual(update.args[0].pullrequest.stack.pullRequests.map(entry => JSON.parse(vscode.Uri.parse(entry.url).query)), [
				{ owner: remote.owner, repo: remote.repositoryName, pullRequestNumber: 999 },
				{ owner: remote.owner, repo: remote.repositoryName, pullRequestNumber: 1000 },
			]);
			assert.strictEqual(update.args[0].pullrequest.canUpdateStack, false);
		});

		it('ignores results from a stale overview update', async function () {
			const { panel, model } = await createPanel();
			const postMessage = sinon.stub(panel as any, '_postMessage').resolves();

			await (panel as any).loadStack(model, (panel as any)._updateSequence - 1);

			assert(postMessage.notCalled);
		});
	});

	describe('stack change events', function () {
		async function openStackPanel() {
			const result = await createPanel();
			const postMessage = sinon.stub(result.panel as any, '_postMessage').resolves();
			const fullRefresh = sinon.stub(result.panel, 'refreshPanel').resolves();
			const stack = await result.stackQuery();
			assert(stack);
			await (result.panel as any).refreshStack();
			result.stackQuery.resetHistory();
			postMessage.resetHistory();
			return { ...result, stack, postMessage, fullRefresh };
		}

		it('updates the membership and badge data when a new PR is added', async function () {
			const { panel, stackQuery, stack, postMessage, fullRefresh } = await openStackPanel();
			stackQuery.resolves({
				...stack, size: 3,
				pullRequests: [...stack.pullRequests, { ...stack.pullRequests[1], position: 3, number: 1001, head: 'D3' }],
			});
			repo.notifyStackChanged([999, 1000, 1001]);
			await (panel as any)._stackRefreshPromise;
			assert(stackQuery.calledOnce);
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.stack.position, 2);
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.stack.size, 3);
			assert.deepStrictEqual(postMessage.lastCall.args[0].pullrequest.stack.pullRequests.map(pr => pr.number), [999, 1000, 1001]);
			assert(fullRefresh.notCalled);
		});

		it('detects a new stack for a previously unstacked PR', async function () {
			const { panel, stackQuery, stack, postMessage } = await openStackPanel();
			stackQuery.resolves(undefined);
			await (panel as any).refreshStack();
			postMessage.resetHistory();
			stackQuery.resolves(stack);
			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.stack.size, 2);
		});

		it('updates sibling draft status when the repository observes a model change', async function () {
			const { panel, stackQuery, stack, postMessage, fullRefresh } = await openStackPanel();
			const sibling = repo.createOrUpdatePullRequestModel({
				...convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(999).build(), repo), isDraft: true,
			});
			stackQuery.resolves({
				...stack, pullRequests: [{ ...stack.pullRequests[0], state: GithubItemStateEnum.Open, isDraft: false }, stack.pullRequests[1]],
			});
			sibling.update({ ...sibling.item, isDraft: false });
			await (panel as any)._stackRefreshPromise;
			assert(stackQuery.calledOnce);
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.stack.pullRequests[0].isDraft, false);
			assert(fullRefresh.notCalled);
		});

		for (const change of ['head', 'mergeability', 'merge queue']) {
			it(`refreshes stack data when a sibling's ${change} changes`, async function () {
				const { panel, stackQuery, fullRefresh } = await openStackPanel();
				const sibling = repo.createOrUpdatePullRequestModel(
					convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(999).build(), repo));
				if (change === 'head') {
					const head = sibling.item.head;
					assert(head);
					sibling.update({ ...sibling.item, head: { ...head, sha: 'updated-head' } });
				} else if (change === 'mergeability') {
					sibling.update({ ...sibling.item, mergeable: PullRequestMergeability.NotMergeable });
				} else {
					sibling.update({
						...sibling.item,
						mergeQueueEntry: { position: 1, state: MergeQueueState.Queued, url: 'https://github.com/aaa/bbb/queue' },
					});
				}
				await (panel as any)._stackRefreshPromise;
				assert(stackQuery.calledOnce);
				assert(fullRefresh.notCalled);
			});
		}

		it('updates sibling state without refreshing the entire displayed PR', async function () {
			const { panel, stackQuery, stack, postMessage, fullRefresh } = await openStackPanel();
			const sibling = repo.createOrUpdatePullRequestModel(
				convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(999).build(), repo));
			stackQuery.resolves({
				...stack, pullRequests: [{ ...stack.pullRequests[0], state: GithubItemStateEnum.Closed }, stack.pullRequests[1]],
			});
			sibling.update({ ...sibling.item, state: 'closed' });
			await (panel as any)._stackRefreshPromise;
			assert(stackQuery.calledOnce);
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.stack.pullRequests[0].state, GithubItemStateEnum.Closed);
			assert(fullRefresh.notCalled);
		});

		it('clears stack data when the stack is dissolved', async function () {
			const { panel, stackQuery, postMessage } = await openStackPanel();
			stackQuery.resolves(undefined);
			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			const message = JSON.parse(JSON.stringify(postMessage.lastCall.args[0]));
			assert.strictEqual(message.pullrequest.stack, null);
			assert.strictEqual((panel as any)._stackPullRequestNumbers.size, 0);
		});

		const queueMethods: (MergeMethod | undefined)[] = [undefined, 'merge'];
		for (const method of queueMethods) {
			it(`restores the PR base queue setting after unstacking ${method ? 'when it has a queue' : 'when it has no queue'}`, async function () {
				const { panel, model, stackQuery, stack, postMessage, queueMethod } = await openStackPanel();
				assert.notStrictEqual(model.base.ref, stack.base);
				queueMethod.callsFake(async base => base === stack.base ? 'squash' : method);
				repo.notifyStackChanged([999, 1000]);
				await (panel as any)._stackRefreshPromise;
				assert.strictEqual(postMessage.lastCall.args[0].pullrequest.mergeQueueMethod, 'squash');
				queueMethod.resetHistory();
				postMessage.resetHistory();
				stackQuery.resolves(undefined);

				repo.notifyStackChanged([999, 1000]);
				await (panel as any)._stackRefreshPromise;

				assert(queueMethod.calledOnceWithExactly(model.base.ref, remote.owner, remote.repositoryName));
				const update = JSON.parse(JSON.stringify(postMessage.lastCall.args[0])).pullrequest;
				assert.strictEqual(update.stack, null);
				assert('mergeQueueMethod' in update);
				assert.strictEqual(update.mergeQueueMethod, method ?? null);
			});
		}

		it('ignores changes to unrelated PRs and other repositories', async function () {
			const { panel, stackQuery } = await openStackPanel();
			const unrelated = repo.createOrUpdatePullRequestModel(
				convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(5000).build(), repo));
			const otherRemote = new GitHubRemote('other', 'https://github.com/other/repository',
				new Protocol('https://github.com/other/repository'), GitHubServerType.GitHubDotCom);
			const other = new MockGitHubRepository(otherRemote, credentialStore, telemetry, sinon);
			try {
				unrelated.update({ ...unrelated.item, isDraft: true });
				repo.notifyStackChanged([5000]);
				other.notifyStackChanged([999, 1000]);
				await (panel as any)._stackRefreshPromise;
				assert(stackQuery.notCalled);
			} finally {
				other.dispose();
			}
		});

		it('coalesces a burst of notifications into one stack load', async function () {
			const { panel, stackQuery } = await openStackPanel();
			repo.notifyStackChanged([999, 1000]);
			repo.notifyStackChanged([999, 1000]);
			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			assert(stackQuery.calledOnce);
		});

		it('loads again when a change arrives during an in-flight refresh', async function () {
			const { panel, stackQuery, stack } = await openStackPanel();
			let release!: (value: PullRequestStack) => void;
			let started!: () => void;
			const loading = new Promise<void>(resolve => { started = resolve; });
			stackQuery.onFirstCall().callsFake(() => {
				started();
				return new Promise<PullRequestStack>(resolve => { release = resolve; });
			});
			repo.notifyStackChanged([999, 1000]);
			const refresh = (panel as any)._stackRefreshPromise;
			await loading;
			repo.notifyStackChanged([999, 1000]);
			repo.notifyStackChanged([999, 1000]);
			assert(stackQuery.calledOnce);
			release(stack);
			await refresh;
			assert(stackQuery.calledTwice);
		});

		it('serializes stack requests so newer data is published after the previous request completes', async function () {
			const { panel, stackQuery, stack, postMessage } = await openStackPanel();
			let release!: (value: PullRequestStack) => void;
			let started!: () => void;
			const loading = new Promise<void>(resolve => { started = resolve; });
			stackQuery.onFirstCall().callsFake(() => {
				started();
				return new Promise<PullRequestStack>(resolve => { release = resolve; });
			});
			stackQuery.onSecondCall().resolves({ ...stack, base: 'updated-base' });
			const refreshing = (panel as any).refreshStack();
			await loading;
			assert.strictEqual((panel as any).refreshStack(), refreshing);
			assert(stackQuery.calledOnce);
			release(stack);
			await refreshing;
			assert(stackQuery.calledTwice);
			assert(postMessage.calledTwice);
			assert.strictEqual(postMessage.firstCall.args[0].pullrequest.stack.base, stack.base);
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.stack.base, 'updated-base');
		});

		it('defers a hidden panel refresh until it becomes visible', async function () {
			const { panel, stackQuery } = await openStackPanel();
			const webviewPanel = (panel as any)._panel as vscode.WebviewPanel;
			let visible = false;
			sinon.stub(webviewPanel, 'visible').get(() => visible);
			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			assert(stackQuery.notCalled);
			visible = true;
			(panel as any).onDidChangeViewState({ webviewPanel });
			await (panel as any)._stackRefreshPromise;
			assert(stackQuery.calledOnce);
		});

		it('ignores notifications and pending responses after disposal', async function () {
			const { panel, model, stackQuery, stack, postMessage } = await openStackPanel();
			let release!: (value: PullRequestStack) => void;
			stackQuery.returns(new Promise<PullRequestStack>(resolve => { release = resolve; }));
			const loading = (panel as any).loadStack(model, (panel as any)._updateSequence);
			panel.dispose();
			repo.notifyStackChanged([999, 1000]);
			release(stack);
			await loading;
			assert(stackQuery.calledOnce);
			assert(postMessage.notCalled);
		});

		it('does not load stack data for notifications when stacks are disabled', async function () {
			const { panel, stackQuery } = await openStackPanel();
			setStacksEnabled(false);
			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			assert(stackQuery.notCalled);
		});

		it('surfaces refresh failures and clears the error after a later successful load', async function () {
			const { panel, stackQuery, postMessage } = await openStackPanel();
			stackQuery.onFirstCall().rejects(new Error('Stack is unavailable'));
			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.stackLoadError, true);
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.canUpdateStack, false);
			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.stackLoadError, false);
		});
	});

	describe('updateStack', function () {
		function provideStackGit(repository: Repository): void {
			Object.assign(repository, {
				rebase: async () => undefined,
				rebaseAbort: async () => undefined,
				pushRefWithLease: async () => undefined,
				getRemoteRefs: async () => [],
				updateRef: async () => undefined,
				resetKeep: async () => undefined,
				createWorktree: async () => '',
				deleteWorktree: async () => undefined,
			});
		}

		async function openStackPanel() {
			const result = await createPanel();
			pullRequestManager.activePullRequest = result.model;
			provideStackGit(pullRequestManager.repository);
			result.stackQuery.resolves({
				position: 2, size: 2, base: 'main', needsUpdate: true,
				pullRequests: [
					{ position: 1, number: 999, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
					{ position: 2, number: 1000, title: 'Second', url: '', head: 'D2', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				],
			});
			return result;
		}

		it('offers Update stack for unpropagated middle changes with a checked-out stack PR in another folder', async function () {
			const { panel, model, stackQuery } = await openStackPanel();
			pullRequestManager.activePullRequest = undefined;
			const url = `https://github.com/${remote.owner}/${remote.repositoryName}.git`;
			model.head = new GitHubRef('D2', `${remote.owner}:D2`, 'a'.repeat(40), url, remote.owner, remote.repositoryName, false);
			const other = new FolderRepositoryManager(1, context, new MockRepository(), telemetry,
				new GitApiImpl(repositoriesManager), credentialStore, new CreatePullRequestHelper(), mockThemeWatcher);
			try {
				provideStackGit(other.repository);
				await other.repository.addRemote('origin', url);
				repositoriesManager.insertFolderManager(other);
				PullRequestOverviewPanel.registerGlobalCommands(context, telemetry, repositoriesManager);
				const postMessage = sinon.stub(panel as any, '_postMessage').resolves();
				(panel as any)._canUpdateStackAccess = true;
				const checkedOut = new PullRequestModel(credentialStore, telemetry, repo, remote,
					convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(999).build(), repo));
				other.activePullRequest = checkedOut;
				assert.strictEqual((panel as any).getCheckedOutPullRequestNumber(model), 999);
				assert.strictEqual((panel as any).getStackRepository(model)?.repository, other.repository);
				assert(postMessage.calledWithMatch({ command: 'pr.update-checkout-status', canUpdateStack: false }));
				stackQuery.resolves({
					position: 3, size: 3, base: 'main', needsUpdate: true,
					pullRequests: [
						{ position: 1, number: 998, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
						{ position: 2, number: 999, title: 'Middle', url: '', head: 'D2', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
						{ position: 3, number: 1000, title: 'Top', url: '', head: 'D3', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
					],
				});
				await (panel as any).refreshStack();
				assert(postMessage.calledWithMatch({ command: 'pr.update', pullrequest: { stackLoaded: true, canUpdateStack: true } }));
				other.activePullRequest = undefined;
				assert(postMessage.lastCall.calledWithMatch({ command: 'pr.update-checkout-status', canUpdateStack: false }));
				other.activePullRequest = checkedOut;
				assert(postMessage.lastCall.calledWithMatch({ command: 'pr.update-checkout-status', canUpdateStack: true }));
				const unrelated = new PullRequestModel(credentialStore, telemetry, repo, remote,
					convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(5000).build(), repo));
				other.activePullRequest = unrelated;
				assert(postMessage.lastCall.calledWithMatch({ command: 'pr.update-checkout-status', canUpdateStack: false }));
				other.activePullRequest = checkedOut;
				assert(postMessage.lastCall.calledWithMatch({ command: 'pr.update-checkout-status', canUpdateStack: true }));
				(panel as any)._canUpdateStackAccess = false;
				other.activePullRequest = undefined;
				other.activePullRequest = checkedOut;
				assert(postMessage.lastCall.calledWithMatch({ command: 'pr.update-checkout-status', canUpdateStack: false }));
			} finally {
				other.dispose();
			}
		});

		it('hides Update stack when the stack no longer needs updating', async function () {
			const { panel, model, stackQuery } = await openStackPanel();
			const url = `https://github.com/${remote.owner}/${remote.repositoryName}.git`;
			model.head = new GitHubRef('D2', `${remote.owner}:D2`, 'a'.repeat(40), url, remote.owner, remote.repositoryName, false);
			await pullRequestManager.repository.addRemote('origin', url);
			(panel as any)._canUpdateStackAccess = true;
			const postMessage = sinon.stub(panel as any, '_postMessage').resolves();
			stackQuery.resolves({
				position: 2, size: 2, base: 'main', needsUpdate: false,
				pullRequests: [
					{ position: 1, number: 999, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
					{ position: 2, number: 1000, title: 'Second', url: '', head: 'D2', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				],
			});
			await (panel as any).refreshStack();
			assert(postMessage.lastCall.calledWithMatch({ command: 'pr.update', pullrequest: { canUpdateStack: false } }));
			pullRequestManager.activePullRequest = undefined;
			pullRequestManager.activePullRequest = model;
			assert(postMessage.lastCall.calledWithMatch({ command: 'pr.update-checkout-status', canUpdateStack: false }));
		});

		it('recomputes Update stack eligibility from stack change notifications', async function () {
			const { panel, model, stackQuery } = await openStackPanel();
			const url = `https://github.com/${remote.owner}/${remote.repositoryName}.git`;
			model.head = new GitHubRef('D2', `${remote.owner}:D2`, 'a'.repeat(40), url, remote.owner, remote.repositoryName, false);
			await pullRequestManager.repository.addRemote('origin', url);
			const postMessage = sinon.stub(panel as any, '_postMessage').resolves();
			const stack = await stackQuery();
			assert(stack);

			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.canUpdateStack, true);

			stackQuery.resolves({ ...stack, needsUpdate: false });
			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.canUpdateStack, false);

			stackQuery.rejects(new Error('Stack lookup failed'));
			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			assert(postMessage.lastCall.calledWithMatch({ pullrequest: { stackLoadError: true, canUpdateStack: false } }));

			stackQuery.resolves(stack);
			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			assert(postMessage.lastCall.calledWithMatch({ pullrequest: { stackLoadError: false, canUpdateStack: true } }));

			stackQuery.resolves(undefined);
			repo.notifyStackChanged([999, 1000]);
			await (panel as any)._stackRefreshPromise;
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.stack, null);
			assert.strictEqual(postMessage.lastCall.args[0].pullrequest.canUpdateStack, false);
		});

		it('hides Update stack when a closed PR interrupts the open chain', async function () {
			const { panel, model, stackQuery } = await openStackPanel();
			const url = `https://github.com/${remote.owner}/${remote.repositoryName}.git`;
			model.head = new GitHubRef('D2', `${remote.owner}:D2`, 'a'.repeat(40), url, remote.owner, remote.repositoryName, false);
			await pullRequestManager.repository.addRemote('origin', url);
			(panel as any)._canUpdateStackAccess = true;
			const postMessage = sinon.stub(panel as any, '_postMessage').resolves();
			stackQuery.resolves({
				position: 2, size: 3, base: 'main', needsUpdate: true,
				pullRequests: [
					{ position: 1, number: 998, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
					{ position: 2, number: 999, title: 'Closed', url: '', head: 'D2', state: GithubItemStateEnum.Closed, isDraft: false, mergeable: PullRequestMergeability.Unknown },
					{ position: 3, number: 1000, title: 'Third', url: '', head: 'D3', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				],
			});
			await (panel as any).refreshStack();
			assert(postMessage.lastCall.calledWithMatch({ command: 'pr.update', pullrequest: { canUpdateStack: false } }));
		});

		it('requires a checked-out PR in the stack even for direct webview requests', async function () {
			const { panel } = await openStackPanel();
			pullRequestManager.activePullRequest = undefined;
			const warning = sinon.stub(vscode.window, 'showWarningMessage');
			const throwError = sinon.stub(panel as any, '_throwError').resolves();
			await (panel as any).updateStack({ req: 'unchecked', command: 'pr.update-stack' });
			assert(warning.notCalled);
			assert.match(throwError.firstCall.args[1], /Check out a pull request in this stack/);
		});

		it('updates open panel checkout state when another stack PR becomes active', async function () {
			const { panel } = await openStackPanel();
			const sibling = new PullRequestModel(credentialStore, telemetry, repo, remote,
				convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(999).build(), repo));
			const postMessage = sinon.stub(panel as any, '_postMessage').resolves();
			pullRequestManager.activePullRequest = sibling;
			assert(postMessage.calledWithMatch({ command: 'pr.update-checkout-status', isCurrentlyCheckedOut: false, canUpdateStack: false }));
		});

		it('uses only a writable remote that pushes to the PR repository', async function () {
			const { panel, model } = await openStackPanel();
			const url = `https://github.com/${remote.owner}/${remote.repositoryName}.git`;
			model.head = new GitHubRef('D2', `${remote.owner}:D2`, 'a'.repeat(40), url, remote.owner, remote.repositoryName, false);
			await pullRequestManager.repository.addRemote('origin', url);
			assert.strictEqual((panel as any).getStackRepository(model)?.remote.name, 'origin');
			(pullRequestManager.repository.state.remotes[0] as { pushUrl: string }).pushUrl = 'https://github.com/someone-else/repository.git';
			assert.strictEqual((panel as any).getStackRepository(model), undefined);
		});

		it('hides Update stack when the built-in Git API lacks safe push operations', async function () {
			const { panel, model } = await openStackPanel();
			const url = `https://github.com/${remote.owner}/${remote.repositoryName}.git`;
			model.head = new GitHubRef('D2', `${remote.owner}:D2`, 'a'.repeat(40), url, remote.owner, remote.repositoryName, false);
			await pullRequestManager.repository.addRemote('origin', url);
			Reflect.deleteProperty(pullRequestManager.repository, 'pushRefWithLease');
			assert.strictEqual((panel as any).getStackRepository(model), undefined);
		});

		it('rejects a stack with conflicts before confirming or performing Git operations', async function () {
			const { panel, stackQuery } = await openStackPanel();
			stackQuery.resolves({
				position: 1, size: 1, base: 'main',
				pullRequests: [{ position: 1, number: 1000, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Conflict }],
			});
			const warning = sinon.stub(vscode.window, 'showWarningMessage');
			const progress = sinon.stub(vscode.window, 'withProgress');
			const throwError = sinon.stub(panel as any, '_throwError').resolves();
			await (panel as any).updateStack({ req: '1', command: 'pr.update-stack' });
			assert(warning.notCalled);
			assert(progress.notCalled);
			assert.match(throwError.firstCall.args[1], /conflict-free chain/);
		});

		it('confirms only open PRs when trailing stack members are closed', async function () {
			const { panel, stackQuery } = await openStackPanel();
			stackQuery.resolves({
				position: 2, size: 4, base: 'master',
				pullRequests: [
					{ position: 1, number: 999, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
					{ position: 2, number: 1000, title: 'Second', url: '', head: 'D2', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
					{ position: 3, number: 1001, title: 'Third', url: '', head: 'D3', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
					{ position: 4, number: 1002, title: 'Fourth', url: '', head: 'D4', state: GithubItemStateEnum.Closed, isDraft: true, mergeable: PullRequestMergeability.Unknown },
				],
			});
			const confirm = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
			const progress = sinon.stub(vscode.window, 'withProgress');
			const reply = sinon.stub(panel as any, '_replyMessage').resolves();
			await (panel as any).updateStack({ req: 'closed-top', command: 'pr.update-stack' });
			assert.match(confirm.firstCall.args[0], /3 pull requests/);
			assert.match((confirm.firstCall.args[1] as vscode.MessageOptions).detail!, /Closed pull requests at the top/);
			assert(progress.notCalled);
			assert(reply.calledOnce);
		});

		it('rejects a closed PR in the middle of an otherwise open stack', async function () {
			const { panel, stackQuery } = await openStackPanel();
			stackQuery.resolves({
				position: 2, size: 3, base: 'master',
				pullRequests: [
					{ position: 1, number: 999, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
					{ position: 2, number: 1000, title: 'Second', url: '', head: 'D2', state: GithubItemStateEnum.Closed, isDraft: false, mergeable: PullRequestMergeability.Unknown },
					{ position: 3, number: 1001, title: 'Third', url: '', head: 'D3', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				],
			});
			const confirm = sinon.stub(vscode.window, 'showWarningMessage');
			const throwError = sinon.stub(panel as any, '_throwError').resolves();
			await (panel as any).updateStack({ req: 'closed-middle', command: 'pr.update-stack' });
			assert(confirm.notCalled);
			assert.match(throwError.firstCall.args[1], /open, conflict-free chain/);
		});

		it('rejects a direct update request when stacks are disabled', async function () {
			setStacksEnabled(false);
			const { panel, stackQuery } = await openStackPanel();
			const throwError = sinon.stub(panel as any, '_throwError').resolves();
			await (panel as any).updateStack({ req: 'disabled', command: 'pr.update-stack' });
			assert(stackQuery.notCalled);
			assert.match(throwError.firstCall.args[1], /stack features are disabled/);
		});

		it('does not update branches when the user cancels the force-push confirmation', async function () {
			const { panel } = await openStackPanel();
			sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
			const progress = sinon.stub(vscode.window, 'withProgress');
			const reply = sinon.stub(panel as any, '_replyMessage').resolves();
			const message = { req: '2', command: 'pr.update-stack' };
			await (panel as any).updateStack(message);
			assert(progress.notCalled);
			sinon.assert.calledWithExactly(reply, message, { updatedPullRequests: [] });
		});

		it('rejects overlapping updates without unlocking the first update', async function () {
			const { panel } = await openStackPanel();
			let finishConfirmation!: () => void;
			const confirmation = new Promise<void>(resolve => { finishConfirmation = resolve; });
			let startConfirmation!: () => void;
			const confirmationStarted = new Promise<void>(resolve => { startConfirmation = resolve; });
			const warning = sinon.stub(vscode.window, 'showWarningMessage').callsFake(async () => {
				startConfirmation();
				await confirmation;
				return undefined;
			});
			const throwError = sinon.stub(panel as any, '_throwError').resolves();
			const reply = sinon.stub(panel as any, '_replyMessage').resolves();
			const first = (panel as any).updateStack({ req: 'first', command: 'pr.update-stack' });
			await confirmationStarted;
			await (panel as any).updateStack({ req: 'second', command: 'pr.update-stack' });
			assert.match(throwError.firstCall.args[1], /already being updated/);
			await (panel as any).updateStack({ req: 'third', command: 'pr.update-stack' });
			assert.match(throwError.secondCall.args[1], /already being updated/);
			assert(warning.calledOnce);
			finishConfirmation();
			await first;
			assert(reply.calledOnce);
		});

		it('shows a progress notification and reports a missing writable remote', async function () {
			const { panel } = await openStackPanel();
			const cancellation = new vscode.CancellationTokenSource();
			sinon.stub(vscode.window, 'showWarningMessage').resolves('Update stack' as never);
			const progress = sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) =>
				task({ report: () => undefined }, cancellation.token));
			const throwError = sinon.stub(panel as any, '_throwError').resolves();
			const changed = sinon.spy(repo, 'notifyStackChanged');
			await (panel as any).updateStack({ req: '3', command: 'pr.update-stack' });
			assert(progress.calledOnce);
			assert.strictEqual(progress.firstCall.args[0].location, vscode.ProgressLocation.Notification);
			assert(throwError.calledOnce);
			assert.match(throwError.firstCall.args[1], /writable Git remote/);
			assert(changed.calledOnceWithExactly([999, 1000]));
			sinon.assert.callOrder(progress, throwError, changed);
			await (panel as any)._stackRefreshPromise;
			cancellation.dispose();
		});
	});

	describe('unstackAll', function () {
		it('rejects unstacking while another panel updates the stack', async function () {
			const { panel } = await createPanel();
			const lock = (PullRequestOverviewPanel as any)._updatingStacks as Set<string>;
			lock.add(`${remote.owner}/${remote.repositoryName}#999`);
			const unstack = sinon.stub(repo, 'unstackAll');
			const throwError = sinon.stub(panel as any, '_throwError').resolves();
			try {
				await (panel as any).unstackAll({ req: 'locked', command: 'pr.unstack-all' });
				assert(unstack.notCalled);
				assert.match(throwError.firstCall.args[1], /already being updated/);
				assert(lock.has(`${remote.owner}/${remote.repositoryName}#999`));
			} finally {
				lock.delete(`${remote.owner}/${remote.repositoryName}#999`);
			}
		});

		it('excludes updates and other unstack requests while unstacking another panel', async function () {
			const { panel } = await createPanel();
			const { panel: other, model, stackQuery } = await createPanel(999);
			stackQuery.resolves({
				position: 1, size: 2, base: 'main', needsUpdate: true,
				pullRequests: [
					{ position: 1, number: 999, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Behind },
					{ position: 2, number: 1000, title: 'Second', url: '', head: 'D2', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				],
			});
			pullRequestManager.activePullRequest = model;
			const locks = (PullRequestOverviewPanel as any)._updatingStacks as Set<string>;
			const key = `${remote.owner}/${remote.repositoryName}#999`;
			const confirm = sinon.stub(vscode.window, 'showWarningMessage').resolves('Unstack all' as never);
			sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
			sinon.stub(panel, 'refreshPanel').resolves();
			sinon.stub(other, 'refreshPanel').resolves();
			const errors = sinon.stub(other as any, '_throwError').resolves();
			let finish!: (remaining: number[]) => void;
			let started!: () => void;
			const unstackStarted = new Promise<void>(resolve => { started = resolve; });
			const unstack = sinon.stub(repo, 'unstackAll').callsFake(() => {
				assert(locks.has(key));
				started();
				return new Promise<number[]>(resolve => { finish = resolve; });
			});
			const pending = (panel as any).unstackAll({ req: 'first', command: 'pr.unstack-all' });
			try {
				await unstackStarted;
				await (other as any).updateStack({ req: 'update', command: 'pr.update-stack' });
				assert.match(errors.lastCall.args[1], /already being updated/);
				assert(locks.has(key));
				await (other as any).unstackAll({ req: 'unstack', command: 'pr.unstack-all' });
				assert.match(errors.lastCall.args[1], /already being updated/);
				assert(locks.has(key));
				assert(unstack.calledOnce);
				assert(confirm.calledOnce);
			} finally {
				finish([]);
				await pending;
			}
			assert.strictEqual(locks.has(key), false);
		});

		it('rechecks the lock after confirmation without releasing another action lock', async function () {
			const { panel } = await createPanel();
			const locks = (PullRequestOverviewPanel as any)._updatingStacks as Set<string>;
			const key = `${remote.owner}/${remote.repositoryName}#999`;
			const unstack = sinon.stub(repo, 'unstackAll');
			const errors = sinon.stub(panel as any, '_throwError').resolves();
			sinon.stub(vscode.window, 'showWarningMessage').callsFake(async (_message, _options, action) => {
				locks.add(key);
				return action;
			});
			try {
				await (panel as any).unstackAll({ req: 'confirmation-race', command: 'pr.unstack-all' });
				assert(unstack.notCalled);
				assert.match(errors.firstCall.args[1], /already being updated/);
				assert(locks.has(key));
			} finally {
				locks.delete(key);
			}
		});

		it('releases its stack lock when the unstack operation fails', async function () {
			const { panel } = await createPanel();
			const locks = (PullRequestOverviewPanel as any)._updatingStacks as Set<string>;
			const key = `${remote.owner}/${remote.repositoryName}#999`;
			sinon.stub(vscode.window, 'showWarningMessage').resolves('Unstack all' as never);
			sinon.stub(repo, 'unstackAll').callsFake(async () => {
				assert(locks.has(key));
				throw new Error('Stack is locked on GitHub');
			});
			const errors = sinon.stub(panel as any, '_throwError').resolves();

			await (panel as any).unstackAll({ req: 'failed', command: 'pr.unstack-all' });

			assert.match(errors.firstCall.args[1], /Stack is locked on GitHub/);
			assert.strictEqual(locks.has(key), false);
		});


		it('confirms unstacking all eligible PRs and reports remaining locked PRs', async function () {
			const { panel } = await createPanel();
			const confirm = sinon.stub(vscode.window, 'showWarningMessage').resolves('Unstack all' as never);
			const information = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
			const unstack = sinon.stub(repo, 'unstackAll').resolves([999]);
			const reply = sinon.stub(panel as any, '_replyMessage').resolves();
			const message = { req: '1', command: 'pr.unstack-all', args: undefined };

			await (panel as any).unstackAll(message);

			assert.strictEqual((confirm.firstCall.args[1] as vscode.MessageOptions).modal, true);
			assert.match((confirm.firstCall.args[1] as vscode.MessageOptions).detail!, /Eligible open, draft, and closed pull requests/);
			assert.match((confirm.firstCall.args[1] as vscode.MessageOptions).detail!, /Merged, queued, and currently merging pull requests will remain/);
			assert(unstack.calledOnceWithExactly(1000, [999, 1000]));
			sinon.assert.calledWithExactly(reply, message, { cancelled: false, remainingPullRequests: [999] });
			assert(information.calledOnce);
			assert.match(information.firstCall.args[0], /1 merged, queued, or currently merging pull requests remain/);
			sinon.assert.callOrder(unstack, reply);
		});

		it('keeps the confirmed membership when stack data changes while the modal is open', async function () {
			const { panel, stackQuery } = await createPanel();
			const stack = await stackQuery();
			assert(stack);
			sinon.stub(vscode.window, 'showWarningMessage').callsFake(async (_message, _options, action) => {
				stack.pullRequests[0].number = 998;
				return action;
			});
			sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
			const unstack = sinon.stub(repo, 'unstackAll').resolves([999]);
			sinon.stub(panel as any, '_replyMessage').resolves();
			sinon.stub(panel, 'refreshPanel').resolves();

			await (panel as any).unstackAll({ req: '6', command: 'pr.unstack-all', args: undefined });

			assert(unstack.calledOnceWithExactly(1000, [999, 1000]));
		});

		it('explains that currently merging PRs may remain when nothing is unstacked', async function () {
			const { panel } = await createPanel();
			sinon.stub(vscode.window, 'showWarningMessage').resolves('Unstack all' as never);
			const information = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
			sinon.stub(repo, 'unstackAll').resolves([999, 1000]);
			sinon.stub(panel as any, '_replyMessage').resolves();
			sinon.stub(panel, 'refreshPanel').resolves();

			await (panel as any).unstackAll({ req: '7', command: 'pr.unstack-all', args: undefined });

			assert.match(information.firstCall.args[0], /No pull requests were unstacked.*currently merging pull requests remain/);
		});

		it('does not unstack when the feature is disabled', async function () {
			setStacksEnabled(false);
			const { panel, showError } = await createPanel();
			const unstack = sinon.stub(repo, 'unstackAll');
			const throwError = sinon.stub(panel as any, '_throwError').resolves();
			const message = { req: 'disabled', command: 'pr.unstack-all', args: undefined };

			await (panel as any).unstackAll(message);

			assert(unstack.notCalled);
			assert(showError.calledOnce);
			assert.match(throwError.firstCall.args[1], /stack features are disabled/);
		});

		it('does not call the Stacks API when confirmation is cancelled', async function () {
			const { panel } = await createPanel();
			sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
			const unstack = sinon.stub(repo, 'unstackAll');
			const reply = sinon.stub(panel as any, '_replyMessage').resolves();
			const message = { req: '2', command: 'pr.unstack-all', args: undefined };

			await (panel as any).unstackAll(message);

			assert(unstack.notCalled);
			sinon.assert.calledWithExactly(reply, message, { cancelled: true });
			assert.strictEqual((PullRequestOverviewPanel as any)._updatingStacks.has(`${remote.owner}/${remote.repositoryName}#999`), false);
		});

		it('rejects unstacking without write permission', async function () {
			const { panel, access } = await createPanel();
			access.resolves({
				hasWritePermission: false,
				mergeMethodsAvailability: { merge: true, squash: true, rebase: true },
				viewerCanAutoMerge: false,
			});
			const unstack = sinon.stub(repo, 'unstackAll');
			const reply = sinon.stub(panel as any, '_throwError').resolves();
			const message = { req: '3', command: 'pr.unstack-all', args: undefined };

			await (panel as any).unstackAll(message);

			assert(unstack.notCalled);
			assert.match(reply.firstCall.args[1], /do not have permission/);
		});

		it('does not offer to unstack a stack containing only merged PRs', async function () {
			const { panel, stackQuery } = await createPanel();
			stackQuery.resolves({
				position: 1, size: 1, base: 'main',
				pullRequests: [{ position: 1, number: 1000, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Merged, isDraft: false, mergeable: PullRequestMergeability.Unknown }],
			});
			const warning = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
			const unstack = sinon.stub(repo, 'unstackAll');
			const reply = sinon.stub(panel as any, '_throwError').resolves();

			await (panel as any).unstackAll({ req: '4', command: 'pr.unstack-all', args: undefined });

			assert(warning.notCalled);
			assert(unstack.notCalled);
			assert.match(reply.firstCall.args[1], /No unmerged pull requests/);
		});
	});

	describe('deleteBranch', function () {
		it('replies with the deletion state after deletion completes', async function () {
			const { panel } = await createPanel();
			const response = { command: 'pr.deleteBranch', branchTypes: ['local'] };
			sinon.stub(PullRequestReviewCommon, 'deleteBranch').resolves({ isReply: false, message: response });
			const replyMessage = sinon.stub(panel as any, '_replyMessage').resolves();
			const postMessage = sinon.stub(panel as any, '_postMessage').resolves();
			const refreshPanel = sinon.stub(panel as any, 'refreshPanel').resolves();
			const message = { req: '1', command: 'pr.deleteBranch', args: undefined };

			await (panel as any).deleteBranch(message);

			sinon.assert.calledOnce(replyMessage);
			sinon.assert.calledWithExactly(replyMessage, message, response);
			sinon.assert.calledOnce(refreshPanel);
			sinon.assert.notCalled(postMessage);
		});
	});
});
