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
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { convertRESTPullRequestToRawPullRequest, parseGraphQLPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { PRNode } from '../../view/treeNodes/pullRequestNode';
import { CategoryTreeNode } from '../../view/treeNodes/categoryNode';
import { GitHubRemote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { CredentialStore, GitHub } from '../../github/credentials';
import { GitApiImpl } from '../../api/api1';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { LoggingApolloClient, LoggingOctokit, RateLogger } from '../../github/loggingOctokit';
import { AuthProvider, GitHubServerType } from '../../common/authentication';
import * as configuration from '../../authentication/configuration';
import { DataUri } from '../../common/uri';
import { GithubItemStateEnum, IAccount, ITeam, PRType, PullRequestMergeability } from '../../github/interface';
import { asPromise } from '../../common/utils';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';
import { mockStackSetting } from '../mocks/mockStackSetting';
import { PrsTreeModel } from '../../view/prsTreeModel';
import { escapeMarkdownText } from '../../github/markdownUtils';

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
	let setStacksEnabled: (enabled: boolean) => void;

	beforeEach(function () {
		sinon = createSandbox();
		discoveredRepository = undefined;
		MockCommandRegistry.install(sinon);
		setStacksEnabled = mockStackSetting(sinon);
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

	function stackablePullRequest(repository: MockGitHubRepository, number: number, base: string, head: string): PullRequestModel {
		const remote = repository.remote;
		const rest = new PullRequestBuilder().number(number).id(number)
			.html_url(`https://github.com/${remote.owner}/${remote.repositoryName}/pull/${number}`)
			.base(ref => ref.ref(base)).head(ref => ref.ref(head)).build();
		for (const ref of [rest.base, rest.head]) {
			ref.repo.owner.login = remote.owner;
			ref.repo.name = remote.repositoryName;
			ref.repo.clone_url = `https://github.com/${remote.owner}/${remote.repositoryName}.git`;
		}
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

	it('disables multi-selection when created with stacks disabled', function () {
		setStacksEnabled(false);
		provider.dispose();
		provider = new PullRequestsTreeDataProvider(prsTreeModel, telemetry, context, reposManager);

		const tree = createTreeView.getCalls().filter(call => call.args[0] === 'pr:github').pop();
		assert(tree);
		const options = tree.args[1] as { canSelectMany?: boolean };
		assert.strictEqual(options.canSelectMany, false);
	});

	it('applies multi-selection setting changes only when recreating the tree', function () {
		const configurationChanged = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
		context.subscriptions.push(configurationChanged);
		sinon.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake(configurationChanged.event);
		provider.dispose();
		provider = new PullRequestsTreeDataProvider(prsTreeModel, telemetry, context, reposManager);
		const event = {
			affectsConfiguration: (section: string) => section === 'githubPullRequests.experimental.stacks',
		};

		for (const enabled of [false, true, false]) {
			const view = provider.view;
			const treeCount = createTreeView.getCalls().filter(call => call.args[0] === 'pr:github').length;
			setStacksEnabled(enabled);
			configurationChanged.fire(event);
			assert.strictEqual(provider.view, view);
			assert.strictEqual(createTreeView.getCalls().filter(call => call.args[0] === 'pr:github').length, treeCount);

			provider.dispose();
			provider = new PullRequestsTreeDataProvider(prsTreeModel, telemetry, context, reposManager);
			const tree = createTreeView.getCalls().filter(call => call.args[0] === 'pr:github').pop();
			assert(tree);
			const options = tree.args[1] as { canSelectMany?: boolean };
			assert.strictEqual(options.canSelectMany, enabled);
		}
	});

	it('updates stack actions when the setting changes on an existing multi-select tree', function () {
		const configurationChanged = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
		context.subscriptions.push(configurationChanged);
		sinon.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake(configurationChanged.event);
		provider.dispose();
		provider = new PullRequestsTreeDataProvider(prsTreeModel, telemetry, context, reposManager);

		const url = 'https://github.com/aaa/bbb';
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		discoveredRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
		const selected = [
			stackablePullRequest(discoveredRepository, 1, 'main', 'D1'),
			stackablePullRequest(discoveredRepository, 2, 'D1', 'D2'),
		].map(model => Object.assign(Object.create(PRNode.prototype), { pullRequestModel: model }) as PRNode);
		sinon.stub(provider.view, 'selection').get(() => selected);
		const treeCount = createTreeView.getCalls().filter(call => call.args[0] === 'pr:github').length;
		const event = {
			affectsConfiguration: (section: string) => section === 'githubPullRequests.experimental.stacks',
		};

		for (const enabled of [true, false, true]) {
			setStacksEnabled(enabled);
			executeCommand.resetHistory();
			configurationChanged.fire(event);
			assert(executeCommand.calledOnceWithExactly('setContext', 'github:canAddToStack', enabled));
		}

		assert.strictEqual(createTreeView.getCalls().filter(call => call.args[0] === 'pr:github').length, treeCount);
	});

	it('does not offer or execute Add to Stack when stacks are disabled', async function () {
		setStacksEnabled(false);
		const showError = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);

		(provider as any).updateCanAddToStack();
		await (provider as any).addSelectedPullRequestsToStack(undefined, undefined);

		assert(executeCommand.calledWith('setContext', 'github:canAddToStack', false));
		assert.match(showError.firstCall.args[0], /stack features are disabled/);
	});

	it('refreshes selected and existing stack PR panels after adding from the tree', async function () {
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
			sinon.stub(bottom, 'getStack').resolves(existing);
			sinon.stub(top, 'getStack').resolves(undefined);
			sinon.stub(repository, 'getStackCandidate').resolves({ parentPullRequestNumber: 1, stackNumber: 10, size: 2, url });
			sinon.stub(repository, 'getPullRequest').callsFake(async number => number === 1 ? bottom : top);
			const add = sinon.stub(repository, 'addPullRequestsToStack').resolves();
			const confirm = sinon.stub(vscode.window, 'showInformationMessage');
			confirm.onFirstCall().resolves('Add to Stack' as never);
			confirm.onSecondCall().resolves(undefined);
			const refresh = sinon.stub(PullRequestOverviewPanel, 'refreshStackPanels').resolves();

			await (provider as any).addSelectedPullRequestsToStack(selected[0], selected);

			assert(add.calledOnce);
			assert(refresh.calledOnceWithExactly(remote.owner, remote.repositoryName, [10, 1, 2]));
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
