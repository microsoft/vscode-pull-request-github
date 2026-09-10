/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { RemoteOnlyRepository } from '../../api/remoteOnlyRepository';
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

	it('creates a remote-only folder manager when no local manager is available', async () => {
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
		const resolveIssue = sandbox.stub(FolderRepositoryManager.prototype, 'resolveIssue').callsFake(async function (this: FolderRepositoryManager) {
			assert.ok(this.repository instanceof RemoteOnlyRepository);
			return undefined;
		});
		sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);

		try {
			registration = registerGitHubIssueOrPullRequestExternalUriOpener(
				context,
				folderRepositoryManagerResolver,
				telemetry,
			);
			const uri = vscode.Uri.parse('https://github.com/microsoft/vscode/issues/1');
			assert.ok(opener);
			sandbox.stub(opener as any, 'isOpenPullLinksEnabled').returns(true);
			cancellation = new vscode.CancellationTokenSource();
			await opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);

			assert.strictEqual(repositoriesManager.folderManagers.length, 0);
			assert.strictEqual(resolveIssue.callCount, 1);
		} finally {
			cancellation?.dispose();
			registration?.dispose();
			folderRepositoryManagerResolver.dispose();
			repositoriesManager.dispose();
			credentialStore.dispose();
			context.dispose();
		}
	});
});
