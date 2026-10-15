/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { GitApiImpl } from '../../api/api1';
import { GitHubServerType } from '../../common/authentication';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { EXTENSION_ID } from '../../constants';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { FolderRepositoryManagerResolver } from '../../github/folderRepositoryManagerResolver';
import { IssueModel } from '../../github/issueModel';
import { IssueOverviewPanel, panelKey } from '../../github/issueOverview';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { UnresolvedIdentity } from '../../github/views';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';

class TestIssueOverviewPanel extends IssueOverviewPanel {
	public static override registerRepositoriesManager(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager): void {
		super.registerRepositoriesManager(context, repositoriesManager);
	}

	constructor(telemetry: MockTelemetry, manager: FolderRepositoryManager) {
		super(telemetry, manager.context.extensionUri, vscode.ViewColumn.One, '#1000', manager);
	}

	public setItem(item: IssueModel): void {
		this._item = item;
		this._identity = { owner: item.remote.owner, repo: item.remote.repositoryName, number: item.number };
		TestIssueOverviewPanel._panels.set(panelKey(item.remote.owner, item.remote.repositoryName, item.number), this);
	}

	public get folderRepositoryManager(): FolderRepositoryManager {
		return this._folderRepositoryManager;
	}

	public override resolveModel(identity: UnresolvedIdentity): Promise<IssueModel | undefined> {
		return super.resolveModel(identity);
	}

	public override _postMessage(message: { command: string; isCurrentlyCheckedOut?: boolean }): Promise<void> {
		return super._postMessage(message);
	}
}

describe('IssueOverview remote-only manager upgrades', function () {
	let sandbox: SinonSandbox;
	let context: MockExtensionContext;
	let repositoriesManager: RepositoriesManager;
	let localManager: FolderRepositoryManager;
	let temporaryManager: FolderRepositoryManager;
	let panel: TestIssueOverviewPanel;
	let issue: IssueModel;
	let discovered: boolean;
	let postMessage: SinonStub;

	beforeEach(function () {
		sandbox = createSandbox();
		context = new MockExtensionContext();
		context.extensionUri = vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri;
		const telemetry = new MockTelemetry();
		const credentialStore = new CredentialStore(telemetry, context);
		repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		const git = new GitApiImpl(repositoriesManager);
		const helper = new CreatePullRequestHelper();
		localManager = new FolderRepositoryManager(0, context, new MockRepository(), telemetry, git,
			credentialStore, helper, new MockThemeWatcher());
		const url = 'https://github.com/aaa/bbb';
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		const repo = new MockGitHubRepository(remote, credentialStore, telemetry, sandbox);
		discovered = false;
		sandbox.stub(localManager, 'gitHubRepositories').get(() => discovered ? [repo] : []);
		repositoriesManager.insertFolderManager(localManager);
		TestIssueOverviewPanel.registerRepositoriesManager(context, repositoriesManager);
		const resolver = new FolderRepositoryManagerResolver(context, repositoriesManager, telemetry);
		temporaryManager = resolver.getRemoteOnlyManager();
		issue = new IssueModel(telemetry, repo, remote, {
			...convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo),
			url: 'https://github.com/aaa/bbb/issues/1000',
		});
		panel = new TestIssueOverviewPanel(telemetry, temporaryManager);
		panel.setItem(issue);
		postMessage = sandbox.stub(panel, '_postMessage').resolves();
		context.subscriptions.push(credentialStore, repositoriesManager, git, helper, repo, resolver, issue, panel);
	});

	afterEach(function () {
		IssueOverviewPanel.clearAll();
		context.dispose();
		sandbox.restore();
	});

	it('uses the temporary manager while the repository is undiscovered', async function () {
		const resolveIssue = sandbox.stub(temporaryManager, 'resolveIssue').resolves(issue);

		assert.strictEqual(await panel.resolveModel({ owner: 'aaa', repo: 'bbb', number: 1000 }), issue);

		assert.strictEqual(panel.folderRepositoryManager, temporaryManager);
		sandbox.assert.calledWithExactly(resolveIssue, 'aaa', 'bbb', 1000);
	});

	it('upgrades during issue resolution without needing an active-issue event', async function () {
		const localResolve = sandbox.stub(localManager, 'resolveIssue').resolves(issue);
		const temporaryResolve = sandbox.stub(temporaryManager, 'resolveIssue').resolves(issue);
		discovered = true;

		assert.strictEqual(await panel.resolveModel({ owner: 'aaa', repo: 'bbb', number: 1000 }), issue);

		assert.strictEqual(panel.folderRepositoryManager, localManager);
		sandbox.assert.calledWithExactly(localResolve, 'aaa', 'bbb', 1000);
		sandbox.assert.notCalled(temporaryResolve);
	});

	it('upgrades without subscribing to active-issue changes on the local manager', function () {
		const subscribe = sandbox.spy(localManager, 'onDidChangeActiveIssue');
		discovered = true;

		assert.strictEqual(panel.folderRepositoryManager, localManager);
		localManager.activeIssue = issue;

		sandbox.assert.notCalled(subscribe);
		sandbox.assert.notCalled(postMessage);
	});

	it('does not send checkout-status messages when either manager changes its active issue', function () {
		temporaryManager.activeIssue = issue;
		localManager.activeIssue = issue;
		sandbox.assert.notCalled(postMessage);
		discovered = true;
		assert.strictEqual(panel.folderRepositoryManager, localManager);

		temporaryManager.activeIssue = undefined;
		localManager.activeIssue = undefined;

		sandbox.assert.notCalled(postMessage);
	});

	it('retains its local manager without looking it up again', function () {
		discovered = true;
		assert.strictEqual(panel.folderRepositoryManager, localManager);
		const lookup = sandbox.spy(repositoriesManager, 'getManagerForRepository');
		discovered = false;

		assert.strictEqual(panel.folderRepositoryManager, localManager);
		sandbox.assert.notCalled(lookup);
	});

	it('does not upgrade or attach listeners after disposal', function () {
		panel.dispose();
		discovered = true;
		const lookup = sandbox.spy(repositoriesManager, 'getManagerForRepository');

		assert.strictEqual(panel.folderRepositoryManager, temporaryManager);
		localManager.activeIssue = issue;

		sandbox.assert.notCalled(lookup);
		sandbox.assert.notCalled(postMessage);
	});
});
