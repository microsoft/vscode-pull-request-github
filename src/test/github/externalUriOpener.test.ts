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
import { IssueOverviewPanel } from '../../github/issueOverview';
import { RepositoriesManager } from '../../github/repositoriesManager';
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
		let finishResolveIssue!: (issue: undefined) => void;
		const pendingIssue = new Promise<undefined>(resolve => finishResolveIssue = resolve);
		const resolveIssue = sandbox.stub(FolderRepositoryManager.prototype, 'resolveIssue').callsFake(function (this: FolderRepositoryManager) {
			assert.ok(this.repository instanceof RemoteOnlyRepository);
			return pendingIssue;
		});
		const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
		const createWebviewPanel = sandbox.spy(vscode.window, 'createWebviewPanel');

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
			const opening = opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);
			for (let attempt = 0; attempt < 20 && createWebviewPanel.notCalled; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}

			assert.strictEqual(createWebviewPanel.callCount, 1);
			assert.ok(createWebviewPanel.firstCall.returnValue.webview.html.includes('webview-pr-description.js'));
			assert.ok(IssueOverviewPanel.findPanel('microsoft', 'vscode', 1));
			finishResolveIssue(undefined);
			await opening;

			assert.strictEqual(repositoriesManager.folderManagers.length, 0);
			assert.strictEqual(resolveIssue.callCount, 1);
			assert.ok(openExternal.calledOnceWith(uri, { allowContributedOpeners: 'default' }));
			assert.strictEqual(IssueOverviewPanel.findPanel('microsoft', 'vscode', 1), undefined);
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

	for (const kind of ['pullRequest', 'issue'] as const) {
		describe(`opening ${kind === 'pullRequest' ? 'pull requests' : 'issues'}`, () => {
			const panel = kind === 'pullRequest' ? PullRequestOverviewPanel : IssueOverviewPanel;
			const uri = vscode.Uri.parse(`https://github.com/aaa/bbb/${kind === 'pullRequest' ? 'pull' : 'issues'}/1000`);
			let context: MockExtensionContext;
			let opener: vscode.ExternalUriOpener;
			let cancellation: vscode.CancellationTokenSource;
			let resolveModel: (model: undefined) => void;
			let rejectModel: (error: Error) => void;
			let resolveModelStub:
				| SinonStub<Parameters<FolderRepositoryManager['resolvePullRequest']>, ReturnType<FolderRepositoryManager['resolvePullRequest']>>
				| SinonStub<Parameters<FolderRepositoryManager['resolveIssue']>, ReturnType<FolderRepositoryManager['resolveIssue']>>;
			let openExternal: SinonStub<Parameters<typeof vscode.env.openExternal>, ReturnType<typeof vscode.env.openExternal>>;

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
				const pendingModel = new Promise<undefined>((resolve, reject) => {
					resolveModel = resolve;
					rejectModel = reject;
				});
				resolveModelStub = kind === 'pullRequest'
					? sandbox.stub(FolderRepositoryManager.prototype, 'resolvePullRequest').returns(pendingModel)
					: sandbox.stub(FolderRepositoryManager.prototype, 'resolveIssue').returns(pendingModel);
				openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);
			});

			afterEach(() => {
				panel.findPanel('aaa', 'bbb', 1000)?.dispose();
				context.dispose();
			});

			it('creates the first tab and loads its HTML before resolving the model', async () => {
				const createWebviewPanel = sandbox.spy(vscode.window, 'createWebviewPanel');
				const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
				const opening = opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);
				try {
					assert.strictEqual(createWebviewPanel.callCount, 1);
					assert.ok(createWebviewPanel.firstCall.returnValue.webview.html.includes('webview-pr-description.js'));
					assert.ok(panel.findPanel('aaa', 'bbb', 1000));
					sandbox.assert.calledOnce(resolveModelStub);
					assert.deepStrictEqual(resolveModelStub.firstCall.args, ['aaa', 'bbb', 1000, true, kind === 'pullRequest' ? 'overview' : true]);
				} finally {
					resolveModel(undefined);
					await opening;
				}
				sandbox.assert.calledOnce(resolveModelStub);
				sandbox.assert.calledOnce(openExternal);
				sandbox.assert.calledWithExactly(openExternal, uri, { allowContributedOpeners: 'default' });
				sandbox.assert.notCalled(showError);
				assert.strictEqual(panel.findPanel('aaa', 'bbb', 1000), undefined);
			});

			it('does not create a tab for an already-cancelled request', async () => {
				const createWebviewPanel = sandbox.spy(vscode.window, 'createWebviewPanel');
				cancellation.cancel();
				await opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);

				sandbox.assert.notCalled(createWebviewPanel);
				sandbox.assert.notCalled(resolveModelStub);
				sandbox.assert.notCalled(openExternal);
			});

			it('closes the new tab without an error when cancelled during resolution', async () => {
				const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
				const opening = opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);
				assert.ok(panel.findPanel('aaa', 'bbb', 1000));
				cancellation.cancel();
				resolveModel(undefined);
				await opening;

				assert.strictEqual(panel.findPanel('aaa', 'bbb', 1000), undefined);
				sandbox.assert.notCalled(showError);
				sandbox.assert.notCalled(openExternal);
			});

			it('reports a browser fallback failure and closes the new tab', async () => {
				openExternal.rejects(new Error('Browser unavailable'));
				const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
				const opening = opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);
				resolveModel(undefined);
				await opening;

				sandbox.assert.calledOnce(resolveModelStub);
				assert.strictEqual(showError.firstCall.args[0], 'Browser unavailable');
				assert.strictEqual(panel.findPanel('aaa', 'bbb', 1000), undefined);
			});

			it('reports resolution failures and closes the new tab', async () => {
				const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
				const opening = opener.openExternalUri(uri, { sourceUri: uri }, cancellation.token);
				rejectModel(new Error('Item lookup failed'));
				await opening;

				assert.strictEqual(showError.firstCall.args[0], 'Item lookup failed');
				assert.strictEqual(panel.findPanel('aaa', 'bbb', 1000), undefined);
			});
		});
	}
});
