import assert = require('assert');
import * as vscode from 'vscode';
import * as path from 'path';
import { SinonSandbox, createSandbox, match as sinonMatch } from 'sinon';

import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockRepository } from '../mocks/mockRepository';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { PullRequestModel } from '../../github/pullRequestModel';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { GitApiImpl } from '../../api/api1';
import { CredentialStore } from '../../github/credentials';

const EXTENSION_PATH = path.resolve(__dirname, '../../..');

describe('PullRequestOverview', function () {
	let sinon: SinonSandbox;
	let pullRequestManager: FolderRepositoryManager;
	let context: MockExtensionContext;
	let remote: Remote;
	let repo: MockGitHubRepository;
	let telemetry: MockTelemetry;

	beforeEach(async function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		context = new MockExtensionContext();

		const repository = new MockRepository();
		telemetry = new MockTelemetry();
		const credentialStore = new CredentialStore(telemetry);
		pullRequestManager = new FolderRepositoryManager(repository, telemetry, new GitApiImpl(), credentialStore);

		const url = 'https://github.com/aaa/bbb';
		remote = new Remote('origin', url, new Protocol(url));
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

			repo.addGraphQLPullRequest((builder) => {
				builder.pullRequest(response => {
					response.repository(r => {
						r.pullRequest(pr => pr.number(1000));
					});
				});
			});

			const prItem = convertRESTPullRequestToRawPullRequest(
				new PullRequestBuilder().number(1000).build(),
				repo,
			);
			const prModel = new PullRequestModel(telemetry, repo, remote, prItem);

			await PullRequestOverviewPanel.createOrShow(EXTENSION_PATH, pullRequestManager, prModel);

			assert(createWebviewPanel.calledWith(
				sinonMatch.string,
				'Pull Request #1000',
				vscode.ViewColumn.One,
				{
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [vscode.Uri.file(path.resolve(EXTENSION_PATH, 'media'))]
				}
			));
			assert.notStrictEqual(PullRequestOverviewPanel.currentPanel, undefined);
		});

		it('reveals and updates an existing panel', async function () {
			const createWebviewPanel = sinon.spy(vscode.window, 'createWebviewPanel');

			repo.addGraphQLPullRequest((builder) => {
				builder.pullRequest(response => {
					response.repository(r => {
						r.pullRequest(pr => pr.number(1000));
					});
				});
			});
			repo.addGraphQLPullRequest((builder) => {
				builder.pullRequest(response => {
					response.repository(r => {
						r.pullRequest(pr => pr.number(2000));
					});
				});
			});

			const prItem0 = convertRESTPullRequestToRawPullRequest(
				new PullRequestBuilder().number(1000).build(),
				repo,
			);
			const prModel0 = new PullRequestModel(telemetry, repo, remote, prItem0);
			const resolveStub = sinon.stub(pullRequestManager, 'resolvePullRequest').resolves(prModel0);
			sinon.stub(prModel0, 'getReviewRequests').resolves([]);
			sinon.stub(prModel0, 'getTimelineEvents').resolves([]);
			sinon.stub(prModel0, 'getStatusChecks').resolves({ state: 'pending', statuses: [] });
			await PullRequestOverviewPanel.createOrShow(EXTENSION_PATH, pullRequestManager, prModel0);

			const panel0 = PullRequestOverviewPanel.currentPanel;
			assert.notStrictEqual(panel0, undefined);
			assert.strictEqual(createWebviewPanel.callCount, 1);

			const prItem1 = convertRESTPullRequestToRawPullRequest(
				new PullRequestBuilder().number(2000).build(),
				repo,
			);
			const prModel1 = new PullRequestModel(telemetry, repo, remote, prItem1);
			resolveStub.resolves(prModel1);
			sinon.stub(prModel1, 'getReviewRequests').resolves([]);
			sinon.stub(prModel1, 'getTimelineEvents').resolves([]);
			sinon.stub(prModel1, 'getStatusChecks').resolves({ state: 'pending', statuses: [] });
			await PullRequestOverviewPanel.createOrShow(EXTENSION_PATH, pullRequestManager, prModel1);

			assert.strictEqual(panel0, PullRequestOverviewPanel.currentPanel);
			assert.strictEqual(createWebviewPanel.callCount, 1);
			assert.strictEqual(panel0!.getCurrentTitle(), 'Pull Request #2000');
		});
	});
});