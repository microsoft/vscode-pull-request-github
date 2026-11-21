/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { RemoteOnlyRepository } from '../../../api/remoteOnlyRepository';
import { GitHubServerType } from '../../../common/authentication';
import { Protocol } from '../../../common/protocol';
import { GitHubRemote } from '../../../common/remote';
import { EXTENSION_ID } from '../../../constants';
import { CredentialStore } from '../../../github/credentials';
import { FolderRepositoryManager } from '../../../github/folderRepositoryManager';
import { FolderRepositoryManagerResolver } from '../../../github/folderRepositoryManagerResolver';
import { GitHubRepository } from '../../../github/githubRepository';
import { PullRequestModel } from '../../../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../../../github/pullRequestOverview';
import { RepositoriesManager } from '../../../github/repositoriesManager';
import { convertRESTPullRequestToRawPullRequest } from '../../../github/utils';
import { OpenPullRequestWebviewTool } from '../../../lm/tools/openPullRequestWebviewTool';
import { PullRequestBuilder } from '../../builders/rest/pullRequestBuilder';
import { MockExtensionContext } from '../../mocks/mockExtensionContext';
import { MockTelemetry } from '../../mocks/mockTelemetry';

const EXTENSION_URI = vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri;

describe('OpenPullRequestWebviewTool', () => {
	let sandbox: SinonSandbox;
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;
	let tool: OpenPullRequestWebviewTool;
	let cancellation: vscode.CancellationTokenSource;

	beforeEach(() => {
		sandbox = createSandbox();
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		sandbox.stub(credentialStore, 'isAnyAuthenticated').returns(true);
		// No repository is open, as can be the case in the Agents window.
		const repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		const resolver = new FolderRepositoryManagerResolver(context, repositoriesManager, telemetry);
		cancellation = new vscode.CancellationTokenSource();
		context.subscriptions.push(credentialStore, repositoriesManager, resolver, cancellation);
		tool = new OpenPullRequestWebviewTool(credentialStore, repositoriesManager, resolver, telemetry, EXTENSION_URI);
	});

	afterEach(() => {
		PullRequestOverviewPanel.findPanel('aaa', 'bbb', 1000)?.dispose();
		context.dispose();
		sandbox.restore();
	});

	function invoke(): Promise<vscode.LanguageModelToolResult> {
		return tool.invoke({ input: { pullRequestNumber: 1000, repo: { owner: 'aaa', name: 'bbb' } }, toolInvocationToken: undefined }, cancellation.token);
	}

	it('opens a pull request of a repository that is not open', async () => {
		const url = 'https://github.com/aaa/bbb';
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		const githubRepository = new GitHubRepository(1, remote, vscode.Uri.file('/aaa/bbb'), credentialStore, telemetry, true);
		const item = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), githubRepository);
		const pullRequest = new PullRequestModel(credentialStore, telemetry, githubRepository, remote, item);
		context.subscriptions.push(githubRepository, pullRequest);
		const resolvePullRequest = sandbox.stub(FolderRepositoryManager.prototype, 'resolvePullRequest').resolves(pullRequest);
		const createOrShow = sandbox.stub(PullRequestOverviewPanel, 'createOrShow').callsFake(async (_telemetry, _extensionUri, _folderManager, _identity, model) => {
			await model;
		});

		const result = await invoke();

		sandbox.assert.calledOnce(createOrShow);
		const [, extensionUri, folderManager, identity, model] = createOrShow.firstCall.args;
		assert.strictEqual(extensionUri, EXTENSION_URI);
		assert.ok(folderManager.repository instanceof RemoteOnlyRepository);
		assert.deepStrictEqual(identity, { owner: 'aaa', repo: 'bbb', number: 1000 });
		assert.strictEqual(await model, pullRequest);
		assert.deepStrictEqual(resolvePullRequest.firstCall.args, ['aaa', 'bbb', 1000, false, 'overview']);
		assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
		assert.ok(result.content[0].value.includes(`aaa/bbb#1000 "${pullRequest.title}" (${pullRequest.html_url})`));
	});

	it('reports a pull request that cannot be found and closes its webview', async () => {
		sandbox.stub(FolderRepositoryManager.prototype, 'resolvePullRequest').resolves(undefined);
		// The webview's preview cannot be loaded either.
		sandbox.stub(FolderRepositoryManager.prototype, 'createGitHubRepositoryFromOwnerName').resolves(undefined);
		const createWebviewPanel = sandbox.spy(vscode.window, 'createWebviewPanel');

		await assert.rejects(invoke(), /No pull request found for aaa\/bbb#1000/);

		sandbox.assert.calledOnce(createWebviewPanel);
		assert.strictEqual(PullRequestOverviewPanel.findPanel('aaa', 'bbb', 1000), undefined);
	});

	it('is available in the agents window', () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension);
		const contribution = extension.packageJSON.contributes.languageModelTools.find(
			contributed => contributed.name === OpenPullRequestWebviewTool.toolId,
		);

		assert.strictEqual(contribution.when, 'config.githubPullRequests.experimental.chat');
	});
});
