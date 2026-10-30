/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SinonSandbox, SinonSpy, SinonStub, createSandbox } from 'sinon';
import { default as assert } from 'assert';
import { Octokit } from '@octokit/rest';
import { ApolloClient, ApolloLink, InMemoryCache } from 'apollo-boost';

import { getEnterpriseAuthenticationMessage, PullRequestsTreeDataProvider } from '../../view/prsTreeDataProvider';
import { NotificationsManager } from '../../notifications/notificationsManager';
import { FolderRepositoryManager, ItemsResponseResult, ReposManagerState } from '../../github/folderRepositoryManager';

import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockNotificationManager } from '../mocks/mockNotificationManager';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { mockTreeViewWorkbench } from '../mocks/mockTreeViewWorkbench';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { PullRequestGitHelper } from '../../github/pullRequestGitHelper';
import { PullRequestModel } from '../../github/pullRequestModel';
import { GitHubRepository, PullRequestChangeEvent } from '../../github/githubRepository';
import { convertRESTPullRequestToRawPullRequest, parseGraphQLPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { PRNode } from '../../view/treeNodes/pullRequestNode';
import { CategoryTreeNode, collectPRNodes, findPullRequestNode, PRCategoryActionNode, PRCategoryActionType, PRGroupTreeNode } from '../../view/treeNodes/categoryNode';
import { GitHubRemote, Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { CredentialStore, GitHub } from '../../github/credentials';
import { GitApiImpl } from '../../api/api1';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { LoggingApolloClient, LoggingOctokit, RateLogger } from '../../github/loggingOctokit';
import { AuthProvider, GitHubServerType } from '../../common/authentication';
import * as configuration from '../../authentication/configuration';
import { GitHubManager } from '../../authentication/githubServer';
import { DataUri } from '../../common/uri';
import { GithubItemStateEnum, IAccount, ITeam, PRType, PullRequestMergeability } from '../../github/interface';
import { asPromise } from '../../common/utils';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';
import { EXPANDED_QUERIES_STATE, PrsTreeModel } from '../../view/prsTreeModel';
import { escapeMarkdownText } from '../../github/markdownUtils';
import { mockEnterpriseUris } from '../mocks/mockEnterpriseUris';
import { TreeNode } from '../../view/treeNodes/treeNode';
import { IssueChangeEvent } from '../../github/issueModel';

describe('GitHub Pull Requests view', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;
	let provider: PullRequestsTreeDataProvider;
	let credentialStore: CredentialStore;
	let reposManager: RepositoriesManager;
	let createPrHelper: CreatePullRequestHelper;
	let mockThemeWatcher: MockThemeWatcher;
	let mockNotificationsManager: MockNotificationManager;
	let prsTreeModel: PrsTreeModel;
	let discoveredRepository: MockGitHubRepository | undefined;
	let createTreeView: SinonStub;
	let executeCommand: SinonStub;

	beforeEach(function () {
		sinon = createSandbox();
		discoveredRepository = undefined;
		MockCommandRegistry.install(sinon);
		({ createTreeView, executeCommand } = mockTreeViewWorkbench(sinon));
		mockThemeWatcher = new MockThemeWatcher();

		context = new MockExtensionContext();

		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		reposManager = new RepositoriesManager(
			credentialStore,
			telemetry,
		);
		prsTreeModel = new PrsTreeModel(telemetry, reposManager, context);
		provider = new PullRequestsTreeDataProvider(prsTreeModel, telemetry, context, reposManager);
		mockNotificationsManager = new MockNotificationManager();
		createPrHelper = new CreatePullRequestHelper();

		// For tree view unit tests, we don't test the authentication flow, so `showSignInNotification` returns
		// a dummy GitHub/Octokit object.
		sinon.stub(credentialStore, 'showSignInNotification').callsFake(async () => {
			const github: GitHub = {
				serverUri: vscode.Uri.parse('https://github.com'),
				octokit: new LoggingOctokit(new Octokit({
					request: {},
					baseUrl: 'https://github.com',
					userAgent: 'GitHub VSCode Pull Requests',
					previews: ['shadow-cat-preview'],
				}), new RateLogger(telemetry, true)),
				graphql: {} as any,
			};

			return github;
		});
	});

	function stubRepositoryDiscovery(folderManager: FolderRepositoryManager): void {
		const url = 'git@github.com:aaa/bbb';
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		const githubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
		githubRepository.buildMetadata(metadata => metadata.clone_url('https://github.com/aaa/bbb'));
		discoveredRepository = githubRepository;
		sinon.stub(folderManager, 'createGitHubRepository').resolves(githubRepository);
	}

	function stackableRestPullRequest(repository: GitHubRepository, number: number, base: string, head: string) {
		const remote = repository.remote;
		const rest = new PullRequestBuilder().number(number).id(number)
			.html_url(`https://github.com/${remote.owner}/${remote.repositoryName}/pull/${number}`)
			.base(ref => ref.ref(base)).head(ref => ref.ref(head)).build();
		for (const ref of [rest.base, rest.head]) {
			ref.repo.owner.login = remote.owner;
			ref.repo.name = remote.repositoryName;
			ref.repo.clone_url = `https://github.com/${remote.owner}/${remote.repositoryName}.git`;
		}
		return rest;
	}

	function stackablePullRequest(repository: MockGitHubRepository, number: number, base: string, head: string): PullRequestModel {
		const remote = repository.remote;
		const rest = stackableRestPullRequest(repository, number, base, head);
		return new PullRequestModel(credentialStore, telemetry, repository, remote,
			convertRESTPullRequestToRawPullRequest(rest, repository));
	}

	afterEach(function () {
		provider.dispose();
		discoveredRepository?.dispose();
		prsTreeModel.dispose();
		for (const manager of [...reposManager.folderManagers]) {
			for (const repository of manager.gitHubRepositories) {
				repository.dispose();
			}
			reposManager.removeRepo(manager.repository);
		}
		reposManager.dispose();
		credentialStore.dispose();
		context.dispose();
		sinon.restore();
	});

	it('has no children when no workspace folders are open', async function () {
		sinon.stub(vscode.workspace, 'workspaceFolders').value(undefined);

		const rootNodes = await provider.getChildren();
		assert.strictEqual(rootNodes.length, 0);
	});

	it('allows selecting multiple pull requests to create a stack', function () {
		const tree = createTreeView.getCalls().find(call => call.args[0] === 'pr:github');
		assert(tree);
		const options = tree.args[1] as { canSelectMany?: boolean };
		assert.strictEqual(options.canSelectMany, true);
	});

	it('offers Add to Stack only while the selected pull requests form a chain', function () {
		const selectionChanged = new vscode.EventEmitter<vscode.TreeViewSelectionChangeEvent<TreeNode>>();
		context.subscriptions.push(selectionChanged);
		let selection: TreeNode[] = [];
		const view = provider.view;
		createTreeView.callsFake((): vscode.TreeView<TreeNode> => ({
			...view, onDidChangeSelection: selectionChanged.event, get selection() { return selection; }, dispose: () => view.dispose(),
		}));
		provider.dispose();
		provider = new PullRequestsTreeDataProvider(prsTreeModel, telemetry, context, reposManager);

		const url = 'https://github.com/aaa/bbb';
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		discoveredRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
		const [bottom, top, unrelated] = [
			stackablePullRequest(discoveredRepository, 1, 'main', 'D1'),
			stackablePullRequest(discoveredRepository, 2, 'D1', 'D2'),
			stackablePullRequest(discoveredRepository, 3, 'main', 'D3'),
		].map(model => Object.assign(Object.create(PRNode.prototype), { pullRequestModel: model }) as PRNode);

		for (const [selected, stackable] of [[[bottom, top], true], [[top, unrelated], false]] as const) {
			selection = [...selected];
			executeCommand.resetHistory();
			selectionChanged.fire({ selection });
			assert(executeCommand.calledOnceWithExactly('setContext', 'github:canAddToStack', stackable));
		}
	});

	it('adds selected PRs without fetching stack membership to refresh panels', async function () {
		const url = 'https://github.com/aaa/bbb';
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		const repository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
		try {
			const bottom = stackablePullRequest(repository, 1, 'main', 'D1');
			const top = stackablePullRequest(repository, 2, 'D1', 'D2');
			const node = (model: PullRequestModel) => Object.assign(Object.create(PRNode.prototype), { pullRequestModel: model }) as PRNode;
			const selected = [node(bottom), node(top)];
			const existing = {
				position: 2, size: 2, base: 'main',
				pullRequests: [
					{ position: 1, number: 10, title: 'Existing', url, head: 'main', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Unknown },
					{ position: 2, number: 1, title: 'Bottom', url, head: 'D1', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Unknown },
				],
			};
			const getStack = sinon.stub(bottom, 'getStack').resolves(existing);
			sinon.stub(top, 'getStack').resolves(undefined);
			sinon.stub(repository, 'getStackCandidate').resolves({ parentPullRequestNumber: 1, stackNumber: 10, size: 2, url });
			sinon.stub(repository, 'getPullRequest').callsFake(async number => number === 1 ? bottom : top);
			const add = sinon.stub(repository, 'addPullRequestsToStack').resolves();
			const confirm = sinon.stub(vscode.window, 'showInformationMessage');
			confirm.onFirstCall().resolves('Add to Stack' as never);
			confirm.onSecondCall().resolves(undefined);

			await (provider as any).addSelectedPullRequestsToStack(selected[0], selected);

			assert(add.calledOnce);
			assert(getStack.notCalled);
		} finally {
			repository.dispose();
		}
	});

	it('warns that auto-merge will be disabled when only refreshing the pull requests shows it', async function () {
		const url = 'https://github.com/aaa/bbb';
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		const repository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
		try {
			const bottom = stackablePullRequest(repository, 1, 'main', 'D1');
			const top = stackablePullRequest(repository, 2, 'D1', 'D2');
			const selected = [bottom, top].map(model => Object.assign(Object.create(PRNode.prototype), { pullRequestModel: model }) as PRNode);
			sinon.stub(top, 'getStack').resolves(undefined);
			sinon.stub(repository, 'getStackCandidate').resolves({ parentPullRequestNumber: 1, size: 1, url });
			sinon.stub(repository, 'getPullRequest').callsFake(async number => {
				bottom.item.autoMerge = true;
				return number === 1 ? bottom : top;
			});
			const disable = sinon.stub(bottom, 'disableAutoMerge').resolves();
			const add = sinon.stub(repository, 'addPullRequestsToStack').resolves();
			const confirm = sinon.stub(vscode.window, 'showInformationMessage');
			confirm.onFirstCall().resolves('Create Stack' as never);
			confirm.onSecondCall().resolves(undefined);
			const addToStack = (vscode.commands.registerCommand as SinonStub).getCalls()
				.filter(call => call.args[0] === 'pr.addToStack').pop();
			assert(addToStack);

			await addToStack.args[1](selected[0], selected);

			assert.match(confirm.firstCall.args[1].detail ?? '', /so it will be disabled for #1\.$/);
			sinon.assert.callOrder(confirm, disable, add);
			assert(add.calledOnce);
		} finally {
			repository.dispose();
		}
	});

	it('has no children when no GitHub remotes are available', async function () {
		sinon
			.stub(vscode.workspace, 'workspaceFolders')
			.value([{ index: 0, name: __dirname, uri: vscode.Uri.file(__dirname) }]);

		const rootNodes = await provider.getChildren();
		assert.strictEqual(rootNodes.length, 0);
	});

	it('has no children when repositories have not yet been initialized', async function () {
		const repository = new MockRepository();
		await repository.addRemote('origin', 'git@github.com:aaa/bbb');
		reposManager.insertFolderManager(new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));
		provider.initialize([], mockNotificationsManager as NotificationsManager);

		const rootNodes = await provider.getChildren();
		assert.strictEqual(rootNodes.length, 0);
	});

	describe('Enterprise host guidance', function () {
		const hostA = vscode.Uri.parse('https://host-a.example');
		const hostB = vscode.Uri.parse('https://host-b.example:8443/deployment');
		let enterpriseRemote: GitHubRemote;

		beforeEach(function () {
			const url = `${hostB.toString()}/owner/repo`;
			enterpriseRemote = new GitHubRemote('upstream', url, new Protocol(url), GitHubServerType.Enterprise);
		});

		it('explains a configured but unselected host instead of reporting an empty result', function () {
			const message = getEnterpriseAuthenticationMessage([enterpriseRemote], [hostA, hostB], hostA);
			assert.strictEqual(message, 'Using host-a.example for GitHub Enterprise.\n\nSelect an account for host-b.example:8443/deployment to view its repositories.');
		});

		it('distinguishes configuration from sign-in', function () {
			assert.strictEqual(getEnterpriseAuthenticationMessage([enterpriseRemote], [], undefined), 'Add host-b.example:8443/deployment to your GitHub Enterprise instances in Settings.');
			assert.strictEqual(getEnterpriseAuthenticationMessage([enterpriseRemote], [hostB], undefined), 'Select a GitHub Enterprise account to view repositories on host-b.example:8443/deployment.');
			assert.strictEqual(getEnterpriseAuthenticationMessage([enterpriseRemote], [hostB], hostB), undefined);
		});

		it('shows host guidance alongside loaded public repositories and clears it after switching', async function () {
			const repository = new MockRepository();
			await repository.addRemote('origin', 'https://github.com/owner/repo');
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			sinon.stub(folderManager, 'getPullRequestDefaults').resolves({ owner: 'owner', repo: 'repo', base: 'main' });
			reposManager.insertFolderManager(folderManager);
			sinon.stub(credentialStore, 'isAuthenticated').returns(true);
			await folderManager.updateRepositories();
			const publicRemotes = await folderManager.getGitHubRemotes();
			assert.strictEqual(publicRemotes.length, 1);
			sinon.stub(folderManager, 'computeAllGitHubRemotes').resolves([...publicRemotes, enterpriseRemote]);
			sinon.stub(configuration, 'getEnterpriseUris').returns([hostA, hostB]);
			const hub: GitHub = {
				serverUri: hostA,
				octokit: new LoggingOctokit(new Octokit(), new RateLogger(telemetry, false)),
				graphql: new LoggingApolloClient(new ApolloClient({ cache: new InMemoryCache(), link: ApolloLink.empty() }), new RateLogger(telemetry, false)),
			};
			const getHub = sinon.stub(credentialStore, 'getHub').withArgs(AuthProvider.githubEnterprise).returns(hub);
			await folderManager.updateRepositories();
			provider.initialize([], mockNotificationsManager as NotificationsManager);

			assert.ok((await provider.getChildren()).length > 0);
			const message = (provider.view as vscode.TreeView2<unknown>).message;
			assert.ok(message instanceof vscode.MarkdownString);
			assert.ok(message.value.includes(escapeMarkdownText('host-b.example:8443/deployment')));
			assert.doesNotMatch(message.value, /&nbsp;|\u00a0|https?:\/\/|Accounts.*Preferences/);
			assert.match(message.value, /\[Select Account\]\(command:pr\.selectEnterpriseAccount\)/);
			assert.doesNotMatch(message.value, /command:workbench\.action\.openSettings/);

			getHub.returns({ ...hub, serverUri: hostB });
			await provider.getChildren();
			assert.strictEqual(provider.view.message, undefined);
		});

		it('shows switching guidance in the login view while the PR view is hidden', async function () {
			const repository = new MockRepository();
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			reposManager.insertFolderManager(folderManager);
			sinon.stub(folderManager, 'computeAllGitHubRemotes').resolves([enterpriseRemote]);
			sinon.stub(reposManager, 'state').get(() => ReposManagerState.NeedsAuthentication);
			sinon.stub(configuration, 'getEnterpriseUris').returns([hostA, hostB]);
			sinon.stub(credentialStore, 'getHub').withArgs(AuthProvider.githubEnterprise).returns({
				serverUri: hostA,
				octokit: new LoggingOctokit(new Octokit(), new RateLogger(telemetry, false)),
				graphql: new LoggingApolloClient(new ApolloClient({ cache: new InMemoryCache(), link: ApolloLink.empty() }), new RateLogger(telemetry, false)),
			});
			await folderManager.updateRepositories();
			const loginView = createTreeView.getCalls().find(call => call.args[0] === 'github:login');
			assert.ok(loginView);

			assert.deepStrictEqual(await loginView.args[1].treeDataProvider.getChildren(), []);
			assert.ok(loginView.returnValue.message instanceof vscode.MarkdownString);
			assert.match(loginView.returnValue.message.value, /\[Select Account\]\(command:pr\.selectEnterpriseAccount\)/);
			assert.ok(loginView.returnValue.message.value.includes(escapeMarkdownText('host-b.example')));
			assert.doesNotMatch(loginView.returnValue.message.value, /\]\(command:pr\.signinenterprise\)/);
			assert.doesNotMatch(loginView.returnValue.message.value, /&nbsp;|\u00a0|command:workbench\.action\.openSettings/);
			assert.strictEqual(loginView.returnValue.message, provider.view.message);
		});

		it('offers account selection from the login view when there is no selected session', async function () {
			const repository = new MockRepository();
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			reposManager.insertFolderManager(folderManager);
			sinon.stub(folderManager, 'computeAllGitHubRemotes').resolves([enterpriseRemote]);
			sinon.stub(configuration, 'getEnterpriseUris').returns([hostB]);
			await folderManager.updateRepositories();
			const loginView = createTreeView.getCalls().find(call => call.args[0] === 'github:login');
			assert.ok(loginView);

			assert.deepStrictEqual(await loginView.args[1].treeDataProvider.getChildren(), []);
			assert.ok(loginView.returnValue.message instanceof vscode.MarkdownString);
			assert.ok(loginView.returnValue.message.value.startsWith('Select a GitHub Enterprise account to view repositories on '));
			assert.match(loginView.returnValue.message.value, /\[Select Account\]\(command:pr\.selectEnterpriseAccount\)/);
			assert.doesNotMatch(loginView.returnValue.message.value, /&nbsp;|\u00a0|command:workbench\.action\.openSettings/);
			assert.deepStrictEqual(loginView.returnValue.message.isTrusted, {
				enabledCommands: ['pr.signinNoEnterprise', 'pr.selectEnterpriseAccount', 'workbench.action.openSettings'],
			});
		});

		it('preserves both sign-in actions for mixed repositories with no selected sessions', async function () {
			const repository = new MockRepository();
			const publicUrl = 'https://github.com/owner/repo';
			await repository.addRemote('origin', publicUrl);
			await repository.addRemote(enterpriseRemote.remoteName, enterpriseRemote.url);
			const publicRemote = new GitHubRemote('origin', publicUrl, new Protocol(publicUrl), GitHubServerType.GitHubDotCom);
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			context.subscriptions.push(folderManager);
			reposManager.insertFolderManager(folderManager);
			sinon.stub(folderManager, 'computeAllGitHubRemotes').resolves([publicRemote, enterpriseRemote]);
			sinon.stub(configuration, 'getEnterpriseUris').returns([hostB]);
			await folderManager.updateRepositories();
			assert.strictEqual(reposManager.state, ReposManagerState.NeedsAuthentication);
			assert.strictEqual(credentialStore.isAnyAuthenticated(), false);

			const loginView = createTreeView.getCalls().find(call => call.args[0] === 'github:login');
			assert.ok(loginView);
			assert.deepStrictEqual(await loginView.args[1].treeDataProvider.getChildren(), []);
			const message = loginView.returnValue.message;
			assert.ok(message instanceof vscode.MarkdownString);
			assert.match(message.value, /\]\(command:pr\.signinNoEnterprise\)/);
			assert.match(message.value, /\]\(command:pr\.selectEnterpriseAccount\)/);
		});

		it('preserves public sign-in when Enterprise configuration is invalid', async function () {
			const repository = new MockRepository();
			await repository.addRemote('origin', 'https://github.com/owner/repo');
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			context.subscriptions.push(folderManager);
			reposManager.insertFolderManager(folderManager);
			sinon.stub(configuration, 'getEnterpriseUris').throws(new Error('Invalid instance list'));
			await folderManager.updateRepositories();
			assert.strictEqual(reposManager.state, ReposManagerState.NeedsAuthentication);

			const loginView = createTreeView.getCalls().find(call => call.args[0] === 'github:login');
			assert.ok(loginView);
			assert.deepStrictEqual(await loginView.args[1].treeDataProvider.getChildren(), []);
			const message = loginView.returnValue.message;
			assert.ok(message instanceof vscode.MarkdownString);
			assert.ok(message.value.includes('Invalid instance list'));
			assert.match(message.value, /\]\(command:pr\.signinNoEnterprise\)/);
			assert.match(message.value, /command:workbench\.action\.openSettings/);
			assert.doesNotMatch(message.value, /\]\(command:pr\.selectEnterpriseAccount\)/);
		});

		it('renders known repositories and guidance while discovery of an excluded remote is pending', async function () {
			const repository = new MockRepository();
			const publicUrl = 'https://github.com/owner/repo';
			await repository.addRemote('origin', publicUrl);
			await repository.addRemote(enterpriseRemote.remoteName, enterpriseRemote.url);
			const publicRemote = new GitHubRemote('origin', publicUrl, new Protocol(publicUrl), GitHubServerType.GitHubDotCom);
			const knownRemotes = [publicRemote, enterpriseRemote];
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			context.subscriptions.push(folderManager);
			reposManager.insertFolderManager(folderManager);
			sinon.stub(folderManager, 'getPullRequestDefaults').resolves({ owner: 'owner', repo: 'repo', base: 'main' });
			sinon.stub(credentialStore, 'isAuthenticated').callsFake(provider => provider === AuthProvider.github);
			sinon.stub(configuration, 'getEnterpriseUris').returns([hostB]);
			const discovery = sinon.stub(folderManager, 'computeAllGitHubRemotes').resolves(knownRemotes);
			await folderManager.updateRepositories();
			provider.initialize([], mockNotificationsManager as NotificationsManager);

			await repository.addRemote('backup', 'https://offline.example/owner/repo');
			let completeDiscovery!: (remotes: GitHubRemote[]) => void;
			const pendingDiscovery = new Promise<GitHubRemote[]>(resolve => completeDiscovery = resolve);
			let markStarted!: () => void;
			const started = new Promise<void>(resolve => markStarted = resolve);
			discovery.resetHistory();
			discovery.onFirstCall().callsFake(() => {
				markStarted();
				return pendingDiscovery;
			});
			discovery.onSecondCall().rejects(new Error('Rendering must not start remote discovery'));
			const refresh = folderManager.updateRepositories();
			await started;
			const reclassification = sinon.stub(folderManager, 'getGitHubRemotes').rejects(new Error('Rendering must not reclassify loaded repositories'));

			try {
				assert.ok((await provider.getChildren()).length > 0);
				const loginView = createTreeView.getCalls().find(call => call.args[0] === 'github:login');
				assert.ok(loginView);
				assert.deepStrictEqual(await loginView.args[1].treeDataProvider.getChildren(), []);
				assert.ok(loginView.returnValue.message instanceof vscode.MarkdownString);
				assert.ok(loginView.returnValue.message.value.includes(escapeMarkdownText('host-b.example')));
				assert.doesNotMatch(loginView.returnValue.message.value, /offline\.example/);
				assert.strictEqual(discovery.calledOnce, true);
				assert.strictEqual(reclassification.called, false);
			} finally {
				completeDiscovery(knownRemotes);
				await refresh;
			}
		});

		it('refreshes guidance when owned discovery completes without changing authentication state', async function () {
			const repository = new MockRepository();
			await repository.addRemote(enterpriseRemote.remoteName, enterpriseRemote.url);
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			context.subscriptions.push(folderManager);
			reposManager.insertFolderManager(folderManager);
			const discovery = sinon.stub(folderManager, 'computeAllGitHubRemotes').resolves([enterpriseRemote]);
			sinon.stub(configuration, 'getEnterpriseUris').returns([hostA, hostB]);
			await folderManager.updateRepositories();
			provider.initialize([], mockNotificationsManager as NotificationsManager);
			const onDidChangeTreeData = sinon.spy();
			context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));
			const replacementUrl = `${hostA.toString()}/owner/repo`;
			const replacementRemote = new GitHubRemote('upstream', replacementUrl, new Protocol(replacementUrl), GitHubServerType.Enterprise);
			await repository.removeRemote('upstream');
			await repository.addRemote('upstream', replacementUrl);
			discovery.resolves([replacementRemote]);

			await folderManager.updateRepositories();

			assert.strictEqual(reposManager.state, ReposManagerState.NeedsAuthentication);
			assert.strictEqual(onDidChangeTreeData.called, true);
			const loginView = createTreeView.getCalls().find(call => call.args[0] === 'github:login');
			assert.ok(loginView);
			await loginView.args[1].treeDataProvider.getChildren();
			assert.ok(loginView.returnValue.message instanceof vscode.MarkdownString);
			assert.ok(loginView.returnValue.message.value.includes(escapeMarkdownText('host-a.example')));
			assert.doesNotMatch(loginView.returnValue.message.value, /host-b\.example/);
		});

		it('reports invalid configuration in the view without falling back to a host', async function () {
			const repository = new MockRepository();
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			reposManager.insertFolderManager(folderManager);
			sinon.stub(folderManager, 'computeAllGitHubRemotes').resolves([enterpriseRemote]);
			sinon.stub(reposManager, 'state').get(() => ReposManagerState.NeedsAuthentication);
			sinon.stub(configuration, 'getEnterpriseUris').throws(new Error('Invalid instance list'));
			await folderManager.updateRepositories();

			assert.deepStrictEqual(await provider.getChildren(), []);
			const message = (provider.view as vscode.TreeView2<unknown>).message;
			assert.ok(message instanceof vscode.MarkdownString);
			assert.ok(message.value.includes('Invalid instance list'));
			assert.ok(message.value.includes('GitHub Enterprise instances in Settings'));
			assert.match(message.value, /command:workbench\.action\.openSettings/);
			assert.doesNotMatch(message.value, /&nbsp;|\u00a0|\]\(command:pr\.selectEnterpriseAccount\)/);
		});

		async function loadSignedIn(remotes: Record<string, string>, signedIn: AuthProvider[] = [AuthProvider.github], enterpriseUris: string[] = []): Promise<PRCategoryActionNode[]> {
			const repository = new MockRepository();
			for (const [name, url] of Object.entries(remotes)) {
				await repository.addRemote(name, url);
			}
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			reposManager.insertFolderManager(folderManager);
			const isGitHub = GitHubManager.prototype.isGitHub;
			// Discovery would probe other hosts over the network; treat them as unreachable.
			sinon.stub(GitHubManager.prototype, 'isGitHub').callsFake(function (this: GitHubManager, remote: Remote) {
				return GitHubManager.isGithubDotCom(remote.host) ? isGitHub.call(this, remote) : Promise.resolve(GitHubServerType.None);
			});
			sinon.stub(credentialStore, 'isAuthenticated').callsFake(authProviderId => signedIn.includes(authProviderId));
			mockEnterpriseUris(sinon, enterpriseUris);
			await folderManager.updateRepositories();
			provider.initialize([], mockNotificationsManager as NotificationsManager);

			assert.strictEqual(reposManager.state, ReposManagerState.RepositoriesLoaded);
			const children = await provider.getChildren();
			const actions = children.filter(child => child instanceof PRCategoryActionNode);
			assert.strictEqual(actions.length, children.length);
			return actions;
		}

		it('offers GitHub Enterprise setup instead of loading indefinitely when a remote host is not recognized', async function () {
			const actions = await loadSignedIn({ origin: 'ssh://git@ghe.example.com/org/repo.git' });

			assert.deepStrictEqual(actions.map(action => action.type), [PRCategoryActionType.NoRemotes, PRCategoryActionType.LoginEnterprise]);
			assert.strictEqual(actions[1].command?.command, 'pr.signinenterprise');
		});

		it('offers to configure an unrecognized host when signed in to another GitHub Enterprise instance', async function () {
			const actions = await loadSignedIn({ origin: 'ssh://git@ghe.example.com/org/repo.git' }, [AuthProvider.github, AuthProvider.githubEnterprise], ['https://other-ghe.example.com']);

			assert.deepStrictEqual(actions.map(action => action.type), [PRCategoryActionType.NoRemotes, PRCategoryActionType.ConfigureEnterprise]);
			assert.deepStrictEqual(actions[1].command, { title: 'Configure GitHub Enterprise', command: 'workbench.action.openSettings', arguments: ['github-enterprise.uris'] });
		});

		it('offers remote configuration when the remotes setting excludes recognized GitHub remotes', async function () {
			const actions = await loadSignedIn({ fork: 'https://github.com/owner/repo', backup: 'ssh://git@ghe.example.com/org/repo.git' });

			assert.deepStrictEqual(actions.map(action => action.type), [PRCategoryActionType.NoMatchingRemotes, PRCategoryActionType.ConfigureRemotes]);
		});

		it('does not offer GitHub Enterprise setup for hosts that are never GitHub', async function () {
			const actions = await loadSignedIn({ origin: 'https://codeberg.org/owner/repo' });

			assert.deepStrictEqual(actions.map(action => action.type), [PRCategoryActionType.NoMatchingRemotes, PRCategoryActionType.ConfigureRemotes]);
		});

		it('does not offer GitHub Enterprise setup for unsupported GitHub repositories', async function () {
			const actions = await loadSignedIn({ origin: 'https://github.com/owner/repo.wiki.git' });

			assert.deepStrictEqual(actions.map(action => action.type), [PRCategoryActionType.NoMatchingRemotes, PRCategoryActionType.ConfigureRemotes]);
		});
	});

	it('opens the viewlet and displays the default categories', async function () {
		this.timeout(10000);
		const repository = new MockRepository();
		await repository.addRemote('origin', 'git@github.com:aaa/bbb');
		const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
		stubRepositoryDiscovery(folderManager);
		sinon.stub(folderManager, 'getPullRequestDefaults').returns(Promise.resolve({ owner: 'aaa', repo: 'bbb', base: 'main' }));
		reposManager.insertFolderManager(folderManager);
		sinon.stub(credentialStore, 'isAuthenticated').returns(true);
		await reposManager.folderManagers[0].updateRepositories();
		provider.initialize([], mockNotificationsManager as NotificationsManager);

		const rootNodes = await provider.getChildren();

		// All but the last category are expected to be collapsed
		const treeItems = await Promise.all(rootNodes.map(node => node.getTreeItem()));
		assert(treeItems.slice(0, treeItems.length - 1).every(n => n.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed));
		assert(treeItems[treeItems.length - 1].collapsibleState === vscode.TreeItemCollapsibleState.Expanded);
		assert.deepStrictEqual(
			treeItems.map(n => n.label),
			['Copilot on My Behalf', 'Local Pull Request Branches', 'Waiting For My Review', 'Created By Me', 'All Open'],
		);
	});

	describe('All Open', function () {
		let folderManager: FolderRepositoryManager;
		let pullRequest: PullRequestModel;
		let nextPullRequest: PullRequestModel;
		let getPullRequests: SinonStub;

		beforeEach(function () {
			const repository = new MockRepository();
			folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			reposManager.insertFolderManager(folderManager);
			const url = 'https://github.com/aaa/bbb';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const githubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			discoveredRepository = githubRepository;
			pullRequest = stackablePullRequest(githubRepository, 1, 'main', 'feature');
			nextPullRequest = stackablePullRequest(githubRepository, 2, 'main', 'next-feature');
			sinon.stub(pullRequest, 'getStatusChecks').resolves([null, null]);
			sinon.stub(nextPullRequest, 'getStatusChecks').resolves([null, null]);
			getPullRequests = sinon.stub(folderManager, 'getPullRequests');
		});

		it('serializes overlapping requests and reuses the cached result', async function () {
			let resolveFetch!: (result: ItemsResponseResult<PullRequestModel>) => void;
			const pendingFetch = new Promise<ItemsResponseResult<PullRequestModel>>(resolve => { resolveFetch = resolve; });
			let markStarted!: () => void;
			const started = new Promise<void>(resolve => { markStarted = resolve; });
			getPullRequests.onFirstCall().callsFake(() => {
				markStarted();
				return pendingFetch;
			});
			getPullRequests.onSecondCall().resolves({
				items: [],
				hasMorePages: false,
				hasUnsearchedRepositories: false,
			});

			const first = prsTreeModel.getAllPullRequests(folderManager, false);
			await started;
			const overlapping = prsTreeModel.getAllPullRequests(folderManager, false);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(getPullRequests.callCount, 1);
			const result: ItemsResponseResult<PullRequestModel> = {
				items: [pullRequest],
				hasMorePages: false,
				hasUnsearchedRepositories: false,
			};
			resolveFetch(result);

			const [firstResult, overlappingResult] = await Promise.all([first, overlapping]);
			assert.strictEqual(firstResult, result);
			assert.strictEqual(overlappingResult, result);
			assert.strictEqual(await prsTreeModel.getAllPullRequests(folderManager, false), result);
			assert.strictEqual(getPullRequests.callCount, 1);
		});

		it('fetches one page and shows a Load more node that loads the next page', async function () {
			sinon.stub(prsTreeModel, 'hasLoaded').get(() => true);
			getPullRequests.onCall(0).resolves({ items: [pullRequest], hasMorePages: true, hasUnsearchedRepositories: false });
			getPullRequests.onCall(1).resolves({ items: [pullRequest, nextPullRequest], hasMorePages: false, hasUnsearchedRepositories: false });
			const category = new CategoryTreeNode({} as any, folderManager, telemetry, PRType.All, mockNotificationsManager as NotificationsManager, prsTreeModel);

			const children = await category.getChildren();

			assert.strictEqual(getPullRequests.callCount, 1);
			assert.strictEqual(children.length, 2);
			assert.ok(children[0] instanceof PRNode);
			assert.ok(children[1] instanceof PRCategoryActionNode);
			assert.strictEqual((children[1] as PRCategoryActionNode).type, PRCategoryActionType.More);
			assert.strictEqual((children[1] as PRCategoryActionNode).command?.command, 'pr.loadMore');

			category.fetchNextPage = true;
			const children2 = await category.getChildren();

			assert.strictEqual(getPullRequests.callCount, 2);
			assert.strictEqual(children2.length, 2);
			assert.ok(children2[0] instanceof PRNode);
			assert.ok(children2[1] instanceof PRNode);
			assert.strictEqual(category.fetchNextPage, false);
		});

		it('releases the lock after a failed fetch so a queued request can succeed', async function () {
			let rejectFetch!: (error: Error) => void;
			const pendingFetch = new Promise<ItemsResponseResult<PullRequestModel>>((_, reject) => { rejectFetch = reject; });
			let markStarted!: () => void;
			const started = new Promise<void>(resolve => { markStarted = resolve; });
			getPullRequests.onFirstCall().callsFake(() => {
				markStarted();
				return pendingFetch;
			});
			const result: ItemsResponseResult<PullRequestModel> = {
				items: [pullRequest],
				hasMorePages: false,
				hasUnsearchedRepositories: false,
			};
			getPullRequests.onSecondCall().resolves(result);

			const error = new Error('Fetching pull requests failed');
			const failed = assert.rejects(prsTreeModel.getAllPullRequests(folderManager, false), error);
			await started;
			const retry = prsTreeModel.getAllPullRequests(folderManager, false);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(getPullRequests.callCount, 1);
			rejectFetch(error);

			await failed;
			assert.strictEqual(await retry, result);
			assert.strictEqual(await prsTreeModel.getAllPullRequests(folderManager, false), result);
			assert.strictEqual(getPullRequests.callCount, 2);
		});

		for (const cached of [false, true]) {
			for (const force of [false, true]) {
				it(`refetches after ${force ? 'force-clearing' : 'clearing'} ${cached ? 'an existing' : 'an initially empty'} cache during a fetch`, async function () {
					const oldResult: ItemsResponseResult<PullRequestModel> = {
						items: [pullRequest],
						hasMorePages: false,
						hasUnsearchedRepositories: false,
					};
					if (cached) {
						getPullRequests.resolves(oldResult);
						await prsTreeModel.getAllPullRequests(folderManager, false);
						getPullRequests.resetHistory();
					}

					let resolveFetch!: (result: ItemsResponseResult<PullRequestModel>) => void;
					const pendingFetch = new Promise<ItemsResponseResult<PullRequestModel>>(resolve => { resolveFetch = resolve; });
					let markStarted!: () => void;
					const started = new Promise<void>(resolve => { markStarted = resolve; });
					getPullRequests.onFirstCall().callsFake(() => {
						markStarted();
						return pendingFetch;
					});
					const freshResult: ItemsResponseResult<PullRequestModel> = {
						items: [nextPullRequest],
						hasMorePages: false,
						hasUnsearchedRepositories: false,
					};
					getPullRequests.onSecondCall().resolves(freshResult);

					const first = prsTreeModel.getAllPullRequests(folderManager, false, true);
					await started;
					if (force) {
						prsTreeModel.forceClearCache(true);
					} else {
						prsTreeModel.clearCache(true);
					}
					const refresh = prsTreeModel.getAllPullRequests(folderManager, false);
					await new Promise<void>(resolve => setImmediate(resolve));
					assert.strictEqual(getPullRequests.callCount, 1);
					resolveFetch(oldResult);

					assert.strictEqual(await first, oldResult);
					assert.strictEqual(await refresh, freshResult);
					assert.strictEqual(await prsTreeModel.getAllPullRequests(folderManager, false), freshResult);
					assert.strictEqual(getPullRequests.callCount, 2);
					if (force) {
						assert.strictEqual(prsTreeModel.hasPullRequest(pullRequest), false);
					}
					assert.strictEqual(prsTreeModel.hasPullRequest(nextPullRequest), true);
				});
			}
		}

		it('loads another folder independently while keeping requests in the first folder serialized', async function () {
			const otherFolderManager = new FolderRepositoryManager(1, context, new MockRepository(), telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			context.subscriptions.push(otherFolderManager);
			const otherResult: ItemsResponseResult<PullRequestModel> = {
				items: [nextPullRequest],
				hasMorePages: false,
				hasUnsearchedRepositories: false,
			};
			const getOtherPullRequests = sinon.stub(otherFolderManager, 'getPullRequests').resolves(otherResult);
			let resolveFetch!: (result: ItemsResponseResult<PullRequestModel>) => void;
			const pendingFetch = new Promise<ItemsResponseResult<PullRequestModel>>(resolve => { resolveFetch = resolve; });
			let markStarted!: () => void;
			const started = new Promise<void>(resolve => { markStarted = resolve; });
			getPullRequests.callsFake(() => {
				markStarted();
				return pendingFetch;
			});
			const first = prsTreeModel.getAllPullRequests(folderManager, false);
			await started;
			const overlapping = prsTreeModel.getAllPullRequests(folderManager, false);
			const other = prsTreeModel.getAllPullRequests(otherFolderManager, false);
			const firstResult: ItemsResponseResult<PullRequestModel> = {
				items: [pullRequest],
				hasMorePages: false,
				hasUnsearchedRepositories: false,
			};

			try {
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(getPullRequests.callCount, 1);
				assert.strictEqual(getOtherPullRequests.callCount, 1);
				assert.strictEqual(await other, otherResult);
				assert.strictEqual(await prsTreeModel.getAllPullRequests(otherFolderManager, false), otherResult);
				assert.strictEqual(getOtherPullRequests.callCount, 1);
			} finally {
				resolveFetch(firstResult);
				await Promise.all([first, overlapping, other]);
			}
			assert.strictEqual(await overlapping, firstResult);
			assert.strictEqual(getPullRequests.callCount, 1);
		});

		for (const loadMoreFirst of [true, false]) {
			it(loadMoreFirst ? 'preserves results when refreshing during load more' : 'preserves results when loading more during a refresh', async function () {
				getPullRequests.onFirstCall().resolves({
					items: [pullRequest],
					hasMorePages: true,
					hasUnsearchedRepositories: false,
				});
				await prsTreeModel.getAllPullRequests(folderManager, false);

				let resolveFetch!: (result: ItemsResponseResult<PullRequestModel>) => void;
				const pendingFetch = new Promise<ItemsResponseResult<PullRequestModel>>(resolve => { resolveFetch = resolve; });
				let markStarted!: () => void;
				const started = new Promise<void>(resolve => { markStarted = resolve; });
				getPullRequests.onSecondCall().callsFake(() => {
					markStarted();
					return pendingFetch;
				});
				getPullRequests.onThirdCall().resolves({
					items: loadMoreFirst ? [pullRequest, nextPullRequest] : [nextPullRequest],
					hasMorePages: false,
					hasUnsearchedRepositories: true,
					totalCount: 2,
				});

				const first = prsTreeModel.getAllPullRequests(folderManager, loadMoreFirst, !loadMoreFirst);
				await started;
				const overlapping = prsTreeModel.getAllPullRequests(folderManager, !loadMoreFirst, loadMoreFirst);
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(getPullRequests.callCount, 2);
				resolveFetch({
					items: loadMoreFirst ? [nextPullRequest] : [pullRequest],
					hasMorePages: !loadMoreFirst,
					hasUnsearchedRepositories: loadMoreFirst,
					totalCount: 2,
				});

				const [firstResult, overlappingResult] = await Promise.all([first, overlapping]);
				assert.deepStrictEqual(firstResult, {
					items: loadMoreFirst ? [pullRequest, nextPullRequest] : [pullRequest],
					hasMorePages: !loadMoreFirst,
					hasUnsearchedRepositories: loadMoreFirst,
					totalCount: 2,
				});
				assert.deepStrictEqual(overlappingResult, {
					items: [pullRequest, nextPullRequest],
					hasMorePages: false,
					hasUnsearchedRepositories: true,
					totalCount: 2,
				});
				assert.strictEqual(await prsTreeModel.getAllPullRequests(folderManager, false), overlappingResult);
				assert.deepStrictEqual(getPullRequests.getCalls().map(call => call.args), [
					[PRType.All, { fetchNextPage: false }],
					[PRType.All, { fetchNextPage: loadMoreFirst }],
					[PRType.All, { fetchNextPage: !loadMoreFirst }],
				]);
			});
		}

		describe('Refresh notifications', function () {
			let configurationChanged: vscode.EventEmitter<vscode.ConfigurationChangeEvent>;
			let onDidChangeTreeData: SinonSpy;
			let allCategory: CategoryTreeNode;
			let localCategory: CategoryTreeNode;

			beforeEach(async function () {
				configurationChanged = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
				context.subscriptions.push(configurationChanged);
				sinon.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake(configurationChanged.event);
				provider.dispose();
				provider = new PullRequestsTreeDataProvider(prsTreeModel, telemetry, context, reposManager);
				sinon.stub(credentialStore, 'isAuthenticated').returns(true);
				sinon.stub(reposManager, 'state').get(() => ReposManagerState.RepositoriesLoaded);
				const githubRepository = discoveredRepository;
				assert(githubRepository);
				sinon.stub(folderManager, 'gitHubRepositories').get(() => [githubRepository]);
				getPullRequests.resolves({
					items: [pullRequest, nextPullRequest],
					hasMorePages: false,
					hasUnsearchedRepositories: false,
				});
				sinon.stub(folderManager, 'getLocalPullRequests').resolves([pullRequest, nextPullRequest]);
				await prsTreeModel.getAllPullRequests(folderManager, false);
				provider.initialize([], mockNotificationsManager as NotificationsManager);
				const categories = await provider.getChildren();
				const all = categories.find(node => node instanceof CategoryTreeNode && node.type === PRType.All);
				const local = categories.find(node => node instanceof CategoryTreeNode && node.type === PRType.LocalPullRequest);
				assert(all instanceof CategoryTreeNode);
				assert(local instanceof CategoryTreeNode);
				allCategory = all;
				localCategory = local;
				context.subscriptions.push(...await allCategory.getChildren(), ...await localCategory.getChildren());
				await githubRepository.ensureCommentsController();
				onDidChangeTreeData = sinon.spy();
				context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));
			});

			it('refreshes once when the manual Refresh command clears the cache', async function () {
				const forceClearCache = sinon.spy(prsTreeModel, 'forceClearCache');
				const refreshCommand = (vscode.commands.registerCommand as SinonStub).getCalls()
					.filter(call => call.args[0] === 'pr.refreshList').pop();
				assert(refreshCommand);
				getPullRequests.resetHistory();

				refreshCommand.args[1]();

				assert.strictEqual(forceClearCache.callCount, 1);
				assert.strictEqual(onDidChangeTreeData.callCount, 1);
				assert.deepStrictEqual(onDidChangeTreeData.firstCall.args, [provider.children]);
				await prsTreeModel.getAllPullRequests(folderManager, false);
				assert.strictEqual(getPullRequests.callCount, 1);
			});

			it('loads fresh category children when manual Refresh supersedes an in-flight fetch', async function () {
				getPullRequests.resetHistory();
				let resolveFetch!: (result: ItemsResponseResult<PullRequestModel>) => void;
				const pendingFetch = new Promise<ItemsResponseResult<PullRequestModel>>(resolve => { resolveFetch = resolve; });
				let markStarted!: () => void;
				const started = new Promise<void>(resolve => { markStarted = resolve; });
				getPullRequests.onFirstCall().callsFake(() => {
					markStarted();
					return pendingFetch;
				});
				getPullRequests.onSecondCall().resolves({
					items: [nextPullRequest],
					hasMorePages: false,
					hasUnsearchedRepositories: false,
				});
				const first = prsTreeModel.getAllPullRequests(folderManager, false, true);
				await started;
				const refreshCommand = (vscode.commands.registerCommand as SinonStub).getCalls()
					.filter(call => call.args[0] === 'pr.refreshList').pop();
				assert(refreshCommand);

				refreshCommand.args[1]();
				const refresh = allCategory.getChildren();
				resolveFetch({
					items: [pullRequest],
					hasMorePages: false,
					hasUnsearchedRepositories: false,
				});
				await first;
				const children = await refresh;
				context.subscriptions.push(...children);

				assert.strictEqual(onDidChangeTreeData.callCount, 1);
				assert.strictEqual(getPullRequests.callCount, 2);
				assert.strictEqual(children.length, 1);
				assert(children[0] instanceof PRNode);
				assert.strictEqual(children[0].pullRequestModel, nextPullRequest);
				assert.strictEqual(prsTreeModel.hasPullRequest(pullRequest), false);
				assert.strictEqual(prsTreeModel.hasPullRequest(nextPullRequest), true);
			});

			for (const setting of ['githubPullRequests.showPullRequestNumberInTree', 'githubPullRequests.pullRequestAvatarDisplay']) {
				it(`refreshes once for ${setting}, regardless of the number of PR nodes`, function () {
					const clearCache = sinon.spy(prsTreeModel, 'clearCache');

					configurationChanged.fire({ affectsConfiguration: section => section === setting });

					assert.strictEqual(onDidChangeTreeData.callCount, 1);
					assert.deepStrictEqual(onDidChangeTreeData.firstCall.args, [undefined]);
					assert.strictEqual(clearCache.callCount, 0);
				});
			}

			it('does not refresh for unrelated settings', function () {
				configurationChanged.fire({ affectsConfiguration: section => section === 'editor.fontSize' });

				assert.strictEqual(onDidChangeTreeData.callCount, 0);
			});

			it('refreshes all affected PR copies in one event when switching checkouts', function () {
				const copiesOf = (model: PullRequestModel) => [allCategory, localCategory]
					.flatMap(category => category.children ?? [])
					.filter((node): node is PRNode => node instanceof PRNode && node.pullRequestModel.equals(model));
				const oldCopies = copiesOf(pullRequest);
				const newCopies = copiesOf(nextPullRequest);
				assert.strictEqual(oldCopies.length, 2);
				assert.strictEqual(newCopies.length, 2);
				const assertRefreshed = (expected: PRNode[]) => {
					assert.strictEqual(onDidChangeTreeData.callCount, 1);
					const refreshed = onDidChangeTreeData.firstCall.args[0];
					assert(Array.isArray(refreshed));
					assert.strictEqual(refreshed.length, expected.length);
					assert(expected.every(node => refreshed.includes(node)));
				};

				folderManager.activePullRequest = pullRequest;
				assertRefreshed(oldCopies);
				onDidChangeTreeData.resetHistory();

				folderManager.activePullRequest = nextPullRequest;
				assertRefreshed([...oldCopies, ...newCopies]);
				assert.strictEqual(pullRequest.isActive, false);
				assert.strictEqual(nextPullRequest.isActive, true);
				onDidChangeTreeData.resetHistory();

				folderManager.activePullRequest = nextPullRequest;
				assert.strictEqual(onDidChangeTreeData.callCount, 0);
				folderManager.activePullRequest = undefined;
				assertRefreshed(newCopies);
			});
		});
	});

	it('clears the tree immediately', async function () {
		const repository = new MockRepository();
		await repository.addRemote('origin', 'git@github.com:aaa/bbb');
		const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
		stubRepositoryDiscovery(folderManager);
		sinon.stub(folderManager, 'getPullRequestDefaults').resolves({ owner: 'aaa', repo: 'bbb', base: 'main' });
		reposManager.insertFolderManager(folderManager);
		sinon.stub(credentialStore, 'isAuthenticated').returns(true);
		await folderManager.updateRepositories();
		provider.initialize([], mockNotificationsManager as NotificationsManager);
		await provider.getChildren();
		const onDidChangeTreeData = sinon.spy();
		provider.onDidChangeTreeData(onDidChangeTreeData);

		provider.clear();

		assert.deepStrictEqual(await provider.cachedChildren(), []);
		assert(onDidChangeTreeData.calledOnce);
	});

	it('refreshes tree when GitHub repositories are discovered in existing folder manager', async function () {
		const repository = new MockRepository();
		await repository.addRemote('origin', 'git@github.com:aaa/bbb');
		const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
		stubRepositoryDiscovery(folderManager);
		sinon.stub(folderManager, 'getPullRequestDefaults').returns(Promise.resolve({ owner: 'aaa', repo: 'bbb', base: 'main' }));
		reposManager.insertFolderManager(folderManager);
		provider.initialize([], mockNotificationsManager as NotificationsManager);

		// Initially no children because no GitHub repositories are loaded yet
		let rootNodes = await provider.getChildren();
		assert.strictEqual(rootNodes.length, 0);

		// Listen to the prsTreeModel's onDidChangeData event which is what actually drives the tree refresh
		const onDidChangeDataSpy = sinon.spy();
		provider.prsTreeModel.onDidChangeData(onDidChangeDataSpy);

		// Simulate GitHub repositories being discovered (as happens when remotes load after activation)
		sinon.stub(credentialStore, 'isAuthenticated').returns(true);
		await folderManager.updateRepositories();

		// Verify that the tree model's data change event was triggered
		assert(onDidChangeDataSpy.calledWith(folderManager),
			'Tree model should fire data change event with the folder manager when GitHub repositories are discovered');

		// Verify tree now has content
		rootNodes = await provider.getChildren();
		const treeItems = await Promise.all(rootNodes.map(node => node.getTreeItem()));
		assert.deepStrictEqual(
			treeItems.map(n => n.label),
			['Copilot on My Behalf', 'Local Pull Request Branches', 'Waiting For My Review', 'Created By Me', 'All Open'],
			'Tree should display categories after GitHub repositories are discovered',
		);
	});

	describe('Query groupBy', function () {
		let folderManager: FolderRepositoryManager;
		let repoAaa: MockGitHubRepository;
		let repoCcc: MockGitHubRepository;
		let prA1: PullRequestModel;
		let prB1: PullRequestModel;
		let prA2: PullRequestModel;
		let getPullRequestsForQuery: SinonStub;

		beforeEach(function () {
			const repository = new MockRepository();
			folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			reposManager.insertFolderManager(folderManager);
			repoAaa = new MockGitHubRepository(new GitHubRemote('origin', 'https://github.com/aaa/bbb', new Protocol('https://github.com/aaa/bbb'), GitHubServerType.GitHubDotCom), credentialStore, telemetry, sinon);
			repoCcc = new MockGitHubRepository(new GitHubRemote('origin', 'https://github.com/ccc/ddd', new Protocol('https://github.com/ccc/ddd'), GitHubServerType.GitHubDotCom), credentialStore, telemetry, sinon);
			prA1 = stackablePullRequest(repoAaa, 1, 'main', 'feature-1');
			prB1 = stackablePullRequest(repoCcc, 2, 'main', 'feature-2');
			prA2 = stackablePullRequest(repoAaa, 3, 'main', 'feature-3');
			getPullRequestsForQuery = sinon.stub(prsTreeModel, 'getPullRequestsForQuery').resolves({
				items: [prA1, prB1, prA2],
				hasMorePages: false,
				hasUnsearchedRepositories: false,
			});
			// The setter lets the real getPullRequestsForQuery assign hasLoaded in the pagination tests.
			sinon.stub(prsTreeModel, 'hasLoaded').get(() => true).set(() => { });
		});

		afterEach(function () {
			repoAaa.dispose();
			repoCcc.dispose();
		});

		function createQueryCategory(groupBy?: unknown): CategoryTreeNode {
			const parent = {} as any;
			return new CategoryTreeNode(parent, folderManager, telemetry, PRType.Query, mockNotificationsManager as NotificationsManager, prsTreeModel, 'Test Query', 'is:open', groupBy);
		}

		// Rebuilds the model and provider so PR changes can be fired through reposManager, and roots the category under the provider.
		function createProviderWithCategory(groupBy?: unknown): { changes: vscode.EventEmitter<PullRequestChangeEvent[]>; category: CategoryTreeNode } {
			const changes = new vscode.EventEmitter<PullRequestChangeEvent[]>();
			context.subscriptions.push(changes);
			sinon.stub(reposManager, 'onDidChangeAnyPullRequests').callsFake(changes.event);
			provider.dispose();
			prsTreeModel.dispose();
			prsTreeModel = new PrsTreeModel(telemetry, reposManager, context);
			sinon.stub(prsTreeModel, 'getPullRequestsForQuery').resolves({
				items: [prA1, prB1, prA2],
				hasMorePages: false,
				hasUnsearchedRepositories: false,
			});
			sinon.stub(prsTreeModel, 'hasLoaded').get(() => true);
			provider = new PullRequestsTreeDataProvider(prsTreeModel, telemetry, context, reposManager);
			const category = createQueryCategory(groupBy);
			(provider as any)._children = [category];
			return { changes, category };
		}

		// Runs the real update path for one PR with REST data that renames its milestone while keeping the node_id.
		function renameMilestoneOverRest(changes: vscode.EventEmitter<PullRequestChangeEvent[]>, pullRequest: PullRequestModel, head: string, title: string): void {
			context.subscriptions.push(pullRequest.onDidChange(event => changes.fire([{ model: pullRequest, event }])));
			const rest = stackableRestPullRequest(repoAaa, pullRequest.number, 'main', head);
			rest.milestone!.title = title;
			pullRequest.update(convertRESTPullRequestToRawPullRequest(rest, repoAaa));
		}

		it('groups query results under owner/repo nodes', async function () {
			const category = createQueryCategory(['repository']);
			const children = await category.getChildren();
			assert.deepStrictEqual(children.map(child => child.label), ['aaa/bbb', 'ccc/ddd']);
			assert.ok(children.every(child => child instanceof PRGroupTreeNode));

			const aaaGroupChildren = await (children[0] as PRGroupTreeNode).getChildren(false);
			assert.ok(aaaGroupChildren.every(child => child instanceof PRNode));
			assert.deepStrictEqual((aaaGroupChildren as PRNode[]).map(child => child.pullRequestModel.number), [prA1.number, prA2.number]);

			const cccGroupChildren = await (children[1] as PRGroupTreeNode).getChildren(false);
			assert.deepStrictEqual((cccGroupChildren as PRNode[]).map(child => child.pullRequestModel.number), [prB1.number]);
		});

		it('produces flat PRNodes when groupBy is absent', async function () {
			const category = createQueryCategory();
			const children = await category.getChildren();
			assert.strictEqual(children.length, 3);
			assert.ok(children.every(child => child instanceof PRNode));
			assert.deepStrictEqual((children as PRNode[]).map(child => child.pullRequestModel.number), [prA1.number, prB1.number, prA2.number]);
		});

		it('ignores unknown and duplicate groupBy values', async function () {
			const category = createQueryCategory(['label', 'repository', 'repository']);
			const children = await category.getChildren();
			assert.deepStrictEqual(children.map(child => child.label), ['aaa/bbb', 'ccc/ddd']);
			const aaaGroupChildren = await (children[0] as PRGroupTreeNode).getChildren(false);
			assert.ok(aaaGroupChildren.every(child => child instanceof PRNode));
		});

		it('requests all pages and shows only group nodes', async function () {
			// Page draining happens inside PrsTreeModel, so this stub is only called once; that behavior is covered by prsTreeModel.test.ts.
			getPullRequestsForQuery.onFirstCall().resolves({
				items: [prA1, prB1, prA2],
				hasMorePages: true,
				hasUnsearchedRepositories: false,
			});
			const category = createQueryCategory(['repository']);
			const children = await category.getChildren();
			assert.strictEqual(getPullRequestsForQuery.lastCall.lastArg, true);
			assert.strictEqual(children.length, 2);
			assert.ok(children[0] instanceof PRGroupTreeNode);
			assert.ok(children[1] instanceof PRGroupTreeNode);
			assert.ok(children.every(child => !(child instanceof PRCategoryActionNode)));
		});

		it('does not build children of unexpanded groups when collecting PR nodes', async function () {
			const category = createQueryCategory(['repository']);
			const groups = await category.getChildren() as PRGroupTreeNode[];
			assert.deepStrictEqual(collectPRNodes(category), []);
			assert.ok(groups.every(group => group.children === undefined));

			const aaaChildren = await groups[0].getChildren();
			const collected = collectPRNodes(category);
			assert.strictEqual(collected.length, aaaChildren.length);
			collected.forEach((node, i) => assert.strictEqual(node, aaaChildren[i]));
		});

		it('finds pull request nodes inside groups using PullRequestModel.equals', async function () {
			const category = createQueryCategory(['repository']);
			const groups = await category.getChildren() as PRGroupTreeNode[];
			const sameNumberOtherRepo = stackablePullRequest(repoCcc, prA1.number, 'main', 'other');
			assert.strictEqual(await findPullRequestNode(groups, sameNumberOtherRepo), undefined);
			assert.ok(groups.every(group => group.children === undefined), 'no group may be materialized when the PR is not found');
			const found = await findPullRequestNode(groups, prB1);
			assert.ok(found);
			assert.strictEqual(found!.pullRequestModel, prB1);
			assert.strictEqual(groups[0].children, undefined, 'skipped group must not be materialized');
		});

		it('reuses cached group children so revealed nodes keep their identity', async function () {
			const category = createQueryCategory(['repository']);
			const children = await category.getChildren() as PRGroupTreeNode[];
			const found = await findPullRequestNode(children, prB1);
			assert.ok(found);
			// getChildren with default shouldDispose=true must return the same cached instances
			const again = await (children[1] as PRGroupTreeNode).getChildren();
			assert.strictEqual(again[0], found);
			// A second call also returns the same array
			const third = await (children[1] as PRGroupTreeNode).getChildren();
			assert.strictEqual(third, again);
		});

		it('refreshes a grouped category when a PR in an unexpanded group changes state', async function () {
			const { changes, category } = createProviderWithCategory(['repository']);
			await category.getChildren();
			const onDidChangeTreeData = sinon.spy();
			context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));

			changes.fire([{ model: prB1, event: { state: true } }]);

			sinon.assert.calledOnce(onDidChangeTreeData);
			assert.ok((onDidChangeTreeData.firstCall.args[0] as unknown[]).includes(category));
		});

		it('rebuilds milestone groups when a PR\'s milestone changes', async function () {
			const milestone1 = { id: 'milestone-1', title: 'v1', createdAt: '', number: 1 };
			const milestone2 = { id: 'milestone-2', title: 'v2', createdAt: '', number: 2 };
			prA1.milestone = milestone1;
			prA2.milestone = milestone1;
			prB1.milestone = milestone2;
			const { changes, category } = createProviderWithCategory(['milestone']);
			await category.getChildren();
			const onDidChangeTreeData = sinon.spy();
			context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));

			prA1.milestone = milestone2;
			changes.fire([{ model: prA1, event: { milestone: true } }]);

			sinon.assert.calledOnce(onDidChangeTreeData);
			assert.deepStrictEqual(onDidChangeTreeData.firstCall.args[0], [category]);
		});

		it('refreshes only the row for milestone changes when not grouped by milestone', async function () {
			const { changes, category } = createProviderWithCategory(['repository']);
			const groups = await category.getChildren() as PRGroupTreeNode[];
			await groups[0].getChildren();
			const onDidChangeTreeData = sinon.spy();
			context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));

			changes.fire([{ model: prA1, event: { milestone: true } }]);

			sinon.assert.calledOnce(onDidChangeTreeData);
			const refreshed = onDidChangeTreeData.firstCall.args[0] as TreeNode[];
			assert.strictEqual(refreshed.length, 1);
			assert.ok(refreshed[0] instanceof PRNode);
			assert.strictEqual((refreshed[0] as PRNode).pullRequestModel, prA1);
			onDidChangeTreeData.resetHistory();

			changes.fire([{ model: prB1, event: { milestone: true } }]);

			sinon.assert.notCalled(onDidChangeTreeData);
		});

		it('keeps milestone groups when All Open refreshes shared models over REST', async function () {
			const milestone = { id: 'milestone0', title: 'milestone title', createdAt: '2019-01-01T10:00:00Z', number: 100 };
			prA1.milestone = milestone;
			prA2.milestone = milestone;
			prB1.milestone = milestone;
			const { changes, category } = createProviderWithCategory(['milestone']);
			await category.getChildren();
			// Prime the milestone title map before observing rebuilds. The first milestoneConfirmed
			// for an unrecorded milestone ID is treated as a change (undefined -> title). Priming here
			// means the actual test update sees an already-recorded title and does not rebuild.
			changes.fire([{ model: prA1, event: { milestoneConfirmed: true } }]);
			const onDidChangeTreeData = sinon.spy();
			context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));

			// Forward real model events into the stubbed changes emitter (simulating folderManager).
			const modelEvents: IssueChangeEvent[] = [];
			context.subscriptions.push(prA1.onDidChange(event => {
				modelEvents.push(event);
				changes.fire([{ model: prA1, event }]);
			}));

			// Run the real update path with REST data that has the same milestone node_id.
			const raw = convertRESTPullRequestToRawPullRequest(stackableRestPullRequest(repoAaa, prA1.number, 'main', 'feature-1'), repoAaa);
			assert.strictEqual(raw.milestone?.id, milestone.id);
			prA1.update(raw);

			// No { milestone: true } event must have fired - the category must not rebuild.
			assert.ok(modelEvents.every(event => !event.milestone), 'REST refresh must not report a milestone change');
			assert.ok(onDidChangeTreeData.getCalls().every(call => !(call.args[0] as unknown[]).includes(category)));
			assert.strictEqual(prA1.milestone?.id, milestone.id);
		});

		it('uses the renamed milestone title when only a later PR in the group is updated', async function () {
			const milestone = { id: 'milestone0', title: 'milestone title', createdAt: '2019-01-01T10:00:00Z', number: 100 };
			prA1.milestone = milestone;
			prA2.milestone = milestone;
			prB1.milestone = milestone;
			const { changes, category } = createProviderWithCategory(['milestone']);
			const before = await category.getChildren() as PRGroupTreeNode[];
			assert.deepStrictEqual(before.map(group => group.label), ['milestone title']);
			const onDidChangeTreeData = sinon.spy();
			context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));

			renameMilestoneOverRest(changes, prA2, 'feature-3', 'renamed milestone');

			sinon.assert.calledOnce(onDidChangeTreeData);
			assert.deepStrictEqual(onDidChangeTreeData.firstCall.args[0], [category]);
			assert.strictEqual(prA1.milestone?.title, 'milestone title');
			const after = await category.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(after[0].label, 'renamed milestone');
			const again = await category.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(again[0].label, 'renamed milestone');
		});

		it('uses the renamed milestone title when only a middle PR in the group is updated', async function () {
			const milestone = { id: 'milestone0', title: 'milestone title', createdAt: '2019-01-01T10:00:00Z', number: 100 };
			prA1.milestone = milestone;
			prA2.milestone = milestone;
			prB1.milestone = milestone;
			const { changes, category } = createProviderWithCategory(['milestone']);
			const before = await category.getChildren() as PRGroupTreeNode[];
			assert.deepStrictEqual(before.map(group => group.label), ['milestone title']);
			const onDidChangeTreeData = sinon.spy();
			context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));

			// prB1 is second in query order [prA1, prB1, prA2]; the label must follow the rename event on prB1, not which PR is seen first
			renameMilestoneOverRest(changes, prB1, 'feature-2', 'renamed milestone');

			sinon.assert.calledOnce(onDidChangeTreeData);
			assert.deepStrictEqual(onDidChangeTreeData.firstCall.args[0], [category]);
			assert.strictEqual(prA1.milestone?.title, 'milestone title');
			assert.strictEqual(prA2.milestone?.title, 'milestone title');
			const after = await category.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(after[0].label, 'renamed milestone');
			const again = await category.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(again[0].label, 'renamed milestone');
		});

		it('restores the original title when the milestone is renamed back', async function () {
			const milestone = { id: 'milestone0', title: 'milestone title', createdAt: '2019-01-01T10:00:00Z', number: 100 };
			prA1.milestone = milestone;
			prA2.milestone = milestone;
			prB1.milestone = milestone;
			const { changes, category } = createProviderWithCategory(['milestone']);
			await category.getChildren();

			// Rename prB1 forward
			renameMilestoneOverRest(changes, prB1, 'feature-2', 'renamed milestone');
			const after = await category.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(after[0].label, 'renamed milestone');

			// Rename prB1 back - use update() directly to avoid double-subscribing
			const rest2 = stackableRestPullRequest(repoCcc, prB1.number, 'main', 'feature-2');
			rest2.milestone!.title = 'milestone title';
			prB1.update(convertRESTPullRequestToRawPullRequest(rest2, repoCcc));

			const restored = await category.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(restored[0].label, 'milestone title');
			const again = await category.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(again[0].label, 'milestone title');
		});

		it('restores the original title when only a different PR is refreshed without a milestone event', async function () {
			// Scenario: rename milestone v1->v2 (B refreshed), then rename back v2->v1 (only A refreshed).
			// A already had v1 locally, so no { milestone: true } fires for A.
			// A state change fires instead; doUpdate also fires { milestoneConfirmed: true } because A's
			// milestone is present and unchanged. The handler records A's v1 and the label corrects itself.
			// Without the fix, the map retains v2 and the label stays 'renamed milestone'.
			const milestone = { id: 'milestone0', title: 'milestone title', createdAt: '2019-01-01T10:00:00Z', number: 100 };
			prA1.milestone = milestone;
			prA2.milestone = milestone;
			prB1.milestone = milestone;
			const { changes, category } = createProviderWithCategory(['milestone']);
			await category.getChildren();
			const onDidChangeTreeData = sinon.spy();
			context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));

			// Rename forward (via prB1) - fires { milestone: true } from B
			renameMilestoneOverRest(changes, prB1, 'feature-2', 'renamed milestone');
			sinon.assert.calledOnce(onDidChangeTreeData);
			const afterRename = await category.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(afterRename[0].label, 'renamed milestone');
			onDidChangeTreeData.resetHistory();

			// Rename back to original title, but refresh prA1 (which never saw the rename).
			// prA1.milestone is still { id: 'milestone0', title: 'milestone title' }, so update() with
			// matching milestone data fires no { milestone: true }. We change its state instead.
			context.subscriptions.push(prA1.onDidChange(event => changes.fire([{ model: prA1, event }])));
			const restWithStateChange = stackableRestPullRequest(repoAaa, prA1.number, 'main', 'feature-1');
			restWithStateChange.state = 'closed';
			prA1.update(convertRESTPullRequestToRawPullRequest(restWithStateChange, repoAaa));

			// The state event triggers a category rebuild. The fix ensures prA1's milestone title
			// (still 'milestone title') is recorded in the map even though no milestone event fired.
			sinon.assert.calledOnce(onDidChangeTreeData);
			const afterRenameBack = await category.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(afterRenameBack[0].label, 'milestone title');
			const again = await category.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(again[0].label, 'milestone title');
		});

		it('does not overwrite a renamed milestone title when a timeline event fires on the stale PR', async function () {
			// After B fires { milestone: true } recording 'renamed milestone', a { timeline: true }
			// event on A (e.g., from a new comment) must not overwrite the map with A's stale title.
			// { timeline: true } comes from IssueModel directly, not from doUpdate, so milestoneConfirmed
			// is not set - the handler must ignore it.
			const milestone = { id: 'milestone0', title: 'milestone title', createdAt: '2019-01-01T10:00:00Z', number: 100 };
			prA1.milestone = milestone;
			prB1.milestone = milestone;
			const { changes } = createProviderWithCategory(['milestone']);

			renameMilestoneOverRest(changes, prB1, 'feature-2', 'renamed milestone');
			assert.strictEqual(prsTreeModel.getMilestoneTitle('milestone0'), 'renamed milestone');

			// Fire a timeline event for prA1 (which still has the old title locally)
			changes.fire([{ model: prA1, event: { timeline: true } }]);

			assert.strictEqual(
				prsTreeModel.getMilestoneTitle('milestone0'),
				'renamed milestone',
				'timeline event must not overwrite the canonical milestone title with stale data',
			);
		});

		it('does not overwrite a renamed milestone title when a stack-only update arrives for a stale PR', async function () {
			const milestone = { id: 'milestone0', title: 'milestone title', createdAt: '2019-01-01T10:00:00Z', number: 100 };
			prA1.milestone = milestone;
			prB1.milestone = milestone;
			const { changes } = createProviderWithCategory(['milestone']);
			context.subscriptions.push(prA1.onDidChange(event => changes.fire([{ model: prA1, event }])));

			// prB1 gets a REST refresh with a renamed milestone
			renameMilestoneOverRest(changes, prB1, 'feature-2', 'renamed milestone');
			assert.strictEqual(prsTreeModel.getMilestoneTitle('milestone0'), 'renamed milestone');

			// prA1 sends a stack-only update (same milestone reference - must not overwrite)
			prA1.update({ ...prA1.item, stack: null });
			assert.strictEqual(prsTreeModel.getMilestoneTitle('milestone0'), 'renamed milestone',
				'stack-only update from a stale PR must not revert the renamed milestone title');
		});

		it('keeps the renamed milestone title after the category node is recreated', async function () {
			const milestone = { id: 'milestone0', title: 'milestone title', createdAt: '2019-01-01T10:00:00Z', number: 100 };
			prA1.milestone = milestone;
			prA2.milestone = milestone;
			prB1.milestone = milestone;
			const { changes, category } = createProviderWithCategory(['milestone']);
			await category.getChildren();

			renameMilestoneOverRest(changes, prB1, 'feature-2', 'renamed milestone');
			assert.strictEqual(prA1.milestone?.title, 'milestone title');

			// Simulate root rebuild: dispose old category, create a fresh one
			category.dispose();
			const replacement = createQueryCategory(['milestone']);
			(provider as any)._children = [replacement];

			const groups = await replacement.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(groups[0].label, 'renamed milestone');
		});

		it('rebuilds a milestone group when the rename arrives through a PR outside the category', async function () {
			const milestone = { id: 'milestone0', title: 'milestone title', createdAt: '2019-01-01T10:00:00Z', number: 100 };
			prA1.milestone = milestone;
			prA2.milestone = milestone;
			prB1.milestone = milestone;
			const outside = stackablePullRequest(repoCcc, 4, 'main', 'feature-4');
			outside.milestone = milestone;

			const { changes, category } = createProviderWithCategory(['milestone']);
			await category.getChildren();
			assert.ok(!category.prs.has(outside.id), 'outside PR must not be in this category');

			const onDidChangeTreeData = sinon.spy();
			context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));

			renameMilestoneOverRest(changes, outside, 'feature-4', 'renamed milestone');

			sinon.assert.calledOnce(onDidChangeTreeData);
			assert.deepStrictEqual(onDidChangeTreeData.firstCall.args[0], [category]);
			const groups = await category.getChildren() as PRGroupTreeNode[];
			assert.strictEqual(groups[0].label, 'renamed milestone');
		});

		it('does not rebuild when an outside PR renames an unrelated milestone', async function () {
			const otherMilestone = { id: 'milestone-other', title: 'other', createdAt: '', number: 2 };
			prA1.milestone = otherMilestone;
			prA2.milestone = otherMilestone;
			prB1.milestone = otherMilestone;
			const outside = stackablePullRequest(repoCcc, 4, 'main', 'feature-4');
			outside.milestone = { id: 'milestone0', title: 'milestone title', createdAt: '2019-01-01T10:00:00Z', number: 100 };

			const { changes, category } = createProviderWithCategory(['milestone']);
			await category.getChildren();

			const onDidChangeTreeData = sinon.spy();
			context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));

			renameMilestoneOverRest(changes, outside, 'feature-4', 'renamed milestone');

			sinon.assert.notCalled(onDidChangeTreeData);
		});

		it('forgets recorded milestone titles after a forced cache clear', async function () {
			const milestone = { id: 'milestone0', title: 'milestone title', createdAt: '2019-01-01T10:00:00Z', number: 100 };
			prA1.milestone = milestone;
			const { changes } = createProviderWithCategory(['milestone']);

			renameMilestoneOverRest(changes, prA1, 'feature-1', 'renamed milestone');
			assert.strictEqual(prsTreeModel.getMilestoneTitle('milestone0'), 'renamed milestone');

			prsTreeModel.forceClearCache(true);
			assert.strictEqual(prsTreeModel.getMilestoneTitle('milestone0'), undefined);
		});

		it('keeps milestones with the same title in separate groups', async function () {
			prA1.milestone = { id: 'milestone-a', title: 'v1', createdAt: '', number: 1 };
			prA2.milestone = { id: 'milestone-a', title: 'v1', createdAt: '', number: 1 };
			prB1.milestone = { id: 'milestone-b', title: 'v1', createdAt: '', number: 2 };
			const category = createQueryCategory(['milestone']);

			const children = await category.getChildren() as PRGroupTreeNode[];

			assert.strictEqual(children.length, 2);
			assert.ok(children.every(c => c instanceof PRGroupTreeNode));
			assert.deepStrictEqual(children.map(c => c.label), ['v1', 'v1']);
			assert.notStrictEqual(children[0].id, children[1].id);
			assert.ok(children[0].id!.endsWith(':milestone-a'));
			assert.ok(children[1].id!.endsWith(':milestone-b'));
			assert.deepStrictEqual((await children[0].getChildren(false) as PRNode[]).map(n => n.pullRequestModel.number), [prA1.number, prA2.number]);
			assert.deepStrictEqual((await children[1].getChildren(false) as PRNode[]).map(n => n.pullRequestModel.number), [prB1.number]);
		});

		it('throws when PRGroupTreeNode is constructed without a parent id', async function () {
			const category = createQueryCategory(['repository']);
			await category.getChildren();
			assert.throws(
				() => new PRGroupTreeNode({} as any, category, 0, 'k', 'k', [], prsTreeModel),
				/requires a parent with an id/,
			);
		});

		it('groups a query whose label is an empty string', async function () {
			const category = new CategoryTreeNode({} as any, folderManager, telemetry, PRType.Query, mockNotificationsManager as NotificationsManager, prsTreeModel, '', 'is:open', ['repository']);
			assert.strictEqual(category.id, '');
			const children = await category.getChildren();
			assert.deepStrictEqual(children.map((c: TreeNode) => c.label), ['aaa/bbb', 'ccc/ddd']);
			assert.deepStrictEqual(children.map((c: TreeNode) => c.id), ['/repository:aaa/bbb', '/repository:ccc/ddd']);
		});

		describe('pagination with groupBy', function () {
			function useRealQueryPagination() {
				// Restore the stub so the real getPullRequestsForQuery runs.
				// It calls folderManager.getPullRequests, which we control below.
				getPullRequestsForQuery.restore();
				sinon.stub(folderManager, 'getPullRequestDefaults').resolves({ owner: 'aaa', repo: 'bbb', base: 'main' });
				// Suppress background status-check calls
				for (const pr of [prA1, prB1, prA2]) {
					sinon.stub(pr, 'getStatusChecks').resolves([null, null]);
				}
				return sinon.stub(folderManager, 'getPullRequests');
			}

			it('loads every page of a grouped query and places each PR under its repository group', async function () {
				const getPRs = useRealQueryPagination();
				getPRs.onCall(0).resolves({ items: [prA1], hasMorePages: true, hasUnsearchedRepositories: false, paginationProgress: 1 });
				getPRs.onCall(1).resolves({ items: [prB1], hasMorePages: false, hasUnsearchedRepositories: true, paginationProgress: 2 });
				getPRs.onCall(2).resolves({ items: [prA2], hasMorePages: false, hasUnsearchedRepositories: false, paginationProgress: 3 });

				const category = createQueryCategory(['repository']);
				const children = await category.getChildren();

				// All three pages were fetched
				assert.strictEqual(getPRs.callCount, 3);
				// Children are group nodes, not flat PR nodes
				assert.ok(children.every(c => c instanceof PRGroupTreeNode), 'expected PRGroupTreeNode children');
				assert.ok(children.every(c => !(c instanceof PRCategoryActionNode)), 'grouped category must not append action nodes even when hasMorePages is true');
				const groups = children as PRGroupTreeNode[];
				const labels = groups.map(g => g.label);
				assert.deepStrictEqual(labels.sort(), ['aaa/bbb', 'ccc/ddd']);
				const aaaBbb = groups.find(g => g.label === 'aaa/bbb')!;
				const cccDdd = groups.find(g => g.label === 'ccc/ddd')!;
				const aaaChildren = await aaaBbb.getChildren();
				const cccChildren = await cccDdd.getChildren();
				assert.deepStrictEqual(aaaChildren.map((n: any) => n.pullRequestModel), [prA1, prA2]);
				assert.deepStrictEqual(cccChildren.map((n: any) => n.pullRequestModel), [prB1]);

				// A second render uses the cache - no extra fetch calls
				await category.getChildren();
				assert.strictEqual(getPRs.callCount, 3);
			});

			it('continues an incomplete cached first page and groups the PRs from every page', async function () {
				const getPRs = useRealQueryPagination();
				getPRs.onCall(0).resolves({ items: [prA1], hasMorePages: true, hasUnsearchedRepositories: false, paginationProgress: 1 });
				getPRs.onCall(1).resolves({ items: [prB1, prA2], hasMorePages: false, hasUnsearchedRepositories: false, paginationProgress: 2 });

				// Pre-warm the cache with one page that reports hasMorePages: true, as would happen after a cap stop or initial single-page load.
				await prsTreeModel.getPullRequestsForQuery(folderManager, false, 'is:open');
				assert.strictEqual(getPRs.callCount, 1);

				const category = createQueryCategory(['repository']);
				const children = await category.getChildren();

				// Continued from the cached position - no restart
				assert.strictEqual(getPRs.callCount, 2);
				const groups = children as PRGroupTreeNode[];
				const aaaBbb = groups.find(g => g.label === 'aaa/bbb')!;
				const cccDdd = groups.find(g => g.label === 'ccc/ddd')!;
				assert.ok(aaaBbb, 'expected aaa/bbb group');
				assert.ok(cccDdd, 'expected ccc/ddd group');
				const aaaChildren = await aaaBbb.getChildren();
				const cccChildren = await cccDdd.getChildren();
				assert.ok(aaaChildren.map((n: any) => n.pullRequestModel).includes(prA1), 'prA1 must come from the cached page, not a restart');
				assert.deepStrictEqual(aaaChildren.map((n: any) => n.pullRequestModel), [prA1, prA2]);
				assert.deepStrictEqual(cccChildren.map((n: any) => n.pullRequestModel), [prB1]);
			});

			it('fetches one page for an ungrouped query and shows a Load more node', async function () {
				const getPRs = useRealQueryPagination();
				getPRs.onCall(0).resolves({ items: [prA1], hasMorePages: true, hasUnsearchedRepositories: false, paginationProgress: 1 });
				getPRs.onCall(1).resolves({ items: [prA1, prB1, prA2], hasMorePages: false, hasUnsearchedRepositories: false, paginationProgress: 2 });

				const category = createQueryCategory([]);
				const children = await category.getChildren();

				assert.strictEqual(getPRs.callCount, 1, 'only one page on first render');
				assert.ok(children[children.length - 1] instanceof PRCategoryActionNode, 'last child should be Load more');
				assert.strictEqual((children[children.length - 1] as PRCategoryActionNode).type, PRCategoryActionType.More);

				category.fetchNextPage = true;
				const children2 = await category.getChildren();

				assert.strictEqual(getPRs.callCount, 2, 'second page loaded on demand');
				assert.ok(children2.every(c => c instanceof PRNode), 'all PRNodes after loading more');
			});

			it('shows Continue fetching from other remotes for an ungrouped query with unsearched repositories', async function () {
				const getPRs = useRealQueryPagination();
				getPRs.onCall(0).resolves({ items: [prA1], hasMorePages: false, hasUnsearchedRepositories: true, paginationProgress: 1 });

				const category = createQueryCategory([]);
				const children = await category.getChildren();

				assert.strictEqual(getPRs.callCount, 1);
				const last = children[children.length - 1];
				assert.ok(last instanceof PRCategoryActionNode);
				assert.strictEqual((last as PRCategoryActionNode).type, PRCategoryActionType.TryOtherRemotes);
			});
		});

		describe('reveal inside groups', function () {
			it('selects a grouped PR node when its overview becomes active', async function () {
				const { category } = createProviderWithCategory(['repository']);
				category.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
				const groups = await category.getChildren() as PRGroupTreeNode[];
				const reveal = sinon.spy(provider.view, 'reveal');

				await (provider as any).syncWithActivePullRequest(prB1);

				sinon.assert.calledOnce(reveal);
				const revealedNode = reveal.args[0][0] as any;
				const revealOpts = reveal.args[0][1];
				assert.ok(revealedNode.pullRequestModel === prB1, 'revealed node should be prB1');
				assert.deepStrictEqual(revealOpts, { select: true, focus: false, expand: false });
				// The aaa/bbb group was not materialized during the search
				const aaaBbb = groups.find(g => g.label === 'aaa/bbb')!;
				assert.ok(!(aaaBbb as any)._children, 'unrelated group should not be materialized');
			});

			it('reveals a PR nested two group levels deep', async function () {
				const milestone1 = { id: 'milestone-1', title: 'v1', createdAt: '', number: 1 };
				const milestone2 = { id: 'milestone-2', title: 'v2', createdAt: '', number: 2 };
				prA1.milestone = milestone1;
				prB1.milestone = milestone1;
				prA2.milestone = milestone2;

				const { category } = createProviderWithCategory(['milestone', 'repository']);
				category.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
				await category.getChildren();
				const reveal = sinon.spy(provider.view, 'reveal');

				await (provider as any).syncWithActivePullRequest(prB1);

				sinon.assert.calledOnce(reveal);
				const revealedNode = reveal.args[0][0] as any;
				assert.ok(revealedNode.pullRequestModel === prB1);
				// Verify parent chain: ccc/ddd group → v1 milestone group → category
				const cccDddGroup = await provider.getParent(revealedNode);
				assert.ok((cccDddGroup as any).label === 'ccc/ddd');
				const v1Group = await provider.getParent(cccDddGroup!);
				assert.ok((v1Group as any).label === 'v1');
				assert.ok(await provider.getParent(v1Group!) === category);
			});

			it('expandPullRequest reveals and selects a PR inside a group', async function () {
				const category = createQueryCategory(['repository']);
				const revealed: any[] = [];
				// TreeNode.reveal forwards to its parent, so the parent stands in for the tree view.
				// Spy on parent.reveal (TreeNode.reveal delegates here); update this spy target if
				// expandPullRequest is ever refactored to call view.reveal directly.
				(category as any).parent = { reveal: (node: any, opts: any) => { revealed.push({ node, opts }); return Promise.resolve(); } };

				const found = await category.expandPullRequest(prB1);

				assert.strictEqual(found, true);
				assert.strictEqual(revealed.length, 1);
				assert.ok(revealed[0].node.pullRequestModel === prB1);
				assert.deepStrictEqual(revealed[0].opts, { expand: true, select: true });
			});
		});

		describe('group expansion state across reload', function () {
			function reloadTree(groupBy: string[]) {
				const expand = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<TreeNode>>();
				const collapse = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<TreeNode>>();
				context.subscriptions.push(expand, collapse);
				const baseView = createTreeView('pr:github', {});
				createTreeView.callsFake(() => ({
					...baseView,
					onDidExpandElement: expand.event,
					onDidCollapseElement: collapse.event,
				}));
				provider.dispose();
				prsTreeModel.dispose();
				prsTreeModel = new PrsTreeModel(telemetry, reposManager, context);
				sinon.stub(prsTreeModel, 'getPullRequestsForQuery').resolves({
					items: [prA1, prB1, prA2],
					hasMorePages: false,
					hasUnsearchedRepositories: false,
				});
				sinon.stub(prsTreeModel, 'hasLoaded').get(() => true);
				provider = new PullRequestsTreeDataProvider(prsTreeModel, telemetry, context, reposManager);
				const category = createQueryCategory(groupBy);
				(provider as any)._children = [category];
				return { category, expand, collapse };
			}

			it('keeps a collapsed group collapsed after reload while its expanded sibling stays expanded', async function () {
				const first = reloadTree(['repository']);
				first.expand.fire({ element: first.category });
				const groups = await first.category.getChildren() as PRGroupTreeNode[];
				for (const g of groups) {
					first.expand.fire({ element: g });
				}
				const aaaBbb = groups.find(g => g.label === 'aaa/bbb')!;
				first.collapse.fire({ element: aaaBbb });

				// After collapsing aaa/bbb, it should NOT be in expandedQueries; ccc/ddd and the category should be
				const stored = context.workspaceState.get<string[]>(EXPANDED_QUERIES_STATE) ?? [];
				assert.ok(stored.includes('Test Query'), 'category should be in expandedQueries');
				assert.ok(stored.includes('Test Query/repository:ccc/ddd'), 'ccc/ddd should be in expandedQueries');
				assert.ok(!stored.includes('Test Query/repository:aaa/bbb'), 'aaa/bbb should not be in expandedQueries');

				// Reload (simulate window reload)
				const second = reloadTree(['repository']);
				assert.strictEqual(second.category.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
				const reloaded = await second.category.getChildren() as PRGroupTreeNode[];
				assert.ok(reloaded[0] !== groups[0], 'should be new instances after reload');
				assert.deepStrictEqual(reloaded.map(g => g.id), groups.map(g => g.id), 'group ids should be stable');
				const reloadedAaa = reloaded.find(g => g.label === 'aaa/bbb')!;
				const reloadedCcc = reloaded.find(g => g.label === 'ccc/ddd')!;
				const aaaItem = await reloadedAaa.getTreeItem();
				const cccItem = await reloadedCcc.getTreeItem();
				assert.strictEqual(aaaItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
				assert.strictEqual(cccItem.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
			});

			it('persists nested group state per level', async function () {
				const milestone1 = { id: 'milestone-1', title: 'v1', createdAt: '', number: 1 };
				const milestone2 = { id: 'milestone-2', title: 'v2', createdAt: '', number: 2 };
				prA1.milestone = milestone1;
				prB1.milestone = milestone1;
				prA2.milestone = milestone2;

				const first = reloadTree(['milestone', 'repository']);
				first.expand.fire({ element: first.category });
				const milestoneGroups = await first.category.getChildren() as PRGroupTreeNode[];
				const v1 = milestoneGroups.find(g => g.label === 'v1')!;
				first.expand.fire({ element: v1 });
				const repoGroupsUnderV1 = await v1.getChildren() as PRGroupTreeNode[];
				const v1Aaa = repoGroupsUnderV1.find(g => g.label === 'aaa/bbb')!;
				const v1Ccc = repoGroupsUnderV1.find(g => g.label === 'ccc/ddd')!;
				first.expand.fire({ element: v1Aaa });
				first.expand.fire({ element: v1Ccc });
				first.collapse.fire({ element: v1Aaa });
				// v2 is never expanded

				const second = reloadTree(['milestone', 'repository']);
				const reloadedMilestoneGroups = await second.category.getChildren() as PRGroupTreeNode[];
				const reloadedV1 = reloadedMilestoneGroups.find(g => g.label === 'v1')!;
				const reloadedV2 = reloadedMilestoneGroups.find(g => g.label === 'v2')!;
				const v1Item = await reloadedV1.getTreeItem();
				const v2Item = await reloadedV2.getTreeItem();
				assert.strictEqual(v1Item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded, 'v1 should be expanded');
				assert.strictEqual(v2Item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'v2 should be collapsed');

				const reloadedReposUnderV1 = await reloadedV1.getChildren() as PRGroupTreeNode[];
				const reloadedV1Aaa = reloadedReposUnderV1.find(g => g.label === 'aaa/bbb')!;
				const reloadedV1Ccc = reloadedReposUnderV1.find(g => g.label === 'ccc/ddd')!;
				const v1AaaItem = await reloadedV1Aaa.getTreeItem();
				const v1CccItem = await reloadedV1Ccc.getTreeItem();
				assert.strictEqual(v1AaaItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'v1/aaa should be collapsed');
				assert.strictEqual(v1CccItem.collapsibleState, vscode.TreeItemCollapsibleState.Expanded, 'v1/ccc should be expanded');
			});
		});

		it('rebuilds milestone groups for PRs from repositories discovered by a cross-repository query', async function () {
			// Use the real production path: createGitHubRepositoryFromOwnerName -> createAndAddGitHubRepository.
			// resolveMetadata=false skips the network call to validateGitHubRepositoryAccess.
			const discovered = await folderManager.createGitHubRepositoryFromOwnerName('eee', 'fff', false);
			assert.ok(discovered, 'createGitHubRepositoryFromOwnerName must return a repository');
			assert.ok(folderManager.gitHubRepositories.includes(discovered));

			// Create a PR on the discovered repo with the same default milestone (milestone0 / 'milestone title')
			// as prA1/prA2/prB1 so they all land in one group.
			const discoveredPr = discovered.createOrUpdatePullRequestModel(
				convertRESTPullRequestToRawPullRequest(stackableRestPullRequest(discovered, 5, 'main', 'feature-5'), discovered),
				true, // silent - do not fire onDidAddPullRequest yet
			);

			getPullRequestsForQuery.resolves({
				items: [prA1, discoveredPr, prA2],
				hasMorePages: false,
				hasUnsearchedRepositories: false,
			});

			const category = createQueryCategory(['milestone']);
			(provider as any)._children = [category];
			const before = await category.getChildren() as PRGroupTreeNode[];
			assert.deepStrictEqual(before.map(g => g.label), ['milestone title']);

			const onDidChangeTreeData = sinon.spy();
			context.subscriptions.push(provider.onDidChangeTreeData(onDidChangeTreeData));

			// Clear the milestone via the real model-update path; IssueModel.update fires { milestone: true }.
			// GitHubRepository._onPullRequestModelChanged forwards it to onDidChangePullRequests, which must
			// now reach PrsTreeModel via the forwardGitHubRepositoryEvents wiring added to
			// createAndAddGitHubRepository. Without that wiring this assertion fails with 0 calls.
			const clearRest = stackableRestPullRequest(discovered, 5, 'main', 'feature-5');
			(clearRest as any).milestone = null;
			discoveredPr.update(convertRESTPullRequestToRawPullRequest(clearRest, discovered));

			sinon.assert.calledOnce(onDidChangeTreeData);
			assert.deepStrictEqual(onDidChangeTreeData.firstCall.args[0], [category]);

			const after = await category.getChildren() as PRGroupTreeNode[];
			const labels = after.map(g => g.label).sort();
			assert.ok(labels.includes('milestone title'), 'prA1/prA2 must still be under their milestone group');
			assert.ok(labels.includes('No Milestone'), 'discoveredPr must move to No Milestone after milestone is cleared');
		});
	});

	describe('Local Pull Request Branches', function () {
		it('creates a node for each local pull request', async function () {
			const url = 'git@github.com:aaa/bbb';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const gitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			gitHubRepository.buildMetadata(m => {
				m.clone_url('https://github.com/aaa/bbb');
			});

			const pr0 = gitHubRepository.addGraphQLPullRequest(builder => {
				builder.pullRequest(pr => {
					pr.repository(r =>
						r.pullRequest(p => {
							p.databaseId(1111);
							p.number(1111);
							p.title('zero');
							p.author(a => a.login('me').avatarUrl('https://githubusercontent.com/me.jpg').url('https://githubusercontent.com/me'));
							p.baseRef!(b => b.repository(br => br.url('https://github.com/aaa/bbb')));
							p.baseRepository(r => r.url('https://github.com/aaa/bbb'));
						}),
					);
				});
			}).pullRequest;
			const prItem0 = await parseGraphQLPullRequest(pr0.repository!.pullRequest, gitHubRepository);
			const pullRequest0 = new PullRequestModel(credentialStore, telemetry, gitHubRepository, remote, prItem0);

			const pr1 = gitHubRepository.addGraphQLPullRequest(builder => {
				builder.pullRequest(pr => {
					pr.repository(r =>
						r.pullRequest(p => {
							p.databaseId(2222);
							p.number(2222);
							p.title('one');
							p.author(a => a.login('you').avatarUrl('https://githubusercontent.com/you.jpg'));
							p.baseRef!(b => b.repository(br => br.url('https://github.com/aaa/bbb')));
							p.baseRepository(r => r.url('https://github.com/aaa/bbb'));
						}),
					);
				});
			}).pullRequest;
			const prItem1 = await parseGraphQLPullRequest(pr1.repository!.pullRequest, gitHubRepository);
			const pullRequest1 = new PullRequestModel(credentialStore, telemetry, gitHubRepository, remote, prItem1);

			const repository = new MockRepository();
			await repository.addRemote(remote.remoteName, remote.url);

			await repository.createBranch('pr-branch-0', false);
			await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest0, 'pr-branch-0');
			await repository.createBranch('pr-branch-1', true);
			await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest1, 'pr-branch-1');

			await repository.createBranch('non-pr-branch', false);

			const manager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			reposManager.insertFolderManager(manager);
			sinon.stub(manager, 'createGitHubRepository').callsFake((r, cs) => {
				assert.deepStrictEqual(r, remote);
				assert.strictEqual(cs, credentialStore);
				return Promise.resolve(gitHubRepository);
			});
			sinon.stub(credentialStore, 'isAuthenticated').returns(true);
			sinon.stub(DataUri, 'avatarCirclesAsImageDataUris').callsFake((context: vscode.ExtensionContext, users: (IAccount | ITeam)[], height: number, width: number, localOnly?: boolean) => {
				return Promise.resolve(users.map(user => user.avatarUrl ? vscode.Uri.parse(user.avatarUrl) : undefined));
			});
			await manager.updateRepositories();
			provider.initialize([], mockNotificationsManager as NotificationsManager);
			manager.activePullRequest = pullRequest1;

			const rootNodes = await provider.getChildren();
			const rootTreeItems = await Promise.all(rootNodes.map(node => node.getTreeItem()));
			const localNode = rootNodes.find((_node, index) => rootTreeItems[index].label === 'Local Pull Request Branches');
			assert(localNode);

			// Need to call getChildren twice to get past the quick render with an empty list
			await localNode!.getChildren();
			await asPromise(provider.prsTreeModel.onLoaded);
			const localChildren = await localNode!.getChildren();
			assert.strictEqual(localChildren.length, 2);
			const [localItem0, localItem1] = await Promise.all(localChildren.map(node => node.getTreeItem()));

			const label0 = (localItem0.label as vscode.TreeItemLabel2).label;
			assert.ok(label0 instanceof vscode.MarkdownString);
			assert.equal(label0.value, 'zero');
			assert.strictEqual(localItem0.tooltip, undefined);
			assert.strictEqual(localItem0.description, 'by @me');
			assert.strictEqual(localItem0.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
			assert.strictEqual(localItem0.contextValue, 'pullrequest:local:nonactive:hasHeadRef');
			assert.deepStrictEqual(localItem0.iconPath!.toString(), 'https://githubusercontent.com/me.jpg');

			const label1 = (localItem1.label as vscode.TreeItemLabel2).label;
			assert.ok(label1 instanceof vscode.MarkdownString);
			assert.equal(label1.value, '$(check) one');
			assert.strictEqual(localItem1.tooltip, undefined);
			assert.strictEqual(localItem1.description, 'by @you');
			assert.strictEqual(localItem1.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
			assert.strictEqual(localItem1.contextValue, 'pullrequest:local:active:hasHeadRef');
			assert.deepStrictEqual(localItem1.iconPath!.toString(), 'https://githubusercontent.com/you.jpg');
		});
	});
});
