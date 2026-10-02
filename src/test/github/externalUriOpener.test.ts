/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { RemoteOnlyRepository } from '../../api/remoteOnlyRepository';
import { CredentialStore } from '../../github/credentials';
import { registerGitHubIssueOrPullRequestExternalUriOpener } from '../../github/externalUriOpener';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { FolderRepositoryManagerResolver } from '../../github/folderRepositoryManagerResolver';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
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
			folderRepositoryManagerResolver.dispose();
			repositoriesManager.dispose();
			credentialStore.dispose();
			context.dispose();
		}
	});

	describe('opening pull requests', () => {
		const uri = vscode.Uri.parse('https://github.com/aaa/bbb/pull/1000');
		let context: MockExtensionContext;
		let opener: vscode.ExternalUriOpener;
		let cancellation: vscode.CancellationTokenSource;
		let resolvePullRequest: (pr: PullRequestModel | undefined) => void;
		let rejectPullRequest: (error: Error) => void;
		let resolvePullRequestStub: SinonStub<Parameters<FolderRepositoryManager['resolvePullRequest']>, ReturnType<FolderRepositoryManager['resolvePullRequest']>>;

		beforeEach(() => {
			context = new MockExtensionContext();
			const telemetry = new MockTelemetry();
			const credentialStore = new CredentialStore(telemetry, context);
			const repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
			const resolver = new FolderRepositoryManagerResolver(context, repositoriesManager, telemetry);
			cancellation = new vscode.CancellationTokenSource();
			context.subscriptions.push(credentialStore, repositoriesManager, resolver, cancellation);
			sandbox.stub(vscode.window, 'registerExternalUriOpener').callsFake((_id, value) => {
				opener = value;
				return new vscode.Disposable(() => undefined);
			});
			context.subscriptions.push(registerGitHubIssueOrPullRequestExternalUriOpener(context, resolver, telemetry));
			sandbox.stub(opener as any, 'isOpenPullLinksEnabled').returns(true);
			const pendingPullRequest = new Promise<PullRequestModel | undefined>((resolve, reject) => {
				resolvePullRequest = resolve;
				rejectPullRequest = reject;
			});
			resolvePullRequestStub = sandbox.stub(FolderRepositoryManager.prototype, 'resolvePullRequest').returns(pendingPullRequest);
		});

		afterEach(() => {
			PullRequestOverviewPanel.findPanel('aaa', 'bbb', 1000)?.dispose();
			context.dispose();
		});

		it('creates the first tab and loads its HTML before resolving the PR', async () => {
			const createWebviewPanel = sandbox.spy(vscode.window, 'createWebviewPanel');
			const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
			const opening = opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);
			try {
				assert.strictEqual(createWebviewPanel.callCount, 1);
				assert.ok(createWebviewPanel.firstCall.returnValue.webview.html.includes('webview-pr-description.js'));
				assert.ok(PullRequestOverviewPanel.findPanel('aaa', 'bbb', 1000));
				sandbox.assert.calledOnce(resolvePullRequestStub);
				sandbox.assert.calledWithExactly(resolvePullRequestStub, 'aaa', 'bbb', 1000, true, 'overview');
			} finally {
				resolvePullRequest(undefined);
				await opening;
			}
			assert.strictEqual(showError.firstCall.args[0], 'Unable to find pull request #1000 in aaa/bbb.');
			assert.strictEqual(PullRequestOverviewPanel.findPanel('aaa', 'bbb', 1000), undefined);
		});

		it('does not create a tab for an already-cancelled request', async () => {
			const createWebviewPanel = sandbox.spy(vscode.window, 'createWebviewPanel');
			cancellation.cancel();
			await opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);

			sandbox.assert.notCalled(createWebviewPanel);
			sandbox.assert.notCalled(resolvePullRequestStub);
		});

		it('closes the new tab without an error when cancelled during resolution', async () => {
			const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
			const opening = opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);
			assert.ok(PullRequestOverviewPanel.findPanel('aaa', 'bbb', 1000));
			cancellation.cancel();
			resolvePullRequest(undefined);
			await opening;

			assert.strictEqual(PullRequestOverviewPanel.findPanel('aaa', 'bbb', 1000), undefined);
			sandbox.assert.notCalled(showError);
		});

		it('reports resolution failures and closes the new tab', async () => {
			const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
			const opening = opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);
			rejectPullRequest(new Error('PR lookup failed'));
			await opening;

			assert.strictEqual(showError.firstCall.args[0], 'PR lookup failed');
			assert.strictEqual(PullRequestOverviewPanel.findPanel('aaa', 'bbb', 1000), undefined);
		});
	});
});
