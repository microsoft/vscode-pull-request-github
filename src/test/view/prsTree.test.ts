import * as vscode from 'vscode';
import { SinonSandbox, createSandbox } from 'sinon';
import assert = require('assert');

import { PullRequestsTreeDataProvider } from '../../view/prsTreeDataProvider';
import { PullRequestManager } from '../../github/pullRequestManager';
import { init as initKeytar } from '../../authentication/keychain';

import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockKeytar } from '../mocks/mockKeytar';
import { MockRepository } from '../mocks/mockRepository';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';

describe('GitHub Pull Requests view', function() {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let keytar: MockKeytar;
	let telemetry: MockTelemetry;
	let provider: PullRequestsTreeDataProvider;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		context = new MockExtensionContext();
		keytar = new MockKeytar();
		initKeytar(context, keytar);

		telemetry = new MockTelemetry();
		provider = new PullRequestsTreeDataProvider(telemetry);
	});

	afterEach(function () {
		provider.dispose();
		context.dispose();
		sinon.restore();
	});

	it('displays a message when no workspace folders are open', async function() {
		sinon.stub(vscode.workspace, 'workspaceFolders').value(undefined);

		const rootNodes = await provider.getChildren();
		assert.strictEqual(rootNodes.length, 1);

		const [onlyNode] = rootNodes;
		const onlyItem = onlyNode.getTreeItem();
		assert.strictEqual(onlyItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
		assert.strictEqual(onlyItem.label, 'You have not yet opened a folder.');
		assert.strictEqual(onlyItem.command, undefined);
	});

	it('displays a message when no GitHub remotes are available', async function() {
		sinon.stub(vscode.workspace, 'workspaceFolders').value([
			{index: 0, name: __dirname, uri: vscode.Uri.file(__dirname)},
		]);

		const rootNodes = await provider.getChildren();
		assert.strictEqual(rootNodes.length, 1);

		const [onlyNode] = rootNodes;
		const onlyItem = onlyNode.getTreeItem();
		assert.strictEqual(onlyItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
		assert.strictEqual(onlyItem.label, 'No git repositories found.');
		assert.strictEqual(onlyItem.command, undefined);
	});

	it('opens the viewlet and displays the default categories', async function() {
		const repository = new MockRepository();
		repository.addRemote('origin', 'git@github.com:aaa/bbb');

		const manager = new PullRequestManager(repository, telemetry);
		manager.createGitHubRepository = (remote, credentialStore) => new MockGitHubRepository(remote, credentialStore, sinon);
		provider.initialize(manager);
		await manager.updateRepositories();

		const rootNodes = await provider.getChildren();

		assert(rootNodes.every(n => n.getTreeItem().collapsibleState === vscode.TreeItemCollapsibleState.Collapsed));
		assert.deepEqual(rootNodes.map(n => n.getTreeItem().label), [
			'Local Pull Request Branches',
			'Waiting For My Review',
			'Assigned To Me',
			'Created By Me',
			'All',
		]);
	});
});