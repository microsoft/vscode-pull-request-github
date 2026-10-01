/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { SinonSandbox, createSandbox, match as sinonMatch } from 'sinon';

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
import { CheckState, GithubItemStateEnum, PullRequestMergeability, PullRequestStack } from '../../github/interface';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';
import { mockStackSetting } from '../mocks/mockStackSetting';
import { TimelineEvent } from '../../common/timelineEvent';
import { PullRequestReviewCommon, ReviewContext } from '../../github/pullRequestReviewCommon';

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
	let setStacksEnabled: (enabled: boolean) => void;

	beforeEach(async function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		setStacksEnabled = mockStackSetting(sinon);
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

	async function createPanel() {
		const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo);
		const model = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem);
		const identity = { owner: remote.owner, repo: remote.repositoryName, number: model.number };
		await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, identity, model);
		const panel = PullRequestOverviewPanel.findPanel(identity.owner, identity.repo, identity.number)!;
		const stackQuery = sinon.stub(model, 'getStack').resolves({
			position: 2, size: 2, base: 'main',
			pullRequests: [
				{ position: 1, number: 999, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Merged, isDraft: false, mergeable: PullRequestMergeability.Unknown },
				{ position: 2, number: 1000, title: 'Second', url: '', head: 'D2', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
			],
		});
		const access = sinon.stub(pullRequestManager, 'getPullRequestRepositoryAccessAndMergeMethods').resolves({
			hasWritePermission: true,
			mergeMethodsAvailability: { merge: true, squash: true, rebase: true },
			viewerCanAutoMerge: false,
		});
		return { panel, model, access, stackQuery };
	}

	describe('loadStack', function () {
		it('marks the stack loaded before posting linked stack details', async function () {
			const { panel, model, stackQuery } = await createPanel();
			sinon.stub(pullRequestManager, 'mergeQueueMethodForBranch').resolves(undefined);
			const onLoaded = sinon.spy();
			const postMessage = sinon.stub(panel as any, '_postMessage').callsFake(async (message: { pullrequest?: { stackLoaded?: boolean } }) => {
				if (message.pullrequest?.stackLoaded) {
					assert(onLoaded.calledOnce);
				}
			});

			await (panel as any).loadStack(model, (panel as any)._updateSequence, onLoaded);

			assert(stackQuery.calledOnce);
			const update = postMessage.getCalls().find(call => call.args[0].pullrequest?.stackLoaded);
			assert(update);
			assert.strictEqual(update.args[0].pullrequest.stack.pullRequests.length, 2);
			assert(update.args[0].pullrequest.stack.pullRequests.every(entry => entry.url.includes('/open-pull-request-webview')));
		});

		it('ignores results from a stale overview update', async function () {
			const { panel, model } = await createPanel();
			const postMessage = sinon.stub(panel as any, '_postMessage').resolves();
			const onLoaded = sinon.spy();

			await (panel as any).loadStack(model, (panel as any)._updateSequence - 1, onLoaded);

			assert(onLoaded.notCalled);
			assert(postMessage.notCalled);
		});
	});

	describe('unstackAll', function () {

		it('confirms unstacking all eligible PRs and reports remaining locked PRs', async function () {
			const { panel } = await createPanel();
			const confirm = sinon.stub(vscode.window, 'showWarningMessage').resolves('Unstack all' as never);
			const information = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
			const unstack = sinon.stub(repo, 'unstackAll').resolves([999]);
			const reply = sinon.stub(panel as any, '_replyMessage').resolves();
			const refresh = sinon.stub(panel, 'refreshPanel').resolves();
			const message = { req: '1', command: 'pr.unstack-all', args: undefined };

			await (panel as any).unstackAll(message);

			assert.strictEqual((confirm.firstCall.args[1] as vscode.MessageOptions).modal, true);
			assert.match((confirm.firstCall.args[1] as vscode.MessageOptions).detail!, /Merged and queued pull requests will remain/);
			assert(unstack.calledOnceWithExactly(1000));
			sinon.assert.calledWithExactly(reply, message, { cancelled: false, remainingPullRequests: [999] });
			assert(refresh.calledOnce);
			assert(information.calledOnce);
			sinon.assert.callOrder(unstack, reply, refresh);
		});

		it('does not unstack when the feature is disabled', async function () {
			setStacksEnabled(false);
			const { panel } = await createPanel();
			const unstack = sinon.stub(repo, 'unstackAll');
			const showError = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
			const throwError = sinon.stub(panel as any, '_throwError').resolves();
			const message = { req: 'disabled', command: 'pr.unstack-all', args: undefined };

			await (panel as any).unstackAll(message);

			assert(unstack.notCalled);
			assert(showError.calledOnce);
			assert.match(throwError.firstCall.args[1], /stack features are disabled/);
		});

		it('refreshes other visible PR panels in the unstacked stack', async function () {
			const { panel } = await createPanel();
			const siblingModel = new PullRequestModel(credentialStore, telemetry, repo, remote,
				convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(999).build(), repo));
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager,
				{ owner: remote.owner, repo: remote.repositoryName, number: 999 }, siblingModel);
			const sibling = PullRequestOverviewPanel.findPanel(remote.owner, remote.repositoryName, 999)!;
			const refreshSibling = sinon.stub(sibling, 'refreshPanel').resolves();
			sinon.stub(panel, 'refreshPanel').resolves();
			sinon.stub(panel as any, '_replyMessage').resolves();
			sinon.stub(vscode.window, 'showWarningMessage').resolves('Unstack all' as never);
			sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
			sinon.stub(repo, 'unstackAll').resolves([]);

			await (panel as any).unstackAll({ req: '5', command: 'pr.unstack-all', args: undefined });

			assert(refreshSibling.calledOnce);
		});

		it('refreshes the stack entry in other open panels when a PR changes draft state', async function () {
			const { panel, model } = await createPanel();
			const siblingModel = new PullRequestModel(credentialStore, telemetry, repo, remote,
				convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(999).build(), repo));
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager,
				{ owner: remote.owner, repo: remote.repositoryName, number: 999 }, siblingModel);
			const sibling = PullRequestOverviewPanel.findPanel(remote.owner, remote.repositoryName, 999)!;
			const refreshCurrent = sinon.stub(panel, 'refreshPanel').resolves();
			let finishRefresh: () => void;
			const refreshedSibling = new Promise<void>(resolve => { finishRefresh = resolve; });
			const refreshSibling = sinon.stub(sibling, 'refreshPanel').callsFake(async () => finishRefresh());

			(model as any)._onDidChange.fire({ draft: true });
			await refreshedSibling;

			assert(refreshCurrent.calledOnce);
			assert(refreshSibling.calledOnce);
		});

		it('refreshes only the requested open stack panels', async function () {
			const { panel } = await createPanel();
			const refresh = sinon.stub(panel, 'refreshPanel').resolves();

			await PullRequestOverviewPanel.refreshStackPanels(remote.owner, remote.repositoryName, [1000, 999]);

			assert(refresh.calledOnce);
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
			sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
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
			sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);

			await (panel as any).unstackAll({ req: '4', command: 'pr.unstack-all', args: undefined });

			assert(warning.notCalled);
			assert(unstack.notCalled);
			assert.match(reply.firstCall.args[1], /No unmerged pull requests/);
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
