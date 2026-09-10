/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManagerResolver } from '../../github/folderRepositoryManagerResolver';
import { OverviewRestorer } from '../../github/overviewRestorer';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { PullRequest } from '../../github/views';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('OverviewRestorer', function () {
	let context: MockExtensionContext;
	let credentialStore: CredentialStore;
	let folderRepositoryManagerResolver: FolderRepositoryManagerResolver;
	let repositoriesManager: RepositoriesManager;
	let restorer: OverviewRestorer;
	let sandbox: SinonSandbox;
	let telemetry: MockTelemetry;

	beforeEach(function () {
		sandbox = createSandbox();
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		folderRepositoryManagerResolver = new FolderRepositoryManagerResolver(context, repositoriesManager, telemetry);
		sandbox.stub(vscode.window, 'registerWebviewPanelSerializer').returns({ dispose() { } });
		sandbox.stub(vscode.window, 'registerExternalUriOpener').returns({ dispose() { } });
		sandbox.stub(credentialStore, 'isAnyAuthenticated').returns(true);
		restorer = new OverviewRestorer(telemetry, context, credentialStore, folderRepositoryManagerResolver);
	});

	afterEach(function () {
		restorer.dispose();
		folderRepositoryManagerResolver.dispose();
		repositoriesManager.dispose();
		credentialStore.dispose();
		context.dispose();
		sandbox.restore();
	});

	it('restores a pull request with a remote-only manager', async function () {
		const folderManager = folderRepositoryManagerResolver.getManagerForRepository('microsoft', 'vscode-pull-request-github');
		const pullRequest = {} as PullRequestModel;
		sandbox.stub(folderManager, 'resolvePullRequest').resolves(pullRequest);
		const createOrShow = sandbox.stub(PullRequestOverviewPanel, 'createOrShow').resolves();
		const webviewPanel = { dispose: sandbox.spy() } as unknown as vscode.WebviewPanel;
		const state = {
			owner: 'microsoft',
			repo: 'vscode-pull-request-github',
			number: 8904,
			isIssue: false,
		} as PullRequest;

		await restorer.deserializeWebviewPanel(webviewPanel, state);

		assert.strictEqual(createOrShow.callCount, 1);
		assert.strictEqual(createOrShow.firstCall.args[2], folderManager);
		assert.strictEqual(createOrShow.firstCall.args[4], pullRequest);
		assert.strictEqual(createOrShow.firstCall.args[7], webviewPanel);
	});
});
