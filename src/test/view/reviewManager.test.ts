/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { SinonFakeTimers, SinonSandbox, createSandbox } from 'sinon';
import * as vscode from 'vscode';
import type { Branch } from '../../api/api';
import { GitApiImpl } from '../../api/api1';
import { ITelemetry } from '../../common/telemetry';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestMetadata } from '../../github/pullRequestGitHelper';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { PullRequestChangesTreeDataProvider } from '../../view/prChangesTreeDataProvider';
import { PullRequestsTreeDataProvider } from '../../view/prsTreeDataProvider';
import { ReviewManager, ShowPullRequest } from '../../view/reviewManager';
import { WebviewViewCoordinator } from '../../view/webviewViewCoordinator';
import { FOCUS_REVIEW_MODE } from '../../constants';
import { MockPrsTreeModel } from '../mocks/mockPRsTreeModel';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';
import { PrsTreeModel } from '../../view/prsTreeModel';

describe('ReviewManager polling', function () {
	const POLL_MIN_INTERVAL_MS = 1000 * 60 * 5;
	const POLL_MAX_INTERVAL_MS = 1000 * 60 * 30;
	const POLL_BACKOFF_MULTIPLIER = 2;

	let sinon: SinonSandbox;
	let clock: SinonFakeTimers;
	let repository: MockRepository;
	let telemetry: ITelemetry;
	let context: MockExtensionContext;
	let reposManager: RepositoriesManager;
	let gitApi: GitApiImpl;
	let manager: FolderRepositoryManager;
	let reviewManager: ReviewManager;
	let showPullRequest: ShowPullRequest;
	let onDidChangeWindowStateCallback: ((state: vscode.WindowState) => unknown) | undefined;
	let isWindowFocused: boolean;
	let setTimeoutSpy: sinon.SinonSpy;

	beforeEach(function () {
		sinon = createSandbox();
		clock = sinon.useFakeTimers();
		MockCommandRegistry.install(sinon);
		setTimeoutSpy = sinon.spy(global, 'setTimeout');

		isWindowFocused = true;
		sinon.stub(vscode.window, 'state').get(() => ({ focused: isWindowFocused } as vscode.WindowState));
		sinon.stub(vscode.window, 'onDidChangeWindowState').callsFake(listener => {
			onDidChangeWindowStateCallback = listener;
			return new vscode.Disposable(() => { });
		});

		telemetry = new MockTelemetry();
		context = new MockExtensionContext();
		repository = new MockRepository();
		repository.addRemote('origin', 'git@github.com:aaa/bbb');

		const credentialStore = new CredentialStore(telemetry, context);
		reposManager = new RepositoriesManager(credentialStore, telemetry);
		gitApi = new GitApiImpl(reposManager);

		const mockPrsTreeModel = new MockPrsTreeModel() as unknown as PrsTreeModel;
		const prsTreeProvider = new PullRequestsTreeDataProvider(mockPrsTreeModel, telemetry, context, reposManager);
		const activePrViewCoordinator = new WebviewViewCoordinator(context);
		const createPrHelper = new CreatePullRequestHelper();
		const themeWatcher = new MockThemeWatcher();

		manager = new FolderRepositoryManager(0, context, repository, telemetry, gitApi, credentialStore, createPrHelper, themeWatcher);
		reposManager.insertFolderManager(manager);

		const changesTreeProvider = new PullRequestChangesTreeDataProvider(gitApi, reposManager);
		showPullRequest = new ShowPullRequest();
		reviewManager = new ReviewManager(
			0,
			context,
			repository,
			manager,
			telemetry,
			changesTreeProvider,
			prsTreeProvider,
			showPullRequest,
			activePrViewCoordinator,
			createPrHelper,
			gitApi,
		);
	});

	afterEach(function () {
		reviewManager.dispose();
		sinon.restore();
		clock.restore();
	});

	async function flushMicrotasks() {
		await Promise.resolve();
		await Promise.resolve();
	}

	function latestScheduledDelay(): number {
		const delays = setTimeoutSpy.getCalls()
			.map(call => call.args[1])
			.filter((delay): delay is number => typeof delay === 'number');
		assert.ok(delays.length > 0, 'expected at least one scheduled timer');
		return delays[delays.length - 1];
	}

	it('backs off polling interval when no change is detected', async function () {
		sinon.stub(reviewManager, 'updateState').resolves();

		assert.strictEqual(latestScheduledDelay(), POLL_MIN_INTERVAL_MS);
		clock.tick(POLL_MIN_INTERVAL_MS);
		await flushMicrotasks();

		assert.strictEqual(latestScheduledDelay(), POLL_MIN_INTERVAL_MS * POLL_BACKOFF_MULTIPLIER);
	});

	it('resets polling interval to minimum when a change is detected', async function () {
		// doPoll detects a change by comparing ReviewManager's internal _prNumber /
		// _lastCommitSha before and after updateState, so the stub must mutate one of
		// those to emulate an observable change.
		const internal = reviewManager as unknown as { _prNumber?: number };
		let pollCount = 0;
		sinon.stub(reviewManager, 'updateState').callsFake(async () => {
			pollCount++;
			if (pollCount === 2) {
				internal._prNumber = (internal._prNumber ?? 0) + 1;
			}
		});

		assert.strictEqual(latestScheduledDelay(), POLL_MIN_INTERVAL_MS);
		clock.tick(POLL_MIN_INTERVAL_MS);
		await flushMicrotasks();
		assert.strictEqual(latestScheduledDelay(), POLL_MIN_INTERVAL_MS * POLL_BACKOFF_MULTIPLIER);

		clock.tick(POLL_MIN_INTERVAL_MS * POLL_BACKOFF_MULTIPLIER);
		await flushMicrotasks();
		assert.strictEqual(latestScheduledDelay(), POLL_MIN_INTERVAL_MS);
	});

	it('applies normal backoff on focus-triggered refresh when no change is detected', async function () {
		const MAX_FOCUS_JITTER_MS = 60_000;
		sinon.stub(reviewManager, 'updateState').resolves();

		clock.tick(POLL_MIN_INTERVAL_MS);
		await flushMicrotasks();
		assert.strictEqual(latestScheduledDelay(), Math.min(POLL_MAX_INTERVAL_MS, POLL_MIN_INTERVAL_MS * POLL_BACKOFF_MULTIPLIER));

		isWindowFocused = false;
		const callsBeforeSkip = setTimeoutSpy.callCount;
		clock.tick(POLL_MIN_INTERVAL_MS * POLL_BACKOFF_MULTIPLIER);
		await flushMicrotasks();
		assert.strictEqual(setTimeoutSpy.callCount, callsBeforeSkip, 'no timer should be scheduled while unfocused after skip');

		isWindowFocused = true;
		onDidChangeWindowStateCallback!({ focused: true } as vscode.WindowState);
		await flushMicrotasks();

		// Focus schedules a jittered poll; advance past the max jitter to run it.
		clock.tick(MAX_FOCUS_JITTER_MS);
		await flushMicrotasks();

		assert.strictEqual(latestScheduledDelay(), POLL_MIN_INTERVAL_MS * POLL_BACKOFF_MULTIPLIER * POLL_BACKOFF_MULTIPLIER);
	});

	it('window focus triggers a one-off poll when there is no scheduled poll', async function () {
		assert.ok(onDidChangeWindowStateCallback, 'window state listener should be registered');

		sinon.stub(reviewManager, 'updateState').resolves();

		isWindowFocused = false;
		const callsBeforeSkip = setTimeoutSpy.callCount;
		clock.tick(POLL_MIN_INTERVAL_MS);
		await flushMicrotasks();
		assert.strictEqual(setTimeoutSpy.callCount, callsBeforeSkip, 'timer should not be rescheduled while unfocused');

		onDidChangeWindowStateCallback!({ focused: true } as vscode.WindowState);
		await flushMicrotasks();

		assert.ok(setTimeoutSpy.callCount > callsBeforeSkip, 'focus should cause one-off refresh and schedule next poll');
	});

	it('polling refreshes state when active PR exists and new PR activity is detected', async function () {
		// Stub the getter rather than assigning through the setter, which has side effects.
		sinon.stub(manager, 'activePullRequest').get(() => ({ number: 123 } as unknown as PullRequestModel));
		const updateStateStub = sinon.stub(reviewManager, 'updateState').resolves();
		sinon.stub(reviewManager as unknown as { hasNewPullRequests: () => Promise<boolean> }, 'hasNewPullRequests').resolves(true);

		clock.tick(POLL_MIN_INTERVAL_MS);
		await flushMicrotasks();

		assert.strictEqual(updateStateStub.called, true, 'poll should refresh state when active PR may be stale');
	});

	it('uses the explicitly checked out pull request for the checked out branch', async function () {
		await repository.createBranch('feature', true, 'head-sha');
		sinon.stub(manager, 'updateRepositories').resolves(true);
		const localMetadata = sinon.stub(manager, 'getMatchingPullRequestMetadataForBranch').resolves({
			owner: 'owner',
			repositoryName: 'repo',
			prNumber: 7492,
		});
		const requestedPullRequest = {
			number: 7231,
			remote: {
				owner: 'owner',
				repositoryName: 'repo',
			},
		} as PullRequestModel;
		const internal = reviewManager as unknown as {
			_switchedToPullRequest?: PullRequestModel;
			_switchedToPullRequestBranch?: string;
			validateState(silent: boolean, updateLayout: boolean): Promise<void>;
			resolvePullRequest(metadata: PullRequestMetadata, useCache: boolean): Promise<undefined>;
			checkGitHubForPrBranch(branch: Branch): Promise<unknown>;
		};
		internal._switchedToPullRequest = requestedPullRequest;
		internal._switchedToPullRequestBranch = 'feature';
		const resolvePullRequest = sinon.stub(internal, 'resolvePullRequest').resolves(undefined);
		const checkGitHubForPrBranch = sinon.stub(internal, 'checkGitHubForPrBranch').resolves(undefined);

		await internal.validateState(true, false);

		assert.strictEqual(localMetadata.called, false);
		assert.deepStrictEqual(resolvePullRequest.firstCall.args[0], {
			owner: 'owner',
			repositoryName: 'repo',
			prNumber: 7231,
		});
		assert.strictEqual(checkGitHubForPrBranch.called, false);
	});

	it('keeps an explicit pull request selected when validation overlaps its checkout', async function () {
		await repository.createBranch('feature', true, 'head-sha');
		let resolveUpdateRepositories!: (updated: boolean) => void;
		sinon.stub(manager, 'updateRepositories').returns(new Promise<boolean>(resolve => {
			resolveUpdateRepositories = resolve;
		}));
		const localMetadata = sinon.stub(manager, 'getMatchingPullRequestMetadataForBranch');
		const requestedPullRequest = {
			number: 7231,
			remote: {
				owner: 'owner',
				repositoryName: 'repo',
			},
		} as PullRequestModel;
		const internal = reviewManager as unknown as {
			_switchedToPullRequest?: PullRequestModel;
			_switchedToPullRequestBranch?: string;
			validateState(silent: boolean, updateLayout: boolean): Promise<void>;
		};

		const validation = internal.validateState(true, false);
		await flushMicrotasks();
		reviewManager.switchingToReviewMode = true;
		internal._switchedToPullRequest = requestedPullRequest;
		internal._switchedToPullRequestBranch = undefined;
		resolveUpdateRepositories(true);
		await validation;

		assert.strictEqual(internal._switchedToPullRequest, requestedPullRequest);
		assert.strictEqual(internal._switchedToPullRequestBranch, undefined);
		assert.strictEqual(localMetadata.called, false);
	});

	it('rechecks GitHub when active pull request metadata was not persisted', async function () {
		await repository.createBranch('feature', true, 'head-sha');
		sinon.stub(manager, 'updateRepositories').resolves(true);
		sinon.stub(manager, 'getMatchingPullRequestMetadataForBranch').resolves(undefined);
		sinon.stub(manager, 'activePullRequest').get(() => ({ number: 7231 } as PullRequestModel));
		const internal = reviewManager as unknown as {
			_cachedBranchName?: string;
			validateState(silent: boolean, updateLayout: boolean): Promise<void>;
			hasNewPullRequests(): Promise<boolean>;
			checkGitHubForPrBranch(branch: Branch): Promise<unknown>;
			resolvePullRequest(metadata: PullRequestMetadata, useCache: boolean): Promise<undefined>;
			clear(quitReviewMode: boolean): Promise<void>;
		};
		internal._cachedBranchName = 'feature';
		sinon.stub(internal, 'hasNewPullRequests').resolves(false);
		const pullRequestModel = {} as PullRequestModel;
		const checkGitHubForPrBranch = sinon.stub(internal, 'checkGitHubForPrBranch').resolves({
			owner: 'owner',
			repositoryName: 'repo',
			prNumber: 7231,
			model: pullRequestModel,
		});
		const resolvePullRequest = sinon.stub(internal, 'resolvePullRequest').resolves(undefined);
		const clear = sinon.stub(internal, 'clear').resolves();

		await internal.validateState(true, false);

		assert.strictEqual(checkGitHubForPrBranch.calledOnce, true);
		assert.deepStrictEqual(resolvePullRequest.firstCall.args[0], {
			owner: 'owner',
			repositoryName: 'repo',
			prNumber: 7231,
			model: pullRequestModel,
		});
		assert.strictEqual(clear.called, false);
	});

	it('keeps the active pull request when its metadata recheck fails', async function () {
		await repository.createBranch('feature', true, 'head-sha');
		sinon.stub(manager, 'updateRepositories').resolves(true);
		sinon.stub(manager, 'getMatchingPullRequestMetadataForBranch').resolves(undefined);
		sinon.stub(manager, 'activePullRequest').get(() => ({ number: 7231 } as PullRequestModel));
		const internal = reviewManager as unknown as {
			_cachedBranchName?: string;
			validateState(silent: boolean, updateLayout: boolean): Promise<void>;
			hasNewPullRequests(): Promise<boolean>;
			checkGitHubForPrBranch(branch: Branch): Promise<unknown>;
			clear(quitReviewMode: boolean): Promise<void>;
		};
		internal._cachedBranchName = 'feature';
		sinon.stub(internal, 'hasNewPullRequests').resolves(false);
		const checkGitHubForPrBranch = sinon.stub(internal, 'checkGitHubForPrBranch').resolves(undefined);
		const clear = sinon.stub(internal, 'clear').resolves();

		await internal.validateState(true, false);

		assert.strictEqual(checkGitHubForPrBranch.calledOnce, true);
		assert.strictEqual(clear.called, false);
	});

	it('caps backoff at the maximum interval', async function () {
		sinon.stub(reviewManager, 'updateState').resolves();

		clock.tick(POLL_MIN_INTERVAL_MS);
		await flushMicrotasks();
		assert.strictEqual(latestScheduledDelay(), POLL_MIN_INTERVAL_MS * 2);

		clock.tick(POLL_MIN_INTERVAL_MS * 2);
		await flushMicrotasks();
		assert.strictEqual(latestScheduledDelay(), POLL_MIN_INTERVAL_MS * 4);

		clock.tick(POLL_MIN_INTERVAL_MS * 4);
		await flushMicrotasks();
		assert.strictEqual(latestScheduledDelay(), POLL_MIN_INTERVAL_MS * 6);
	});

	it('shows a deferred pull request reveal only once', async function () {
		await context.workspaceState.update(FOCUS_REVIEW_MODE, true);
		const pullRequest = {} as PullRequestModel;
		const reviewManagerLayout = reviewManager as unknown as {
			layout(pr: PullRequestModel, updateLayout: boolean, silent: boolean): void;
			_doFocusShow(pr: PullRequestModel, updateLayout: boolean): void;
		};
		const focusShow = sinon.stub(reviewManagerLayout, '_doFocusShow');

		reviewManagerLayout.layout(pullRequest, true, true);
		showPullRequest.shouldShow = true;

		assert.strictEqual(focusShow.callCount, 1);
		assert.deepStrictEqual(focusShow.firstCall.args, [pullRequest, true]);

		reviewManagerLayout.layout(pullRequest, true, true);

		assert.strictEqual(focusShow.callCount, 1);
	});
});
