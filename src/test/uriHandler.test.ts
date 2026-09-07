/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { GitApiImpl } from '../api/api1';
import { RemoteOnlyRepository } from '../api/remoteOnlyRepository';
import { CredentialStore } from '../github/credentials';
import { FolderRepositoryManagerResolver } from '../github/folderRepositoryManagerResolver';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { RepositoriesManager } from '../github/repositoriesManager';
import { UriHandler } from '../uriHandler';
import { ReviewsManager } from '../view/reviewsManager';
import { MockExtensionContext } from './mocks/mockExtensionContext';
import { MockTelemetry } from './mocks/mockTelemetry';

describe('UriHandler', function () {
	let context: MockExtensionContext;
	let credentialStore: CredentialStore;
	let folderRepositoryManagerResolver: FolderRepositoryManagerResolver;
	let git: GitApiImpl;
	let repositoriesManager: RepositoriesManager;
	let sandbox: SinonSandbox;
	let telemetry: MockTelemetry;

	beforeEach(function () {
		sandbox = createSandbox();
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		git = new GitApiImpl(repositoriesManager);
		folderRepositoryManagerResolver = new FolderRepositoryManagerResolver(context, repositoriesManager, telemetry);
	});

	afterEach(function () {
		folderRepositoryManagerResolver.dispose();
		git.dispose();
		repositoriesManager.dispose();
		credentialStore.dispose();
		context.dispose();
		sandbox.restore();
	});

	it('opens a pull request with a remote-only manager when no workspace is open', async function () {
		const createOrShow = sandbox.stub(PullRequestOverviewPanel, 'createOrShow').resolves();
		const handler = new UriHandler(
			repositoriesManager,
			{} as ReviewsManager,
			telemetry,
			context,
			git,
			folderRepositoryManagerResolver,
		);
		const uri = vscode.Uri.parse('vscode://github.vscode-pull-request-github/open-pull-request-webview?uri=https://github.com/microsoft/vscode/pull/1');

		await handler.handleUri(uri);

		assert.strictEqual(createOrShow.callCount, 1);
		assert.ok(createOrShow.firstCall.args[2].repository instanceof RemoteOnlyRepository);
		assert.strictEqual(repositoriesManager.folderManagers.length, 0);
	});
});
