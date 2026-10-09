/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SinonSandbox, SinonStub, createSandbox } from 'sinon';
import { default as assert } from 'assert';
import { Octokit } from '@octokit/rest';
import { ApolloClient, ApolloLink, InMemoryCache } from 'apollo-boost';

import { RepositoriesManager } from '../../github/repositoriesManager';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { GitApiImpl } from '../../api/api1';
import { CredentialStore, GitHub } from '../../github/credentials';
import { AuthProvider } from '../../common/authentication';
import { commands, contexts } from '../../common/executeCommands';
import { parseRemote, Remote } from '../../common/remote';
import { parseEnterpriseUri } from '../../authentication/configuration';
import { LoggingApolloClient, LoggingOctokit, RateLogger } from '../../github/loggingOctokit';
import * as utils from '../../github/utils';
import { EXTENSION_ID } from '../../constants';

import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';

describe('RepositoriesManager', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;
	let reposManager: RepositoriesManager;
	let createPrHelper: CreatePullRequestHelper;
	let mockThemeWatcher: MockThemeWatcher;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		mockThemeWatcher = new MockThemeWatcher();
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		reposManager = new RepositoriesManager(credentialStore, telemetry);
		createPrHelper = new CreatePullRequestHelper();
	});

	afterEach(function () {
		reposManager.dispose();
		credentialStore.dispose();
		context.dispose();
		sinon.restore();
	});

	describe('Enterprise setup', function () {
		const hostA = 'https://host-a.example';
		const hostB = 'https://host-b.example';
		let get: SinonStub;
		let inspect: SinonStub;
		let update: SinonStub;
		let login: SinonStub;
		let information: SinonStub;
		let input: SinonStub;
		let picker: SinonStub;
		let error: SinonStub;
		let execute: SinonStub;
		let findRemotes: SinonStub;
		let enterpriseHub: GitHub;

		function configuration(legacy?: string, plural?: unknown): void {
			get.withArgs('uri').returns(legacy);
			get.withArgs('uris').returns(plural);
			inspect.withArgs('uris').returns({ key: 'github-enterprise.uris', globalValue: plural });
		}

		function remote(host: string): Remote {
			const result = parseRemote('origin', `${host}/owner/repo`);
			assert.ok(result);
			return result;
		}

		beforeEach(function () {
			get = sinon.stub();
			inspect = sinon.stub();
			update = sinon.stub().resolves();
			const settings: vscode.WorkspaceConfiguration = { get, inspect, update, has: sinon.stub() };
			const original = vscode.workspace.getConfiguration;
			sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section, scope) =>
				section === 'github-enterprise' ? settings : original(section, scope));
			sinon.stub(vscode.workspace, 'isTrusted').value(true);
			sinon.stub(vscode.workspace, 'workspaceFile').value(undefined);
			sinon.stub(vscode.workspace, 'workspaceFolders').value([
				{ index: 0, name: 'workspace', uri: vscode.Uri.file(__dirname) },
			]);
			information = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
			input = sinon.stub(vscode.window, 'showInputBox').resolves(undefined);
			picker = sinon.stub(vscode.window, 'showQuickPick').resolves(undefined);
			error = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
			execute = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
			enterpriseHub = {
				serverUri: parseEnterpriseUri(hostB),
				octokit: new LoggingOctokit(new Octokit(), new RateLogger(telemetry, false)),
				graphql: new LoggingApolloClient(new ApolloClient({ cache: new InMemoryCache(), link: ApolloLink.empty() }), new RateLogger(telemetry, false)),
			};
			login = sinon.stub(credentialStore, 'login').resolves(enterpriseHub);
			findRemotes = sinon.stub(utils, 'findDotComAndEnterpriseRemotes').resolves({
				dotComRemotes: [], enterpriseRemotes: [], unknownRemotes: [],
			});
			configuration(undefined, [hostA, hostB]);
		});

		it('uses native sign-in without rewriting an existing plural list or selecting its first host', async function () {
			assert.strictEqual(await reposManager.authenticate(true), true);
			assert.deepStrictEqual(login.args, [[AuthProvider.githubEnterprise]]);
			assert.strictEqual(update.called || input.called || picker.called || information.called, false);
		});

		it('does not migrate legacy-only configuration just to sign in', async function () {
			configuration(hostA);
			assert.strictEqual(await reposManager.authenticate(true), true);
			assert.strictEqual(update.called, false);
		});

		it('offers account selection when explicit sign-in reuses the selected account', async function () {
			sinon.stub(credentialStore, 'getHub').withArgs(AuthProvider.githubEnterprise).returns(enterpriseHub);
			assert.strictEqual(await reposManager.authenticate(true), true);
			assert.deepStrictEqual(information.firstCall.args, ['Already signed in to GitHub Enterprise.', 'Select Account']);
			assert.strictEqual(update.called, false);
		});

		it('opens account preferences scoped to this extension and the Enterprise provider', async function () {
			const getAccounts = sinon.stub(vscode.authentication, 'getAccounts').resolves([{ id: 'account', label: 'octocat - host-a.example' }]);

			await reposManager.selectEnterpriseAccount();

			assert.deepStrictEqual(getAccounts.args, [[AuthProvider.githubEnterprise]]);
			assert.deepStrictEqual(execute.lastCall.args, [commands.MANAGE_EXTENSION_ACCOUNT_PREFERENCES, EXTENSION_ID, AuthProvider.githubEnterprise]);
			assert.strictEqual(login.called || update.called || findRemotes.called, false);
		});

		it('starts sign-in instead of opening an empty account picker when there are no accounts', async function () {
			sinon.stub(vscode.authentication, 'getAccounts').resolves([]);

			await reposManager.selectEnterpriseAccount();

			assert.deepStrictEqual(login.args, [[AuthProvider.githubEnterprise]]);
			assert.strictEqual(execute.calledWith(commands.MANAGE_EXTENSION_ACCOUNT_PREFERENCES), false);
			assert.strictEqual(update.called, false);
		});

		it('surfaces account lookup errors without falling back to another provider', async function () {
			sinon.stub(vscode.authentication, 'getAccounts').rejects(new Error('Provider unavailable'));

			await reposManager.selectEnterpriseAccount();

			assert.match(error.firstCall.args[0], /Unable to select a GitHub Enterprise account: Provider unavailable/);
			assert.strictEqual(login.called || update.called || execute.called, false);
		});

		it('opens the scoped picker from the already-signed-in notification', async function () {
			sinon.stub(credentialStore, 'getHub').withArgs(AuthProvider.githubEnterprise).returns(enterpriseHub);
			sinon.stub(vscode.authentication, 'getAccounts').resolves([{ id: 'account', label: 'octocat - host-b.example' }]);
			information.resolves('Select Account');

			await reposManager.authenticate(true);

			assert.deepStrictEqual(execute.lastCall.args, [commands.MANAGE_EXTENSION_ACCOUNT_PREFERENCES, EXTENSION_ID, AuthProvider.githubEnterprise]);
		});

		it('does not treat a cancelled public login as successful', async function () {
			login.resolves(undefined);
			assert.strictEqual(await reposManager.authenticate(false), false);
			assert.deepStrictEqual(login.args, [[AuthProvider.github]]);
			assert.strictEqual(findRemotes.called, false);
		});

		it('adds an explicitly entered host without reviving legacy configuration suppressed by an empty list', async function () {
			configuration(hostA, []);
			input.resolves(hostB);
			assert.strictEqual(await reposManager.authenticate(true), true);
			assert.deepStrictEqual(update.args, [['uris', [parseEnterpriseUri(hostB).toString()], vscode.ConfigurationTarget.Workspace]]);
			assert.strictEqual(login.calledAfter(update), true);
		});

		it('requires a choice among multiple discovered instances', async function () {
			configuration();
			findRemotes.resolves({ dotComRemotes: [], enterpriseRemotes: [remote(hostA), remote(hostB)], unknownRemotes: [] });
			picker.resolves({ label: hostB, host: hostB });
			assert.strictEqual(await reposManager.authenticate(true), true);
			assert.deepStrictEqual(picker.firstCall.args[0].slice(0, 2).map(item => item.host), [hostA, hostB]);
			assert.deepStrictEqual(update.firstCall.args[1], [parseEnterpriseUri(hostB).toString()]);
			assert.strictEqual(input.called || information.called, false);
		});

		it('requires confirmation before saving a sole discovered instance', async function () {
			configuration();
			findRemotes.resolves({ dotComRemotes: [], enterpriseRemotes: [remote(hostB)], unknownRemotes: [] });
			information.resolves('Yes');
			assert.strictEqual(await reposManager.authenticate(true), true);
			assert.match(information.firstCall.args[0], /github-enterprise\.uris/);
			assert.strictEqual(update.calledOnce, true);
		});

		it('preserves configuration added while the setup prompt was open', async function () {
			configuration();
			input.callsFake(async () => {
				configuration(hostA);
				return hostB;
			});
			assert.strictEqual(await reposManager.authenticate(true), true);
			assert.deepStrictEqual(update.firstCall.args[1], [hostA, hostB].map(uri => parseEnterpriseUri(uri).toString()));
		});

		for (const kind of ['input', 'confirmation', 'picker']) {
			it(`does not save or authenticate when the ${kind} is cancelled`, async function () {
				configuration();
				const remotes = kind === 'input' ? [] : kind === 'confirmation' ? [remote(hostB)] : [remote(hostA), remote(hostB)];
				findRemotes.resolves({ dotComRemotes: [], enterpriseRemotes: remotes, unknownRemotes: [] });
				assert.strictEqual(await reposManager.authenticate(true), false);
				assert.strictEqual(update.called || login.called, false);
			});
		}

		it('does not fall back to the legacy setting or authenticate with invalid plural configuration', async function () {
			configuration(hostA, [42]);
			assert.strictEqual(await reposManager.authenticate(true), false);
			assert.strictEqual(update.called || login.called || input.called, false);
			assert.match(error.firstCall.args[0], /Invalid GitHub Enterprise/);
		});

		it('rejects invalid setup input without saving or starting authentication', async function () {
			configuration();
			input.resolves('https://github.com');
			assert.strictEqual(await reposManager.authenticate(true), false);
			assert.strictEqual(update.called || login.called, false);
			assert.match(error.firstCall.args[0], /Invalid GitHub Enterprise/);
		});

		it('surfaces write failures and offers settings without starting authentication', async function () {
			configuration();
			input.resolves(hostB);
			update.rejects(new Error('Settings are read-only'));
			error.resolves('Open Settings');
			assert.strictEqual(await reposManager.authenticate(true), false);
			assert.match(error.firstCall.args[0], /Settings are read-only/);
			assert.deepStrictEqual(execute.lastCall.args, ['workbench.action.openSettings', 'github-enterprise.uris', undefined]);
			assert.strictEqual(login.called, false);
		});

		it('updates the welcome context for both settings and trust changes', function () {
			const changes = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
			const trust = new vscode.EventEmitter<void>();
			context.subscriptions.push(changes, trust);
			sinon.stub(vscode.workspace, 'onDidChangeConfiguration').value(changes.event);
			sinon.stub(vscode.workspace, 'onDidGrantWorkspaceTrust').value(trust.event);
			reposManager.dispose();
			reposManager = new RepositoriesManager(credentialStore, telemetry);
			assert.ok(execute.calledWith('setContext', contexts.HAS_ENTERPRISE_URIS, true));

			configuration(hostA, []);
			changes.fire({ affectsConfiguration: key => key === 'github-enterprise.uris' });
			assert.deepStrictEqual(execute.lastCall.args, ['setContext', contexts.HAS_ENTERPRISE_URIS, false]);

			configuration(hostA);
			changes.fire({ affectsConfiguration: key => key === 'github-enterprise.uri' });
			assert.deepStrictEqual(execute.lastCall.args, ['setContext', contexts.HAS_ENTERPRISE_URIS, true]);

			configuration(undefined, []);
			trust.fire();
			assert.deepStrictEqual(execute.lastCall.args, ['setContext', contexts.HAS_ENTERPRISE_URIS, false]);
		});

		it('keeps invalid configuration out of the welcome context', function () {
			configuration(hostA, [42]);
			reposManager.dispose();
			reposManager = new RepositoriesManager(credentialStore, telemetry);
			assert.deepStrictEqual(execute.lastCall.args, ['setContext', contexts.HAS_ENTERPRISE_URIS, false]);
		});
	});

	describe('removeRepo', function () {
		it('removes only the specified repository when it is not at the last position', function () {
			const repo1 = new MockRepository();
			repo1.rootUri = vscode.Uri.file('/repo1');
			repo1.addRemote('origin', 'git@github.com:aaa/bbb');

			const repo2 = new MockRepository();
			repo2.rootUri = vscode.Uri.file('/repo2');
			repo2.addRemote('origin', 'git@github.com:ccc/ddd');

			const repo3 = new MockRepository();
			repo3.rootUri = vscode.Uri.file('/repo3');
			repo3.addRemote('origin', 'git@github.com:eee/fff');

			reposManager.insertFolderManager(new FolderRepositoryManager(0, context, repo1, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));
			reposManager.insertFolderManager(new FolderRepositoryManager(1, context, repo2, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));
			reposManager.insertFolderManager(new FolderRepositoryManager(2, context, repo3, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));

			assert.strictEqual(reposManager.folderManagers.length, 3);

			// Remove the repo at the first position
			reposManager.removeRepo(repo1);

			// Only repo1 should be removed; repo2 and repo3 should remain
			assert.strictEqual(reposManager.folderManagers.length, 2);
			assert.strictEqual(reposManager.folderManagers[0].repository.rootUri.toString(), repo2.rootUri.toString());
			assert.strictEqual(reposManager.folderManagers[1].repository.rootUri.toString(), repo3.rootUri.toString());
		});

		it('removes only the specified repository when it is at the last position', function () {
			const repo1 = new MockRepository();
			repo1.rootUri = vscode.Uri.file('/repo1');
			repo1.addRemote('origin', 'git@github.com:aaa/bbb');

			const repo2 = new MockRepository();
			repo2.rootUri = vscode.Uri.file('/repo2');
			repo2.addRemote('origin', 'git@github.com:ccc/ddd');

			reposManager.insertFolderManager(new FolderRepositoryManager(0, context, repo1, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));
			reposManager.insertFolderManager(new FolderRepositoryManager(1, context, repo2, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));

			assert.strictEqual(reposManager.folderManagers.length, 2);

			// Remove the repo at the last position
			reposManager.removeRepo(repo2);

			assert.strictEqual(reposManager.folderManagers.length, 1);
			assert.strictEqual(reposManager.folderManagers[0].repository.rootUri.toString(), repo1.rootUri.toString());
		});

		it('removes only the middle repository leaving others intact', function () {
			const repo1 = new MockRepository();
			repo1.rootUri = vscode.Uri.file('/repo1');
			repo1.addRemote('origin', 'git@github.com:aaa/bbb');

			const repo2 = new MockRepository();
			repo2.rootUri = vscode.Uri.file('/repo2');
			repo2.addRemote('origin', 'git@github.com:ccc/ddd');

			const repo3 = new MockRepository();
			repo3.rootUri = vscode.Uri.file('/repo3');
			repo3.addRemote('origin', 'git@github.com:eee/fff');

			reposManager.insertFolderManager(new FolderRepositoryManager(0, context, repo1, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));
			reposManager.insertFolderManager(new FolderRepositoryManager(1, context, repo2, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));
			reposManager.insertFolderManager(new FolderRepositoryManager(2, context, repo3, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));

			assert.strictEqual(reposManager.folderManagers.length, 3);

			// Remove the middle repo
			reposManager.removeRepo(repo2);

			assert.strictEqual(reposManager.folderManagers.length, 2);
			assert.strictEqual(reposManager.folderManagers[0].repository.rootUri.toString(), repo1.rootUri.toString());
			assert.strictEqual(reposManager.folderManagers[1].repository.rootUri.toString(), repo3.rootUri.toString());
		});

		it('does nothing when removing a repo that is not tracked', function () {
			const repo1 = new MockRepository();
			repo1.rootUri = vscode.Uri.file('/repo1');
			repo1.addRemote('origin', 'git@github.com:aaa/bbb');

			const unknownRepo = new MockRepository();
			unknownRepo.rootUri = vscode.Uri.file('/unknown');

			reposManager.insertFolderManager(new FolderRepositoryManager(0, context, repo1, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));

			assert.strictEqual(reposManager.folderManagers.length, 1);

			reposManager.removeRepo(unknownRepo);

			assert.strictEqual(reposManager.folderManagers.length, 1);
			assert.strictEqual(reposManager.folderManagers[0].repository.rootUri.toString(), repo1.rootUri.toString());
		});
	});

	describe('worktree change detection', function () {
		it('removes folder manager when its worktree is removed from the main repo', function () {
			const mainRepo = new MockRepository();
			mainRepo.rootUri = vscode.Uri.file('/main-repo');
			mainRepo.addRemote('origin', 'git@github.com:aaa/bbb');

			const worktreeRepo = new MockRepository();
			worktreeRepo.rootUri = vscode.Uri.file('/main-repo/worktrees/feature');
			worktreeRepo.addRemote('origin', 'git@github.com:aaa/bbb');

			reposManager.insertFolderManager(new FolderRepositoryManager(0, context, mainRepo, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));
			reposManager.insertFolderManager(new FolderRepositoryManager(1, context, worktreeRepo, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));

			assert.strictEqual(reposManager.folderManagers.length, 2);

			// Set initial worktrees on the main repo (includes the worktree)
			mainRepo.setWorktrees([
				{ name: 'main-repo', path: '/main-repo', ref: 'main', main: true, detached: false },
				{ name: 'feature', path: '/main-repo/worktrees/feature', ref: 'feature', main: false, detached: false },
			]);

			assert.strictEqual(reposManager.folderManagers.length, 2);

			// Worktree is removed - main repo state changes with updated worktrees
			mainRepo.setWorktrees([
				{ name: 'main-repo', path: '/main-repo', ref: 'main', main: true, detached: false },
			]);

			assert.strictEqual(reposManager.folderManagers.length, 1);
			assert.strictEqual(reposManager.folderManagers[0].repository.rootUri.toString(), mainRepo.rootUri.toString());
		});

		it('does not remove folder managers when worktrees remain unchanged', function () {
			const mainRepo = new MockRepository();
			mainRepo.rootUri = vscode.Uri.file('/main-repo');
			mainRepo.addRemote('origin', 'git@github.com:aaa/bbb');

			const worktreeRepo = new MockRepository();
			worktreeRepo.rootUri = vscode.Uri.file('/main-repo/worktrees/feature');
			worktreeRepo.addRemote('origin', 'git@github.com:aaa/bbb');

			reposManager.insertFolderManager(new FolderRepositoryManager(0, context, mainRepo, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));
			reposManager.insertFolderManager(new FolderRepositoryManager(1, context, worktreeRepo, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));

			// Set initial worktrees
			mainRepo.setWorktrees([
				{ name: 'main-repo', path: '/main-repo', ref: 'main', main: true, detached: false },
				{ name: 'feature', path: '/main-repo/worktrees/feature', ref: 'feature', main: false, detached: false },
			]);

			// Fire state change again with same worktrees
			mainRepo.setWorktrees([
				{ name: 'main-repo', path: '/main-repo', ref: 'main', main: true, detached: false },
				{ name: 'feature', path: '/main-repo/worktrees/feature', ref: 'feature', main: false, detached: false },
			]);

			assert.strictEqual(reposManager.folderManagers.length, 2);
		});

		it('does nothing when worktrees property is not available', function () {
			const repo = new MockRepository();
			repo.rootUri = vscode.Uri.file('/repo');
			repo.addRemote('origin', 'git@github.com:aaa/bbb');

			reposManager.insertFolderManager(new FolderRepositoryManager(0, context, repo, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));

			assert.strictEqual(reposManager.folderManagers.length, 1);

			// Fire state change without setting worktrees (stays undefined)
			(repo as any)._onDidChangeState.fire();

			assert.strictEqual(reposManager.folderManagers.length, 1);
		});
	});
});
