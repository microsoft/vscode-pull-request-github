/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { RemoteOnlyRepository } from '../../api/remoteOnlyRepository';
import { OPEN_PULL_LINKS, PR_SETTINGS_NAMESPACE } from '../../common/settingKeys';
import { CredentialStore } from '../../github/credentials';
import { registerGitHubIssueOrPullRequestExternalUriOpener } from '../../github/externalUriOpener';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { FolderRepositoryManagerResolver } from '../../github/folderRepositoryManagerResolver';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('GitHubIssueOrPullRequestExternalUriOpener', () => {
	let sandbox: SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		sandbox.restore();
	});

	it('opens an unresolved issue with the default external opener', async () => {
		const context = new MockExtensionContext();
		const telemetry = new MockTelemetry();
		const credentialStore = new CredentialStore(telemetry, context);
		const repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		const folderRepositoryManagerResolver = new FolderRepositoryManagerResolver(context, repositoriesManager, telemetry);
		const configuration = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE);
		const previousSettingValue = configuration.inspect<boolean>(OPEN_PULL_LINKS)?.globalValue;
		let opener: vscode.ExternalUriOpener | undefined;
		let registration: vscode.Disposable | undefined;
		let cancellation: vscode.CancellationTokenSource | undefined;
		sandbox.stub(vscode.window, 'registerExternalUriOpener').callsFake((_id, value) => {
			opener = value;
			return new vscode.Disposable(() => undefined);
		});
		const resolveIssue = sandbox.stub(FolderRepositoryManager.prototype, 'resolveIssue').callsFake(async function (this: FolderRepositoryManager) {
			assert.ok(this.repository instanceof RemoteOnlyRepository);
			return undefined;
		});
		const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);

		try {
			await configuration.update(OPEN_PULL_LINKS, true, vscode.ConfigurationTarget.Global);
			registration = registerGitHubIssueOrPullRequestExternalUriOpener(
				context,
				folderRepositoryManagerResolver,
				telemetry,
			);
			const uri = vscode.Uri.parse('https://github.com/microsoft/vscode/issues/1');
			assert.ok(opener);
			cancellation = new vscode.CancellationTokenSource();
			await opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);

			assert.strictEqual(repositoriesManager.folderManagers.length, 0);
			assert.strictEqual(resolveIssue.callCount, 1);
			assert.ok(openExternal.calledOnceWith(uri, { allowContributedOpeners: 'default' }));
		} finally {
			cancellation?.dispose();
			registration?.dispose();
			folderRepositoryManagerResolver.dispose();
			repositoriesManager.dispose();
			credentialStore.dispose();
			context.dispose();
		}
	});

	it('opens an unresolved pull request with the default external opener', async () => {
		const context = new MockExtensionContext();
		const telemetry = new MockTelemetry();
		const credentialStore = new CredentialStore(telemetry, context);
		const repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		const folderRepositoryManagerResolver = new FolderRepositoryManagerResolver(context, repositoriesManager, telemetry);
		let opener: vscode.ExternalUriOpener | undefined;
		let registration: vscode.Disposable | undefined;
		let cancellation: vscode.CancellationTokenSource | undefined;
		sandbox.stub(vscode.window, 'registerExternalUriOpener').callsFake((_id, value) => {
			opener = value;
			return new vscode.Disposable(() => undefined);
		});
		const resolvePullRequest = sandbox.stub(FolderRepositoryManager.prototype, 'resolvePullRequest').callsFake(async function (this: FolderRepositoryManager) {
			assert.ok(this.repository instanceof RemoteOnlyRepository);
			return undefined;
		});
		const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);

		try {
			registration = registerGitHubIssueOrPullRequestExternalUriOpener(
				context,
				folderRepositoryManagerResolver,
				telemetry,
			);
			const uri = vscode.Uri.parse('https://github.com/microsoft/vscode/pull/1');
			assert.ok(opener);
			sandbox.stub(opener as any, 'isOpenPullLinksEnabled').returns(true);
			cancellation = new vscode.CancellationTokenSource();
			await opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);

			assert.strictEqual(repositoriesManager.folderManagers.length, 0);
			assert.strictEqual(resolvePullRequest.callCount, 1);
			assert.ok(openExternal.calledOnceWith(uri, { allowContributedOpeners: 'default' }));
		} finally {
			cancellation?.dispose();
			registration?.dispose();
			await configuration.update(OPEN_PULL_LINKS, previousSettingValue, vscode.ConfigurationTarget.Global);
			folderRepositoryManagerResolver.dispose();
			repositoriesManager.dispose();
			credentialStore.dispose();
			context.dispose();
		}
	});
});
