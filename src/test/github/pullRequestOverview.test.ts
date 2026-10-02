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
import { panelKey } from '../../github/issueOverview';
import { PullRequestModel } from '../../github/pullRequestModel';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { Protocol } from '../../common/protocol';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { GitApiImpl } from '../../api/api1';
import { CredentialStore } from '../../github/credentials';
import { GitHubServerType } from '../../common/authentication';
import { GitHubRemote } from '../../common/remote';
import { CheckState, GithubItemStateEnum, IAccount, PullRequestMergeability } from '../../github/interface';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';
import { TimelineEvent } from '../../common/timelineEvent';
import { PullRequestReviewCommon } from '../../github/pullRequestReviewCommon';
import { COPILOT_REVIEWER_ACCOUNT } from '../../common/copilot';
import Logger from '../../common/logger';
import { PullRequest, PullRequestPreview } from '../../github/views';

const EXTENSION_URI = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '../../..');

describe('PullRequestOverview', function () {
	let sinon: SinonSandbox;
	let pullRequestManager: FolderRepositoryManager;
	let context: MockExtensionContext;
	let remote: GitHubRemote;
	let repo: MockGitHubRepository;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;
	let mockThemeWatcher: MockThemeWatcher;

	beforeEach(async function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		context = new MockExtensionContext();

		const repository = new MockRepository();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		mockThemeWatcher = new MockThemeWatcher();
		const createPrHelper = new CreatePullRequestHelper();
		const repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
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

		pullRequestManager.dispose();
		context.dispose();
		sinon.restore();
	});

	describe('createOrShow', function () {
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
		const preview: PullRequestPreview = {
			number: 1000, title: 'Preview title', titleHTML: 'Preview title',
			body: 'Preview description', bodyHTML: '<p>Preview description</p>', url: 'https://github.com/aaa/bbb/pull/1000',
			author: COPILOT_REVIEWER_ACCOUNT, createdAt: '2026-10-01T10:00:00Z',
			state: GithubItemStateEnum.Open, isDraft: false, base: 'aaa/bbb:main', head: 'aaa/bbb:feature',
		};

		beforeEach(function () {
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo);
			prModel = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem);
			sinon.stub(pullRequestManager, 'createGitHubRepositoryFromOwnerName').resolves(repo);
			getPreview = sinon.stub(repo, 'getPullRequestPreview').resolves(preview);
			sinon.stub(pullRequestManager, 'getCurrentUser').resolves(prModel.author);
			sinon.stub(prModel, 'canEdit').resolves(true);
			getReviewRequests = sinon.stub(prModel, 'getReviewRequests').resolves([]);
			sinon.stub(prModel, 'getTimelineEvents').resolves([]);
			sinon.stub(prModel, 'validateDraftMode').resolves(false);
			sinon.stub(prModel, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);
			sinon.stub(prModel, 'getMergeability').resolves({ mergeability: PullRequestMergeability.Mergeable });
			sinon.stub(pullRequestManager, 'getBranchNameForPullRequest').resolves(undefined);
			sinon.stub(pullRequestManager, 'mergeQueueMethodForBranch').resolves(undefined);
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

		it('shows the title and description while the full PR is still pending', async function () {
			let resolveModel: (model: PullRequestModel) => void;
			const opening = openPanel(new Promise<PullRequestModel>(resolve => resolveModel = resolve));
			try {
				await new Promise(resolve => setImmediate(resolve));
				assert.deepStrictEqual(messages.find(message => message.command === 'pr.preview')?.pullrequest, preview);
				assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
				sinon.assert.notCalled(getAssignableUsers);
			} finally {
				resolveModel!(prModel);
				await opening;
			}
			assert.ok(messages.some(message => message.command === 'pr.initialize'));
		});

		it('does not fetch a preview for an already available PR model', async function () {
			await openPanel();
			sinon.assert.notCalled(getPreview);
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

		it('ignores a preview from an older lookup while a newer lookup is pending', async function () {
			let resolvePreview: (value: PullRequestPreview) => void;
			let resolveFirst: (value: PullRequestModel) => void;
			let resolveSecond: (value: PullRequestModel) => void;
			getPreview.onFirstCall().returns(new Promise(resolve => resolvePreview = resolve));
			const first = openPanel(new Promise(resolve => resolveFirst = resolve));
			await new Promise(resolve => setImmediate(resolve));
			const second = openPanel(new Promise(resolve => resolveSecond = resolve));
			try {
				await new Promise(resolve => setImmediate(resolve));
				messages.length = 0;
				resolvePreview!({ ...preview, title: 'Outdated preview' });
				await new Promise(resolve => setImmediate(resolve));
				assert.strictEqual(messages.some(message => message.command === 'pr.preview'), false);
			} finally {
				resolveFirst!(prModel);
				resolveSecond!(prModel);
				await Promise.all([first, second]);
			}
		});

		it('does not let a late preview replace the complete PR', async function () {
			let resolvePreview: (value: PullRequestPreview) => void;
			let resolveModel: (value: PullRequestModel) => void;
			getPreview.returns(new Promise(resolve => resolvePreview = resolve));
			const opening = openPanel(new Promise(resolve => resolveModel = resolve));
			await new Promise(resolve => setImmediate(resolve));
			resolveModel!(prModel);
			await opening;
			resolvePreview!(preview);
			await new Promise(resolve => setImmediate(resolve));

			assert.strictEqual(messages.some(message => message.command === 'pr.preview'), false);
			assert.ok(messages.some(message => message.command === 'pr.initialize'));
		});

		it('ignores a preview that finishes after the panel is closed', async function () {
			let resolvePreview: (value: PullRequestPreview) => void;
			let resolveModel: (value: PullRequestModel) => void;
			getPreview.returns(new Promise(resolve => resolvePreview = resolve));
			const opening = openPanel(new Promise(resolve => resolveModel = resolve));
			await new Promise(resolve => setImmediate(resolve));
			webviewPanel.dispose();
			resolvePreview!(preview);
			resolveModel!(prModel);
			await opening;

			assert.strictEqual(messages.some(message => message.command === 'pr.preview'), false);
		});

		it('logs a preview failure without preventing full PR initialization', async function () {
			let resolveModel: (value: PullRequestModel) => void;
			getPreview.rejects(new Error('Preview unavailable'));
			const logError = sinon.spy(Logger, 'error');
			const opening = openPanel(new Promise(resolve => resolveModel = resolve));
			try {
				await new Promise(resolve => setImmediate(resolve));
				assert.ok(logError.getCalls().some(call => typeof call.args[0] === 'string' && call.args[0].includes('Preview unavailable')));
			} finally {
				resolveModel!(prModel);
				await opening;
			}
			assert.ok(messages.some(message => message.command === 'pr.initialize'));
		});

		it('loads the webview before a supplied PR model resolves', async function () {
			let resolveModel: (model: PullRequestModel) => void;
			const pendingModel = new Promise<PullRequestModel>(resolve => resolveModel = resolve);
			const opening = openPanel(pendingModel);
			try {
				assert.ok(webviewPanel.webview.html.includes('webview-pr-description.js'));
				assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
			} finally {
				resolveModel!(prModel);
				await opening;
			}
			assert.strictEqual(messages.find(message => message.command === 'pr.initialize')?.pullrequest?.title, prModel.title);
		});

		it('does not initialize a closed panel when its PR model resolves', async function () {
			let resolveModel: (model: PullRequestModel) => void;
			const pendingModel = new Promise<PullRequestModel>(resolve => resolveModel = resolve);
			const opening = openPanel(pendingModel);
			webviewPanel.dispose();
			resolveModel!(prModel);
			await opening;

			assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
			sinon.assert.notCalled(getAssignableUsers);
		});

		it('does not overwrite a newer model when an older lookup finishes', async function () {
			let resolveModel: (model: PullRequestModel) => void;
			const pendingModel = new Promise<PullRequestModel>(resolve => resolveModel = resolve);
			const opening = openPanel(pendingModel);
			await openPanel();
			messages.length = 0;
			resolveModel!(prModel);
			await opening;

			assert.strictEqual(messages.some(message => message.command === 'pr.initialize'), false);
			sinon.assert.calledOnce(getAssignableUsers);
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

	describe('mergePullRequest', function () {
		it('prompts to delete the local branch when GitHub deletes branches after merge', async function () {
			repo.buildMetadata(repository => repository.delete_branch_on_merge!(true));
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
			sinon.stub(prModel, 'merge').resolves({ merged: true, message: '', timeline: [] });
			sinon.stub(pullRequestManager, 'getBranchNameForPullRequest').resolves({
				branch: 'new-feature',
				createdForPullRequest: false,
			});
			sinon.stub(pullRequestManager, 'getPullRequestRepositoryDefaultBranch').resolves('main');
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

	describe('deleteBranch', function () {
		it('replies with the deletion state after deletion completes', async function () {
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo);
			const prModel = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem);
			const identity = { owner: prModel.remote.owner, repo: prModel.remote.repositoryName, number: prModel.number };
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity, prModel);
			const panel = PullRequestOverviewPanel.findPanel(identity.owner, identity.repo, identity.number)!;
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
