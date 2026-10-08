/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonFakeTimers, SinonSandbox, SinonSpy, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { GitApiImpl } from '../../api/api1';
import { GitHubServerType } from '../../common/authentication';
import { CopilotPRStatus } from '../../common/copilot';
import Logger from '../../common/logger';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { DEV_MODE, PR_SETTINGS_NAMESPACE, QUERIES } from '../../common/settingKeys';
import { CopilotPRWatcher } from '../../github/copilotPrWatcher';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager, ItemsResponseResult } from '../../github/folderRepositoryManager';
import { GitHubRepository, PullRequestChangeEvent } from '../../github/githubRepository';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { PrsTreeModel } from '../../view/prsTreeModel';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';

describe('Copilot pull request polling', function () {
	const query = 'repo:${owner}/${repository} is:open author:copilot-swe-agent';
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;
	let reposManager: RepositoriesManager;
	let repository: MockRepository;
	let folderManager: FolderRepositoryManager;
	let model: PrsTreeModel;
	let origin: GitHubRepository;
	let pages: Map<GitHubRepository, PullRequestModel[][]>;
	let settings: Map<string, unknown>;
	let inspect: SinonStub;
	let maxKnownPR: SinonStub;
	let fetchPages: SinonStub;
	let timeline: SinonStub;
	let watcher: CopilotPRWatcher | undefined;
	let createdPullRequests: PullRequestModel[];

	async function addRemote(name: string, repo: string): Promise<GitHubRepository> {
		const url = `https://github.com/octo/${repo}.git`;
		await repository.addRemote(name, url);
		const remote = new GitHubRemote(name, url, new Protocol(url), GitHubServerType.GitHubDotCom);
		const githubRepository = new GitHubRepository(1, remote, repository.rootUri, credentialStore, telemetry, true);
		sinon.stub(githubRepository, 'getDefaultBranch').resolves('main');
		folderManager.gitHubRepositories.push(githubRepository);
		pages.set(githubRepository, [[]]);
		return githubRepository;
	}

	function pullRequest(number: number, githubRepository: GitHubRepository = origin): PullRequestModel {
		const raw = new PullRequestBuilder().number(number).user(user => user.login('copilot-swe-agent')).build();
		const pr = new PullRequestModel(credentialStore, telemetry, githubRepository, githubRepository.remote,
			convertRESTPullRequestToRawPullRequest(raw, githubRepository));
		createdPullRequests.push(pr);
		return pr;
	}

	function fetchedPages(): number[] {
		return fetchPages.getCalls().map(call => call.args[2]);
	}

	function boundedQueries(limit: number): SinonStub {
		const getPullRequests = model.getPullRequestsForQuery.bind(model);
		const queries = sinon.stub(model, 'getPullRequestsForQuery').callsFake((...args) => {
			assert.ok(queries.callCount <= limit, 'Pagination exceeded the expected number of queries');
			return getPullRequests(...args);
		});
		return queries;
	}

	beforeEach(async function () {
		sinon = createSandbox();
		watcher = undefined;
		createdPullRequests = [];
		pages = new Map();
		settings = new Map<string, unknown>([
			[QUERIES, [{ label: 'Copilot', query }]],
			[DEV_MODE, false],
		]);
		inspect = sinon.stub().returns(undefined);
		const configuration: vscode.WorkspaceConfiguration = {
			get: sinon.stub().callsFake((key: string, fallback?: unknown) => settings.has(key) ? settings.get(key) : fallback),
			has: sinon.stub().callsFake((key: string) => settings.has(key)),
			inspect,
			update: sinon.stub().rejects(new Error('Tests must not write settings')),
		};
		sinon.stub(vscode.workspace, 'getConfiguration').returns(configuration);
		MockCommandRegistry.install(sinon);
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		reposManager = new RepositoriesManager(credentialStore, telemetry);
		repository = new MockRepository();
		folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager),
			credentialStore, new CreatePullRequestHelper(), new MockThemeWatcher());
		sinon.stub(folderManager, 'getPullRequestDefaults').resolves({ owner: 'octo', repo: 'repo', base: 'main' });
		sinon.stub(folderManager, 'getActiveGitHubRemotes').callsFake(() => folderManager.gitHubRepositories.map(repo => repo.remote));
		origin = await addRemote('origin', 'repo');
		maxKnownPR = sinon.stub(origin, 'getMaxPullRequest').resolves(100);
		reposManager.insertFolderManager(folderManager);
		model = new PrsTreeModel(telemetry, reposManager, context);
		sinon.stub(PullRequestModel.prototype, 'getStatusChecks').resolves([null, null]);
		timeline = sinon.stub(PullRequestModel.prototype, 'getCopilotTimelineEvents').resolves([]);
		fetchPages = sinon.stub(folderManager, 'getPullRequestsForCategory').callsFake(async (repo, _query, page = 1) => {
			const repoPages = pages.get(repo)!;
			assert.ok(page <= repoPages.length, `Unexpected page ${page}`);
			return {
				items: repoPages[page - 1],
				hasMorePages: page < repoPages.length,
				totalCount: repoPages.reduce((total, items) => total + items.length, 0),
			};
		});
	});

	afterEach(function () {
		watcher?.dispose();
		model.dispose();
		for (const pr of createdPullRequests) {
			pr.dispose();
		}
		for (const repo of folderManager.gitHubRepositories) {
			repo.dispose();
		}
		for (const manager of [...reposManager.folderManagers]) {
			reposManager.removeRepo(manager.repository);
		}
		reposManager.dispose();
		credentialStore.dispose();
		context.dispose();
		sinon.restore();
	});

	for (const initialized of [false, true]) {
		it(`advances three pages and processes each pull request once when initialized=${initialized}`, async function () {
			const prs = [pullRequest(1), pullRequest(2), pullRequest(3)];
			pages.set(origin, prs.map(pr => [pr]));
			if (initialized) {
				model.copilotStateModel.setInitialized();
			}
			const queries = boundedQueries(3);

			assert.strictEqual(await model.refreshCopilotStateChanges(true), true);

			assert.deepStrictEqual(fetchedPages(), [1, 2, 3]);
			assert.deepStrictEqual(queries.getCalls().map(call => call.args[1]), [false, true, true]);
			assert.deepStrictEqual(timeline.getCalls().map(call => call.thisValue), prs);
			for (const call of timeline.getCalls()) {
				assert.deepStrictEqual(call.args, [false, !initialized]);
			}
			assert.strictEqual(model.copilotStateModel.isInitialized, true);
			assert.strictEqual(model.copilotStateModel.all.length, 3);
		});
	}

	it('fetches a new page after a previously complete query grows', async function () {
		const first = pullRequest(1);
		const second = pullRequest(2);
		boundedQueries(3);
		pages.set(origin, [[first]]);
		await model.refreshCopilotStateChanges(true);
		timeline.resetHistory();
		pages.set(origin, [[first], [second]]);
		maxKnownPR.resolves(101);

		assert.strictEqual(await model.refreshCopilotStateChanges(true), true);

		assert.deepStrictEqual(fetchedPages(), [1, 1, 2]);
		assert.deepStrictEqual(timeline.getCalls().map(call => call.thisValue), [first, second]);
		assert.strictEqual(model.copilotStateModel.all.length, 2);
	});

	it('continues an incomplete cached query rather than fetching its first page again', async function () {
		const first = pullRequest(1);
		const second = pullRequest(2);
		boundedQueries(3);
		pages.set(origin, [[first], [second]]);
		await model.getPullRequestsForQuery(folderManager, false, query);
		model.copilotStateModel.setInitialized();

		await model.refreshCopilotStateChanges(true);

		assert.deepStrictEqual(fetchedPages(), [1, 2]);
		assert.deepStrictEqual(timeline.getCalls().map(call => call.thisValue), [first, second]);
	});

	it('reuses a complete unchanged cache while refreshing timeline state', async function () {
		const pr = pullRequest(1);
		pages.set(origin, [[pr]]);
		await model.refreshCopilotStateChanges(true);
		timeline.resetHistory();

		await model.refreshCopilotStateChanges(true);

		assert.deepStrictEqual(fetchedPages(), [1]);
		sinon.assert.calledOnce(timeline);
	});

	it('preserves cumulative query results for sidebar callers', async function () {
		const first = pullRequest(1);
		const second = pullRequest(2);
		pages.set(origin, [[first], [second]]);

		const firstPage = await model.getPullRequestsForQuery(folderManager, false, query);
		const secondPage = await model.getPullRequestsForQuery(folderManager, true, query);
		const cached = await model.getPullRequestsForQuery(folderManager, false, query);

		assert.deepStrictEqual(firstPage.items, [first]);
		assert.deepStrictEqual(secondPage.items, [first, second]);
		assert.strictEqual(cached, secondPage);
		assert.strictEqual(firstPage.paginationProgress, 1);
		assert.strictEqual(secondPage.paginationProgress, 2);
	});

	it('advances through empty filtered pages without mistaking them for stalled pagination', async function () {
		const pr = pullRequest(1);
		pages.set(origin, [[], [], [pr]]);
		model.copilotStateModel.setInitialized();
		boundedQueries(3);

		await model.refreshCopilotStateChanges(true);

		assert.deepStrictEqual(fetchedPages(), [1, 2, 3]);
		sinon.assert.calledOnce(timeline);
		assert.strictEqual(model.copilotStateModel.all[0].item, pr);
	});

	for (const userConfiguredRemotes of [false, true]) {
		it(`drains earlier remotes when the last remote has no more pages with configuredRemotes=${userConfiguredRemotes}`, async function () {
			const upstream = await addRemote('upstream', 'other');
			const prs = [pullRequest(1), pullRequest(2), pullRequest(3, upstream)];
			pages.set(origin, [[prs[0]], [prs[1]]]);
			pages.set(upstream, [[prs[2]]]);
			if (userConfiguredRemotes) {
				inspect.returns({ globalValue: ['origin', 'upstream'] });
			}

			await model.refreshCopilotStateChanges(true);

			assert.deepStrictEqual(fetchPages.getCalls().map(call => [call.args[0].remote.remoteName, call.args[2]]),
				[['origin', 1], ['upstream', 1], ['origin', 2]]);
			assert.strictEqual(timeline.callCount, 3);
			assert.strictEqual(model.copilotStateModel.all.length, 3);
		});
	}

	it('continues to an unsearched remote when a cached first remote is terminal', async function () {
		const upstream = await addRemote('upstream', 'other');
		const first = pullRequest(1);
		const second = pullRequest(2, upstream);
		pages.set(origin, [[first]]);
		pages.set(upstream, [[second]]);
		const cached = await model.getPullRequestsForQuery(folderManager, false, query);
		assert.strictEqual(cached.hasMorePages, false);
		assert.strictEqual(cached.hasUnsearchedRepositories, true);
		model.copilotStateModel.setInitialized();

		await model.refreshCopilotStateChanges(true);

		assert.deepStrictEqual(fetchedPages(), [1, 1]);
		assert.deepStrictEqual(timeline.getCalls().map(call => call.thisValue), [first, second]);
	});

	it('processes duplicate pull requests from multiple worktrees only once', async function () {
		const pr = pullRequest(1);
		pages.set(origin, [[pr, pr]]);
		const worktree = new MockRepository();
		worktree.rootUri = vscode.Uri.file('C:\\users\\test\\worktree');
		const worktreeManager = new FolderRepositoryManager(1, context, worktree, telemetry, new GitApiImpl(reposManager),
			credentialStore, new CreatePullRequestHelper(), new MockThemeWatcher());
		sinon.stub(worktreeManager, 'getPullRequestDefaults').resolves({ owner: 'octo', repo: 'repo', base: 'main' });
		sinon.stub(worktreeManager, 'getPullRequests').resolves({
			items: [pr], hasMorePages: false, hasUnsearchedRepositories: false, paginationProgress: 1,
		});
		reposManager.insertFolderManager(worktreeManager);

		await model.refreshCopilotStateChanges(true);

		sinon.assert.calledOnce(timeline);
		assert.strictEqual(model.copilotStateModel.all.length, 1);
	});

	for (const progress of [undefined, 1]) {
		it(`rejects non-advancing results without changing existing state when progress=${progress}`, async function () {
			const pr = pullRequest(1);
			model.copilotStateModel.set([{ item: pr, status: CopilotPRStatus.Started }]);
			model.copilotStateModel.setInitialized();
			const response: ItemsResponseResult<PullRequestModel> = {
				items: [pr], hasMorePages: true, hasUnsearchedRepositories: false, paginationProgress: progress,
			};
			const queries = sinon.stub(model, 'getPullRequestsForQuery').callsFake(async () => {
				assert.ok(queries.callCount <= 2, 'Pagination must stop after detecting stalled progress');
				return progress === undefined ? response : { ...response };
			});

			await assert.rejects(model.refreshCopilotStateChanges(true), /pagination did not advance/);

			sinon.assert.calledTwice(queries);
			sinon.assert.notCalled(timeline);
			assert.strictEqual(model.copilotStateModel.get('octo', 'repo', 1), CopilotPRStatus.Started);
			queries.restore();
			pages.set(origin, [[pr]]);
			assert.strictEqual(await model.refreshCopilotStateChanges(true), true);
		});
	}

	it('restores reached pages after a failed request instead of skipping the failed page on retry', async function () {
		const prs = [pullRequest(1), pullRequest(2), pullRequest(3)];
		pages.set(origin, prs.map(pr => [pr]));
		boundedQueries(4);
		model.copilotStateModel.set([{ item: prs[2], status: CopilotPRStatus.Started }]);
		model.copilotStateModel.setInitialized();
		const error = new Error('Temporary request failure');
		fetchPages.onSecondCall().rejects(error);

		await assert.rejects(model.refreshCopilotStateChanges(true), error);
		sinon.assert.notCalled(timeline);
		assert.strictEqual(model.copilotStateModel.get('octo', 'repo', 3), CopilotPRStatus.Started);

		assert.strictEqual(await model.refreshCopilotStateChanges(true), true);
		assert.deepStrictEqual(fetchedPages(), [1, 2, 1, 2, 3]);
		assert.deepStrictEqual(timeline.getCalls().map(call => call.thisValue), prs);
	});

	describe('watcher recovery', function () {
		let clock: SinonFakeTimers;
		let focusedWindow: boolean;
		let setTimeoutSpy: SinonSpy;

		async function advanceClock(milliseconds: number = 0): Promise<void> {
			clock.tick(milliseconds);
			await new Promise<void>(resolve => setImmediate(resolve));
		}

		function scheduledPolls(): number {
			return setTimeoutSpy.getCalls().filter(call => call.args[1] >= 2 * 60 * 1000).length;
		}

		beforeEach(function () {
			clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
			setTimeoutSpy = sinon.spy(global, 'setTimeout');
			focusedWindow = true;
			sinon.stub(vscode.window, 'state').get(() => ({ active: focusedWindow, focused: focusedWindow }));
		});

		for (const focused of [false, true]) {
			it(`logs failures and retries at the normal interval when focused=${focused}`, async function () {
				focusedWindow = focused;
				const error = new Error('Temporary polling failure');
				const refresh = sinon.stub(model, 'refreshCopilotStateChanges').resolves(true);
				refresh.onFirstCall().rejects(error);
				const log = sinon.stub(Logger, 'error');
				watcher = new CopilotPRWatcher(reposManager, model);

				await advanceClock();
				sinon.assert.calledOnce(refresh);
				sinon.assert.calledWithExactly(log, 'Refreshing Copilot pull request state failed: Temporary polling failure', 'CopilotPRWatcher');
				assert.strictEqual(scheduledPolls(), 1);

				await advanceClock((focused ? 2 : 5) * 60 * 1000);
				sinon.assert.calledTwice(refresh);
				assert.strictEqual(scheduledPolls(), 2);
			});
		}

		it('does not schedule more polling when refresh returns false', async function () {
			const refresh = sinon.stub(model, 'refreshCopilotStateChanges').resolves(false);
			watcher = new CopilotPRWatcher(reposManager, model);

			await advanceClock();

			sinon.assert.calledOnce(refresh);
			assert.strictEqual(scheduledPolls(), 0);
		});

		it('does not start polling in development mode', async function () {
			settings.set(DEV_MODE, true);
			const refresh = sinon.stub(model, 'refreshCopilotStateChanges');
			watcher = new CopilotPRWatcher(reposManager, model);

			await advanceClock();

			sinon.assert.notCalled(refresh);
			assert.strictEqual(scheduledPolls(), 0);
		});

		it('does not restart polling after disposal while a refresh is pending', async function () {
			let resolve: (value: boolean) => void;
			const pending = new Promise<boolean>(r => resolve = r);
			sinon.stub(model, 'refreshCopilotStateChanges').returns(pending);
			watcher = new CopilotPRWatcher(reposManager, model);
			watcher.dispose();
			resolve!(true);

			await advanceClock();

			assert.strictEqual(scheduledPolls(), 0);
		});

		it('cancels a scheduled polling timer on disposal', async function () {
			const refresh = sinon.stub(model, 'refreshCopilotStateChanges').resolves(true);
			watcher = new CopilotPRWatcher(reposManager, model);
			await advanceClock();
			watcher.dispose();

			await advanceClock(5 * 60 * 1000);

			sinon.assert.calledOnce(refresh);
			assert.strictEqual(scheduledPolls(), 1);
		});

		it('schedules only one timer when concurrent polls share a pending refresh', async function () {
			const configurationChanges = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
			context.subscriptions.push(configurationChanges);
			sinon.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake(configurationChanges.event);
			let resolve: (value: boolean) => void;
			const pending = new Promise<boolean>(r => resolve = r);
			const refresh = sinon.stub(model, 'refreshCopilotStateChanges').returns(pending);
			watcher = new CopilotPRWatcher(reposManager, model);
			configurationChanges.fire({ affectsConfiguration: key => key === `${PR_SETTINGS_NAMESPACE}.${QUERIES}` });
			configurationChanges.fire({ affectsConfiguration: key => key === `${PR_SETTINGS_NAMESPACE}.${QUERIES}` });
			resolve!(true);

			await advanceClock();

			sinon.assert.calledThrice(refresh);
			assert.strictEqual(scheduledPolls(), 1);
		});

		it('logs failures from debounced refreshes without losing the polling timer', async function () {
			const changes = new vscode.EventEmitter<PullRequestChangeEvent[]>();
			context.subscriptions.push(changes);
			sinon.stub(reposManager, 'onDidChangeAnyPullRequests').callsFake(changes.event);
			const refresh = sinon.stub(model, 'refreshCopilotStateChanges').resolves(true);
			refresh.onSecondCall().rejects(new Error('Debounced refresh failed'));
			const log = sinon.stub(Logger, 'error');
			model.copilotStateModel.setInitialized();
			watcher = new CopilotPRWatcher(reposManager, model);
			await advanceClock();
			changes.fire([{ model: pullRequest(1), event: {} }]);

			await advanceClock(50);

			sinon.assert.calledTwice(refresh);
			sinon.assert.calledWithExactly(log, 'Refreshing Copilot pull request state failed: Debounced refresh failed', 'CopilotPRWatcher');
			assert.strictEqual(scheduledPolls(), 1);
		});
	});
});
