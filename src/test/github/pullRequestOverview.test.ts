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
import { CheckState } from '../../github/interface';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { RepositoriesManager } from '../../github/repositoriesManager';

const EXTENSION_URI = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '../../..');

describe('PullRequestOverview', function () {
	let sinon: SinonSandbox;
	let pullRequestManager: FolderRepositoryManager;
	let context: MockExtensionContext;
	let remote: GitHubRemote;
	let repo: MockGitHubRepository;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;

	beforeEach(async function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		context = new MockExtensionContext();

		const repository = new MockRepository();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		const createPrHelper = new CreatePullRequestHelper();
		const repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		pullRequestManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(repositoriesManager), credentialStore, createPrHelper);

		const url = 'https://github.com/aaa/bbb';
		remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		repo = new MockGitHubRepository(remote, pullRequestManager.credentialStore, telemetry, sinon);
	});

	afterEach(function () {
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.currentPanel.dispose();
		}

		pullRequestManager.dispose();
		context.dispose();
		sinon.restore();
	});

	describe('createOrShow', function () {
		it('creates a new panel', async function () {
			assert.strictEqual(PullRequestOverviewPanel.currentPanel, undefined);
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

			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, prModel);

			assert(
				createWebviewPanel.calledWith(sinonMatch.string, 'Pull Request #1000', vscode.ViewColumn.One, {
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [vscode.Uri.joinPath(EXTENSION_URI, 'dist')],
					enableFindWidget: true
				}),
			);
			assert.notStrictEqual(PullRequestOverviewPanel.currentPanel, undefined);
		});

		it('reveals and updates an existing panel', async function () {
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
			const resolveStub = sinon.stub(pullRequestManager, 'resolvePullRequest').resolves(prModel0);
			sinon.stub(prModel0, 'getReviewRequests').resolves([]);
			sinon.stub(prModel0, 'getTimelineEvents').resolves([]);
			sinon.stub(prModel0, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, prModel0);

			const panel0 = PullRequestOverviewPanel.currentPanel;
			assert.notStrictEqual(panel0, undefined);
			assert.strictEqual(createWebviewPanel.callCount, 1);
			assert.strictEqual(panel0!.getCurrentTitle(), 'Pull Request #1000');

			const prItem1 = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(2000).build(), repo);
			const prModel1 = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem1);
			resolveStub.resolves(prModel1);
			sinon.stub(prModel1, 'getReviewRequests').resolves([]);
			sinon.stub(prModel1, 'getTimelineEvents').resolves([]);
			sinon.stub(prModel1, 'getStatusChecks').resolves([{ state: CheckState.Success, statuses: [] }, null]);
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, prModel1);

			assert.strictEqual(panel0, PullRequestOverviewPanel.currentPanel);
			assert.strictEqual(createWebviewPanel.callCount, 1);
			assert.strictEqual(panel0!.getCurrentTitle(), 'Pull Request #2000');
		});
	});

	describe('PR overview sync', function () {
		it('emits event when PR overview becomes active', async function () {
			// Set up PR model
			repo.addGraphQLPullRequest(builder => {
				builder.pullRequest(response => {
					response.repository(r => {
						r.pullRequest(pr => pr.number(1000));
					});
				});
			});

			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo);
			const prModel = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem);

			// Listen for the event
			let eventFired = false;
			let eventPR: PullRequestModel | undefined;
			const disposable = PullRequestOverviewPanel.onVisible(pr => {
				eventFired = true;
				eventPR = pr;
			});

			try {
				// Create and show the panel - this should trigger the event
				await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, prModel);

				// Verify event was fired with correct PR
				assert.strictEqual(eventFired, true, 'Event should have been fired when PR overview became active');
				assert.strictEqual(eventPR?.number, 1000, 'Event should contain the correct PR model');
			} finally {
				disposable.dispose();
			}
		});

		it('emits event when panel visibility changes', async function () {
			// Set up PR model
			repo.addGraphQLPullRequest(builder => {
				builder.pullRequest(response => {
					response.repository(r => {
						r.pullRequest(pr => pr.number(2000));
					});
				});
			});

			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(2000).build(), repo);
			const prModel = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem);

			// Create panel first
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, prModel);
			const panel = PullRequestOverviewPanel.currentPanel;
			assert.notStrictEqual(panel, undefined);

			// Listen for the event
			let eventCount = 0;
			let lastEventPR: PullRequestModel | undefined;
			const disposable = PullRequestOverviewPanel.onVisible(pr => {
				eventCount++;
				lastEventPR = pr;
			});

			try {
				// Reset event count to track only visibility changes
				eventCount = 0;

				// Simulate panel becoming visible - this should trigger the event
				// We simulate this by calling the method directly since testing webview visibility is complex
				(panel as any).onDidChangeViewState({ webviewPanel: { visible: true } });

				// Verify event was fired
				assert.strictEqual(eventCount, 1, 'Event should have been fired when panel became visible');
				assert.strictEqual(lastEventPR?.number, 2000, 'Event should contain the correct PR model');
			} finally {
				disposable.dispose();
			}
		});

		it('getCurrentPullRequest should return the current PR when panel exists', async function () {
			// Initially no current panel
			assert.strictEqual(PullRequestOverviewPanel.getCurrentPullRequest(), undefined, 'Should return undefined when no panel exists');

			// Create a PR
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(3000).title('Test getCurrentPullRequest').build(), repo);
			const prModel = new PullRequestModel(credentialStore, telemetry, repo, remote, prItem);

			// Create and show the panel
			await PullRequestOverviewPanel.createOrShow(telemetry, EXTENSION_URI, pullRequestManager, prModel);

			// Should now return the current PR
			const currentPR = PullRequestOverviewPanel.getCurrentPullRequest();
			assert.notStrictEqual(currentPR, undefined, 'Should return the current PR when panel exists');
			assert.strictEqual(currentPR?.number, 3000, 'Should return the correct PR model');
			assert.strictEqual(currentPR?.title, 'Test getCurrentPullRequest', 'Should return the correct PR model');
		});
	});
});
