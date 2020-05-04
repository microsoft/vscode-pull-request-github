import assert = require('assert');
import * as vscode from 'vscode';
import * as path from 'path';
import { SinonSandbox, createSandbox, match as sinonMatch } from 'sinon';

import { PullRequestManager } from '../../github/pullRequestManager';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockRepository } from '../mocks/mockRepository';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { PullRequestModel } from '../../github/pullRequestModel';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { DescriptionNode } from '../../view/treeNodes/descriptionNode';
import { TreeNode } from '../../view/treeNodes/treeNode';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { ApiImpl } from '../../api/api1';
import { CredentialStore } from '../../github/credentials';

const EXTENSION_PATH = path.resolve(__dirname, '../../..');

describe('PullRequestOverview', function() {
	let sinon: SinonSandbox;
	let pullRequestManager: PullRequestManager;
	let context: MockExtensionContext;
	let remote: Remote;
	let repo: MockGitHubRepository;

	beforeEach(async function() {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		context = new MockExtensionContext();

		const repository = new MockRepository();
		const telemetry = new MockTelemetry();
		const credentialStore = new CredentialStore(telemetry);
		pullRequestManager = new PullRequestManager(repository, telemetry, new ApiImpl(), credentialStore);

		const url = 'https://github.com/aaa/bbb';
		remote = new Remote('origin', url, new Protocol(url));
		repo = new MockGitHubRepository(remote, pullRequestManager.credentialStore, sinon);
	});

	afterEach(function() {
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.currentPanel.dispose();
		}

		pullRequestManager.dispose();
		context.dispose();
		sinon.restore();
	});

	describe('createOrShow', function() {
		it('creates a new panel', async function() {
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
			const prModel = new PullRequestModel(repo, remote, prItem);

			const descriptionNode = new DescriptionNode(
				new OrphanedTreeNode(),
				'label',
				'https://avatars3.githubusercontent.com/u/17565?v=4',
				prModel,
			);

			await PullRequestOverviewPanel.createOrShow(EXTENSION_PATH, pullRequestManager, prModel, descriptionNode);

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

		it('reveals and updates an existing panel', async function() {
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
			const prModel0 = new PullRequestModel(repo, remote, prItem0);
			const descriptionNode0 = new DescriptionNode(
				new OrphanedTreeNode(),
				'label',
				'https://avatars3.githubusercontent.com/u/17565?v=4',
				prModel0,
			);
			const resolveStub = sinon.stub(pullRequestManager, 'resolvePullRequest').resolves(prModel0);
			sinon.stub(pullRequestManager, 'getReviewRequests').resolves([]);
			await PullRequestOverviewPanel.createOrShow(EXTENSION_PATH, pullRequestManager, prModel0, descriptionNode0);

			const panel0 = PullRequestOverviewPanel.currentPanel;
			assert.notStrictEqual(panel0, undefined);
			assert.strictEqual(createWebviewPanel.callCount, 1);

			const prItem1 = convertRESTPullRequestToRawPullRequest(
				new PullRequestBuilder().number(2000).build(),
				repo,
			);
			const prModel1 = new PullRequestModel(repo, remote, prItem1);
			const descriptionNode1 = new DescriptionNode(
				new OrphanedTreeNode(),
				'label',
				'https://avatars3.githubusercontent.com/u/17565?v=4',
				prModel1,
			);
			resolveStub.resolves(prModel1);
			await PullRequestOverviewPanel.createOrShow(EXTENSION_PATH, pullRequestManager, prModel1, descriptionNode1);

			assert.strictEqual(panel0, PullRequestOverviewPanel.currentPanel);
			assert.strictEqual(createWebviewPanel.callCount, 1);
			assert.strictEqual(panel0!.getCurrentTitle(), 'Pull Request #2000');
		});
	});
});

class OrphanedTreeNode extends TreeNode {
	getTreeItem(): vscode.TreeItem {
		throw new Error('Attempt to get tree item from orphaned node');
	}
}