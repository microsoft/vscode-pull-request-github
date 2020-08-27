import * as vscode from 'vscode';
import { SinonSandbox, createSandbox } from 'sinon';
import assert = require('assert');
import { Octokit } from '@octokit/rest';

import { PullRequestsTreeDataProvider } from '../../view/prsTreeDataProvider';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';

import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { PullRequestGitHelper } from '../../github/pullRequestGitHelper';
import { PullRequestModel } from '../../github/pullRequestModel';
import { Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { CredentialStore, GitHub } from '../../github/credentials';
import { parseGraphQLPullRequest } from '../../github/utils';
import { Resource } from '../../common/resources';
import { GitApiImpl } from '../../api/api1';
import { RepositoriesManager } from '../../github/repositoriesManager';

describe('GitHub Pull Requests view', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;
	let provider: PullRequestsTreeDataProvider;
	let credentialStore: CredentialStore;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		context = new MockExtensionContext();

		telemetry = new MockTelemetry();
		provider = new PullRequestsTreeDataProvider(telemetry);
		credentialStore = new CredentialStore(telemetry);

		// For tree view unit tests, we don't test the authentication flow, so `showSignInNotification` returns
		// a dummy GitHub/Octokit object.
		sinon.stub(credentialStore, 'showSignInNotification').callsFake(async () => {
			const github: GitHub = {
				octokit: new Octokit({
					request: {},
					baseUrl: 'https://github.com',
					userAgent: 'GitHub VSCode Pull Requests',
					previews: ['shadow-cat-preview']
				}),
				graphql: null
			};

			return github;
		});

		Resource.initialize(context);
	});

	afterEach(function () {
		provider.dispose();
		context.dispose();
		sinon.restore();
	});

	it('displays a message when no workspace folders are open', async function () {
		sinon.stub(vscode.workspace, 'workspaceFolders').value(undefined);

		const rootNodes = await provider.getChildren();
		assert.strictEqual(rootNodes.length, 1);

		const [onlyNode] = rootNodes;
		const onlyItem = onlyNode.getTreeItem();
		assert.strictEqual(onlyItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
		assert.strictEqual(onlyItem.label, 'You have not yet opened a folder.');
		assert.strictEqual(onlyItem.command, undefined);
	});

	it('displays a message when no GitHub remotes are available', async function () {
		sinon.stub(vscode.workspace, 'workspaceFolders').value([
			{ index: 0, name: __dirname, uri: vscode.Uri.file(__dirname) },
		]);

		const rootNodes = await provider.getChildren();
		assert.strictEqual(rootNodes.length, 1);

		const [onlyNode] = rootNodes;
		const onlyItem = onlyNode.getTreeItem();
		assert.strictEqual(onlyItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
		assert.strictEqual(onlyItem.label, 'No git repositories found.');
		assert.strictEqual(onlyItem.command, undefined);
	});

	it('displays a message when repositories have not yet been initialized', async function () {
		const repository = new MockRepository();
		repository.addRemote('origin', 'git@github.com:aaa/bbb');

		const manager = new RepositoriesManager([new FolderRepositoryManager(repository, telemetry, new GitApiImpl(), credentialStore)], credentialStore, telemetry);
		provider.initialize(manager);

		const rootNodes = await provider.getChildren();
		assert.strictEqual(rootNodes.length, 1);

		const [onlyNode] = rootNodes;
		const onlyItem = onlyNode.getTreeItem();
		assert.strictEqual(onlyItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
		assert.strictEqual(onlyItem.label, 'Loading...');
		assert.strictEqual(onlyItem.command, undefined);
	});

	it('opens the viewlet and displays the default categories', async function () {
		const repository = new MockRepository();
		repository.addRemote('origin', 'git@github.com:aaa/bbb');

		const manager = new RepositoriesManager([new FolderRepositoryManager(repository, telemetry, new GitApiImpl(), credentialStore)], credentialStore, telemetry);
		sinon.stub(manager, 'createGitHubRepository').callsFake((remote, cStore) => {
			return new MockGitHubRepository(remote, cStore, telemetry, sinon);
		});
		sinon.stub(credentialStore, 'isAuthenticated').returns(true);
		await manager.folderManagers[0].updateRepositories();
		provider.initialize(manager);

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

	describe('Local Pull Request Branches', function () {
		it('creates a node for each local pull request', async function () {
			const url = 'git@github.com:aaa/bbb';
			const remote = new Remote('origin', url, new Protocol(url));
			const gitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			gitHubRepository.buildMetadata(m => {
				m.clone_url('https://github.com/aaa/bbb');
			});

			const pr0 = gitHubRepository.addGraphQLPullRequest((builder) => {
				builder.pullRequest(pr => {
					pr.repository(r => r.pullRequest(p => {
						p.number(1111);
						p.title('zero');
						p.author(a => a.login('me').avatarUrl('https://avatars.com/me.jpg'));
						p.baseRef!(b => b.repository(br => br.url('https://github.com/aaa/bbb')));
					}));
				});
			}).pullRequest;
			const prItem0 = parseGraphQLPullRequest(pr0, gitHubRepository);
			const pullRequest0 = new PullRequestModel(telemetry, gitHubRepository, remote, prItem0);

			const pr1 = gitHubRepository.addGraphQLPullRequest((builder) => {
				builder.pullRequest(pr => {
					pr.repository(r => r.pullRequest(p => {
						p.number(2222);
						p.title('one');
						p.author(a => a.login('you').avatarUrl('https://avatars.com/you.jpg'));
						p.baseRef!(b => b.repository(br => br.url('https://github.com/aaa/bbb')));
					}));
				});
			}).pullRequest;
			const prItem1 = parseGraphQLPullRequest(pr1, gitHubRepository);
			const pullRequest1 = new PullRequestModel(telemetry, gitHubRepository, remote, prItem1);

			const repository = new MockRepository();
			await repository.addRemote(remote.remoteName, remote.url);

			await repository.createBranch('pr-branch-0', false);
			await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest0, 'pr-branch-0');
			await repository.createBranch('pr-branch-1', true);
			await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest1, 'pr-branch-1');

			await repository.createBranch('non-pr-branch', false);

			const manager = new FolderRepositoryManager(repository, telemetry, new GitApiImpl(), credentialStore);
			const reposManager = new RepositoriesManager([manager], credentialStore, telemetry);
			sinon.stub(manager, 'createGitHubRepository').callsFake((r, cs) => {
				assert.deepEqual(r, remote);
				assert.strictEqual(cs, credentialStore);
				return gitHubRepository;
			});
			sinon.stub(credentialStore, 'isAuthenticated').returns(true);
			await manager.updateRepositories();
			provider.initialize(reposManager);
			manager.activePullRequest = pullRequest1;

			const rootNodes = await provider.getChildren();
			const localNode = rootNodes.find(node => node.getTreeItem().label === 'Local Pull Request Branches');
			assert(localNode);

			const localChildren = await localNode!.getChildren();
			assert.strictEqual(localChildren.length, 2);
			const [localItem0, localItem1] = localChildren.map(node => node.getTreeItem());

			assert.strictEqual(localItem0.label, 'zero');
			assert.strictEqual(localItem0.tooltip, 'zero (#1111) by @me');
			assert.strictEqual(localItem0.description, '#1111 by @me');
			assert.strictEqual(localItem0.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
			assert.strictEqual(localItem0.contextValue, 'pullrequest:local:nonactive');
			assert.deepEqual(localItem0.iconPath!.toString(), 'https://avatars.com/me.jpg&s=64');

			assert.strictEqual(localItem1.label, '✓ one');
			assert.strictEqual(localItem1.tooltip, 'Current Branch * one (#2222) by @you');
			assert.strictEqual(localItem1.description, '#2222 by @you');
			assert.strictEqual(localItem1.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
			assert.strictEqual(localItem1.contextValue, 'pullrequest:local:active');
			assert.deepEqual(localItem1.iconPath!.toString(), 'https://avatars.com/you.jpg&s=64');
		});
	});
});