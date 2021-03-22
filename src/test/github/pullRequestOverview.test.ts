import assert = require('assert');
import * as vscode from 'vscode';
import * as path from 'path';
import { SinonSandbox, createSandbox, match as sinonMatch } from 'sinon';
import { createMock } from 'ts-auto-mock';

import { FolderRepositoryManager } from '../../azdo/folderRepositoryManager';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockRepository } from '../mocks/mockRepository';
import { PullRequestOverviewPanel } from '../../azdo/pullRequestOverview';
import { PullRequestModel } from '../../azdo/pullRequestModel';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { convertAzdoPullRequestToRawPullRequest } from '../../azdo/utils';
import { createFakeSecretStorage, MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockAzdoRepository } from '../mocks/mockAzdoRepository';
import { GitApiImpl } from '../../api/api1';
import { CredentialStore } from '../../azdo/credentials';
import { GitPullRequest, GitStatusState } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { AzdoWorkItem } from '../../azdo/workItem';
import { AzdoUserManager } from '../../azdo/userManager';

const EXTENSION_PATH = path.resolve(__dirname, '../../..');

describe('PullRequestOverview', function () {
	let sinon: SinonSandbox;
	let pullRequestManager: FolderRepositoryManager;
	let context: MockExtensionContext;
	let remote: Remote;
	let repo: MockAzdoRepository;
	let telemetry: MockTelemetry;
	let workItem: AzdoWorkItem;
	let userManager: AzdoUserManager;

	beforeEach(async function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		context = new MockExtensionContext();

		const repository = new MockRepository();
		telemetry = new MockTelemetry();
		const credentialStore = new CredentialStore(telemetry, createFakeSecretStorage());
		pullRequestManager = new FolderRepositoryManager(repository, telemetry, new GitApiImpl(), credentialStore);
		workItem = new AzdoWorkItem(credentialStore, telemetry);
		userManager = new AzdoUserManager(credentialStore, telemetry);

		const url = 'https://dev.azure.com.com/aaa/bbb/_git/bbb';
		remote = new Remote('origin', url, new Protocol(url));
		repo = new MockAzdoRepository(remote, pullRequestManager.credentialStore, telemetry, sinon);
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

			const prItem = await convertAzdoPullRequestToRawPullRequest(
				createMock<GitPullRequest>({pullRequestId: 1000}),
				repo,
			);
			const prModel = new PullRequestModel(telemetry, repo, remote, prItem);

			await PullRequestOverviewPanel.createOrShow(EXTENSION_PATH, pullRequestManager, prModel, workItem, userManager);

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

			const prItem0 = await convertAzdoPullRequestToRawPullRequest(
				createMock<GitPullRequest>({pullRequestId: 1000}),
				repo,
			);
			const prModel0 = new PullRequestModel(telemetry, repo, remote, prItem0);
			const resolveStub = sinon.stub(pullRequestManager, 'resolvePullRequest').resolves(prModel0);
			// sinon.stub(prModel0, 'getReviewRequests').resolves([]);
			// sinon.stub(prModel0, 'getTimelineEvents').resolves([]);
			sinon.stub(prModel0, 'getStatusChecks').resolves({ state: GitStatusState.Pending, statuses: [] });
			await PullRequestOverviewPanel.createOrShow(EXTENSION_PATH, pullRequestManager, prModel0, workItem, userManager);

			const panel0 = PullRequestOverviewPanel.currentPanel;
			assert.notStrictEqual(panel0, undefined);
			assert.strictEqual(createWebviewPanel.callCount, 1);

			const prItem1 = await convertAzdoPullRequestToRawPullRequest(
				createMock<GitPullRequest>({pullRequestId: 2000}),
				repo,
			);
			const prModel1 = new PullRequestModel(telemetry, repo, remote, prItem1);
			resolveStub.resolves(prModel1);
			// sinon.stub(prModel1, 'getReviewRequests').resolves([]);
			// sinon.stub(prModel1, 'getTimelineEvents').resolves([]);
			sinon.stub(prModel1, 'getStatusChecks').resolves({ state: GitStatusState.Pending, statuses: [] });
			await PullRequestOverviewPanel.createOrShow(EXTENSION_PATH, pullRequestManager, prModel1, workItem, userManager);

			assert.strictEqual(panel0, PullRequestOverviewPanel.currentPanel);
			assert.strictEqual(createWebviewPanel.callCount, 1);
			assert.strictEqual(panel0!.getCurrentTitle(), 'Pull Request #2000');
		});
	});
});