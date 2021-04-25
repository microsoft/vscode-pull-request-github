import { strict as assert } from 'assert';
import { GitPullRequest, GitRepository } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { createSandbox, SinonSandbox } from 'sinon';
import { createMock } from 'ts-auto-mock';
import * as vscode from 'vscode';

import { GitApiImpl } from '../../api/api1';
import { IMetadata } from '../../azdo/azdoRepository';
import { Azdo, CredentialStore } from '../../azdo/credentials';
import { FileReviewedStatusService } from '../../azdo/fileReviewedStatusService';
import { FolderRepositoryManager } from '../../azdo/folderRepositoryManager';
import { IRepository } from '../../azdo/interface';
import { PullRequestGitHelper } from '../../azdo/pullRequestGitHelper';
import { PullRequestModel } from '../../azdo/pullRequestModel';
import { RepositoriesManager } from '../../azdo/repositoriesManager';
import { convertAzdoPullRequestToRawPullRequest } from '../../azdo/utils';
import { Protocol } from '../../common/protocol';
import { Remote } from '../../common/remote';
import { Resource } from '../../common/resources';
import { PullRequestsTreeDataProvider } from '../../view/prsTreeDataProvider';

import { MockAzdoRepository } from '../mocks/mockAzdoRepository';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { createFakeSecretStorage, MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('GitHub Pull Requests view', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;
	let provider: PullRequestsTreeDataProvider;
	let credentialStore: CredentialStore;
	let fileReviewedStatusService;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		context = new MockExtensionContext();

		telemetry = new MockTelemetry();
		provider = new PullRequestsTreeDataProvider(telemetry);
		credentialStore = new CredentialStore(telemetry, createFakeSecretStorage());
		fileReviewedStatusService = sinon.createStubInstance(FileReviewedStatusService);

		// For tree view unit tests, we don't test the authentication flow, so `showSignInNotification` returns
		// a dummy GitHub/Octokit object.
		sinon.stub(credentialStore, 'login').callsFake(async () => {
			const azdo: Azdo = new Azdo(',', ',', ',');

			return azdo;
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
		sinon
			.stub(vscode.workspace, 'workspaceFolders')
			.value([{ index: 0, name: __dirname, uri: vscode.Uri.file(__dirname) }]);

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
		repository.addRemote('origin', 'https://aaa@dev.azure.com/aaa/bbb/_git/bbb');

		const manager = new RepositoriesManager(
			[new FolderRepositoryManager(repository, telemetry, new GitApiImpl(), credentialStore, fileReviewedStatusService)],
			credentialStore,
			telemetry,
		);
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
		repository.addRemote('origin', 'https://aaa@dev.azure.com/aaa/bbb/_git/bbb');

		const manager = new RepositoriesManager(
			[new FolderRepositoryManager(repository, telemetry, new GitApiImpl(), credentialStore, fileReviewedStatusService)],
			credentialStore,
			telemetry,
		);
		sinon.stub(credentialStore, 'isAuthenticated').returns(true);
		await manager.folderManagers[0].updateRepositories();
		provider.initialize(manager as any);

		const rootNodes = await provider.getChildren();

		assert(rootNodes.every(n => n.getTreeItem().collapsibleState === vscode.TreeItemCollapsibleState.Collapsed));
		assert.deepEqual(
			rootNodes.map(n => n.getTreeItem().label),
			['Local Pull Request Branches', 'Created By Me', 'Assigned To Me', 'All Active'],
		);
	});

	describe('Local Pull Request Branches', function () {
		it('creates a node for each local pull request', async function () {
			const url = 'https://aaa@dev.azure.com/aaa/bbb/_git/bbb';
			const remote = new Remote('origin', url, new Protocol(url));
			const azdoRepository = new MockAzdoRepository(remote, credentialStore, telemetry, sinon);

			azdoRepository.buildMetadata(
				createMock<IMetadata>({
					url: 'https://dev.azure.com/aaa/bbb/_git/bbb',
				}),
			);

			sinon.stub(azdoRepository, 'getBranchRef').resolves({
				ref: 'main',
				sha: '123',
				exists: true,
				repo: createMock<IRepository>({
					cloneUrl: 'https://dev.azure.com/aaa/bbb/_git/bbb',
				}),
			});

			const azdoGetPRStub = sinon.stub(azdoRepository, 'getPullRequest');

			const prItem0 = await convertAzdoPullRequestToRawPullRequest(
				createMock<GitPullRequest>({
					pullRequestId: 1111,
					title: 'zero',
					createdBy: {
						uniqueName: 'me',
						imageUrl: 'https://avatars.com/me.jpg',
					},
					sourceRefName: 'ref/heads/branch',
					targetRefName: 'ref/heads/main',
					repository: createMock<GitRepository>(),
				}),
				azdoRepository,
			);

			const pullRequest0 = new PullRequestModel(telemetry, azdoRepository, remote, prItem0);
			azdoGetPRStub.withArgs(1111).resolves(pullRequest0);

			const prItem1 = await convertAzdoPullRequestToRawPullRequest(
				createMock<GitPullRequest>({
					pullRequestId: 2222,
					title: 'one',
					createdBy: {
						uniqueName: 'you',
						imageUrl: 'https://avatars.com/you.jpg',
					},
					sourceRefName: 'ref/heads/branch',
					targetRefName: 'ref/heads/main',
					repository: createMock<GitRepository>(),
				}),
				azdoRepository,
			);
			const pullRequest1 = new PullRequestModel(telemetry, azdoRepository, remote, prItem1);
			azdoGetPRStub.withArgs(2222).resolves(pullRequest1);

			const repository = new MockRepository();
			await repository.addRemote(remote.remoteName, remote.url);

			await repository.createBranch('pr-branch-0', false);
			await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest0, 'pr-branch-0');
			await repository.createBranch('pr-branch-1', true);
			await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest1, 'pr-branch-1');

			await repository.createBranch('non-pr-branch', false);

			const manager = new FolderRepositoryManager(repository, telemetry, new GitApiImpl(), credentialStore, fileReviewedStatusService);
			const reposManager = new RepositoriesManager([manager], credentialStore, telemetry);
			sinon.stub(manager, 'createAzdoRepository').callsFake((r, cs) => {
				assert.deepEqual(r, remote);
				assert.strictEqual(cs, credentialStore);
				return azdoRepository;
			});
			sinon.stub(credentialStore, 'isAuthenticated').returns(true);
			await manager.updateRepositories();
			provider.initialize(reposManager as any);
			manager.activePullRequest = pullRequest1;

			const rootNodes = await provider.getChildren();
			const localNode = rootNodes.find(node => node.getTreeItem().label === 'Local Pull Request Branches');
			assert(localNode);

			const localChildren = await localNode!.getChildren();
			assert.strictEqual(localChildren.length, 2);
			const [localItem0, localItem1] = localChildren.map(node => node.getTreeItem());

			assert.strictEqual(localItem0.label, '#1111: zero');
			assert.strictEqual(localItem0.tooltip, 'zero by me');
			assert.strictEqual(localItem0.description, '#1111 by me');
			assert.strictEqual(localItem0.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
			assert.strictEqual(localItem0.contextValue, 'pullrequest:local:nonactive');
			assert.deepEqual(localItem0.iconPath!.toString(), 'https://avatars.com/me.jpg');

			assert.strictEqual(localItem1.label, '✓ #2222: one');
			assert.strictEqual(localItem1.tooltip, 'Current Branch * one by you');
			assert.strictEqual(localItem1.description, '#2222 by you');
			assert.strictEqual(localItem1.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
			assert.strictEqual(localItem1.contextValue, 'pullrequest:local:active');
			assert.deepEqual(localItem1.iconPath!.toString(), 'https://avatars.com/you.jpg');
		});
	});
});
