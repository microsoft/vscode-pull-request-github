/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SinonSandbox, SinonStub, createSandbox } from 'sinon';
import { default as assert } from 'assert';
import { Octokit } from '@octokit/rest';
import { ApolloClient, ApolloLink, InMemoryCache } from 'apollo-boost';

import { getEnterpriseAuthenticationMessage, PullRequestsTreeDataProvider } from '../../view/prsTreeDataProvider';
import { NotificationsManager } from '../../notifications/notificationsManager';
import { FolderRepositoryManager, ReposManagerState } from '../../github/folderRepositoryManager';

import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockNotificationManager } from '../mocks/mockNotificationManager';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { mockTreeViewWorkbench } from '../mocks/mockTreeViewWorkbench';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { PullRequestGitHelper } from '../../github/pullRequestGitHelper';
import { PullRequestModel } from '../../github/pullRequestModel';
import { convertRESTPullRequestToRawPullRequest, parseGraphQLPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { PRNode } from '../../view/treeNodes/pullRequestNode';
import { GitHubRemote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { CredentialStore, GitHub } from '../../github/credentials';
import { GitApiImpl } from '../../api/api1';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { LoggingApolloClient, LoggingOctokit, RateLogger } from '../../github/loggingOctokit';
import { AuthProvider, GitHubServerType } from '../../common/authentication';
import * as configuration from '../../authentication/configuration';
import { DataUri } from '../../common/uri';
import { GithubItemStateEnum, IAccount, ITeam, PullRequestMergeability } from '../../github/interface';
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
		const rest = new PullRequestBuilder().number(number)
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
