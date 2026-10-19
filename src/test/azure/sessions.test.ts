/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Response } from 'cross-fetch';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { AzureClient } from '../../azure/client';
import { AzureSessions } from '../../azure/sessions';
import { AuthProvider, GitHubServerType } from '../../common/authentication';
import { parseRemote } from '../../common/remote';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager, ReposManagerState } from '../../github/folderRepositoryManager';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { GitApiImpl } from '../../api/api1';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';

describe('Azure-only repository sessions', () => {
	let sandbox: SinonSandbox;
	const disposables: vscode.Disposable[] = [];
	beforeEach(() => {
		sandbox = createSandbox();
		sandbox.stub(vscode.authentication, 'getSession').rejects(new Error('Unexpected global authentication request'));
	});
	afterEach(() => {
		for (const disposable of disposables.splice(0).reverse()) {
			disposable.dispose();
		}
		sandbox.restore();
	});

	function fixture(handler?: (url: URL) => Response | Promise<Response>) {
		const context = new MockExtensionContext();
		const secretsChanged = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
		disposables.push(secretsChanged, context);
		const secrets = new Map([
			['azureDevOps.pat:https://dev.azure.com/first', 'test-first'],
			['azureDevOps.pat:https://dev.azure.com/second', 'test-second'],
		]);
		context.secrets = {
			onDidChange: secretsChanged.event,
			async get(key) { return secrets.get(key); },
			async keys() { return [...secrets.keys()]; },
			async store(key, value) { secrets.set(key, value); secretsChanged.fire({ key }); },
			async delete(key) { secrets.delete(key); secretsChanged.fire({ key }); },
		};
		const calls: URL[] = [];
		const sessions = new AzureSessions(context, (remote, authorization) => new AzureClient(remote, authorization, async url => {
			const parsed = new URL(url);
			calls.push(parsed);
			if (handler) {
				return handler(parsed);
			}
			return new Response(JSON.stringify(parsed.pathname.endsWith('/connectionData')
				? { authenticatedUser: { id: parsed.pathname.split('/')[1], displayName: 'Viewer' } }
				: { id: 'repository-id', defaultBranch: 'refs/heads/main', project: { id: 'project-id', name: 'Project' } }));
		}));
		const telemetry = new MockTelemetry();
		const credentials = new CredentialStore(telemetry, context, sessions);
		disposables.push(credentials);
		return { sessions, credentials, context, telemetry, calls };
	}

	it('initializes without GitHub authentication and requires repository-scoped account lookup', async () => {
		const { credentials, calls } = fixture();
		await credentials.create();
		assert.strictEqual(credentials.isAnyAuthenticated(), false);
		assert.strictEqual(credentials.isAuthenticated(AuthProvider.github), false);
		assert.strictEqual(credentials.getHub(AuthProvider.azureDevOps), undefined);
		assert.strictEqual(credentials.getHub(AuthProvider.github), undefined);
		await assert.rejects(credentials.getCurrentUser(AuthProvider.azureDevOps), /current repository/);
		await assert.rejects(credentials.login(AuthProvider.github), /GitHub authentication is unavailable/);
		assert.deepStrictEqual(calls, []);
	});

	it('coalesces concurrent organization validation without sharing accounts between organizations', async () => {
		const { sessions, credentials, calls } = fixture();
		const first = parseRemote('origin', 'https://dev.azure.com/First/Project/_git/Repo');
		const sameOrganization = parseRemote('upstream', 'https://dev.azure.com/First/AnotherProject/_git/OtherRepo');
		const second = parseRemote('second', 'https://dev.azure.com/Second/Project/_git/Repo');
		assert.ok(first && sameOrganization && second);
		assert.deepStrictEqual(await Promise.all([sessions.refresh(first), sessions.refresh(sameOrganization)]), [true, true]);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(sessions.isAuthenticated(first), true);
		assert.strictEqual(sessions.isAuthenticated(second), false);
		assert.strictEqual(credentials.isAuthenticated(AuthProvider.azureDevOps), true);
		assert.strictEqual(credentials.isAuthenticated(AuthProvider.github), false);
		assert.strictEqual(await sessions.refresh(second), true);
		assert.strictEqual((await sessions.provider(first).currentUser()).id, 'First');
		assert.strictEqual((await sessions.provider(second).currentUser()).id, 'Second');
		assert.notStrictEqual(sessions.provider(first), sessions.provider(second));
	});

	it('turns expired credentials into an explicit signed-out state and propagates forbidden responses', async () => {
		let status = 200;
		const { sessions } = fixture(() => new Response(JSON.stringify({ authenticatedUser: { id: 'viewer', displayName: 'Viewer' } }), { status }));
		const remote = parseRemote('origin', 'https://dev.azure.com/First/Project/_git/Repo');
		assert.ok(remote);
		await sessions.refresh(remote);
		let changes = 0;
		disposables.push(sessions.onDidChange(() => changes++));
		status = 401;
		assert.strictEqual(await sessions.refresh(remote), false);
		assert.strictEqual(sessions.isAuthenticated(remote), false);
		assert.strictEqual(changes, 1);
		status = 403;
		await assert.rejects(sessions.refresh(remote), /HTTP 403/);
	});

	it('does not restore an account from a request started before a credential change', async () => {
		let release!: () => void;
		let started!: () => void;
		const blocked = new Promise<void>(resolve => release = resolve);
		const ready = new Promise<void>(resolve => started = resolve);
		const { sessions, context } = fixture(async () => {
			started();
			await blocked;
			return new Response(JSON.stringify({ authenticatedUser: { id: 'old', displayName: 'Old account' } }));
		});
		const remote = parseRemote('origin', 'https://dev.azure.com/First/Project/_git/Repo');
		assert.ok(remote);
		const request = sessions.refresh(remote);
		const rejected = assert.rejects(request, /session changed/);
		await ready;
		await context.secrets.store('azureDevOps.pat:https://dev.azure.com/first', 'replacement');
		release();
		await rejected;
		assert.strictEqual(sessions.isAuthenticated(remote), false);
	});

	it('refuses GitHub and untrusted Server remotes before requesting credentials or sending HTTP', () => {
		const { sessions, calls } = fixture();
		for (const url of ['https://github.com/owner/repo', 'https://untrusted.example.com/tfs/Collection/Project/_git/Repo']) {
			const remote = parseRemote('origin', url);
			assert.ok(remote);
			assert.throws(() => sessions.provider(remote), /not an Azure DevOps repository/);
		}
		assert.deepStrictEqual(calls, []);
	});

	it('rechecks Server collection trust before using an already-created provider', async () => {
		const configuration = vscode.workspace.getConfiguration('azureDevOpsPullRequests');
		const previous = configuration.inspect<string[]>('serverCollections')?.globalValue;
		const collection = 'https://devops.example.com/tfs/Collection';
		await configuration.update('serverCollections', [collection], vscode.ConfigurationTarget.Global);
		try {
			const { sessions, context, calls } = fixture();
			await context.secrets.store(`azureDevOps.pat:${collection.toLowerCase()}`, 'test-server');
			const remote = parseRemote('origin', `${collection}/Project/_git/Repo`);
			assert.ok(remote);
			const provider = sessions.provider(remote);
			await provider.currentUser();
			assert.strictEqual(calls.length, 1);
			await configuration.update('serverCollections', [], vscode.ConfigurationTarget.Global);
			await assert.rejects(provider.currentUser(), /not an Azure DevOps repository/);
			assert.strictEqual(calls.length, 1);
		} finally {
			await configuration.update('serverCollections', previous, vscode.ConfigurationTarget.Global);
		}
	});

	it('discovers Azure repositories through the original folder manager and reuses its shared repository state', async () => {
		const { sessions, credentials, context, telemetry, calls } = fixture();
		const repositories = new RepositoriesManager(credentials, telemetry);
		const git = new GitApiImpl(repositories);
		const local = new MockRepository();
		local.state.remotes.push(
			{ name: 'origin', fetchUrl: 'https://dev.azure.com/First/Project/_git/Repo', isReadOnly: false },
			{ name: 'github', fetchUrl: 'https://github.com/owner/repo', isReadOnly: false },
		);
		sandbox.stub(local, 'getConfigs').resolves([]);
		const helper = new CreatePullRequestHelper();
		const manager = new FolderRepositoryManager(0, context, local, telemetry, git, credentials, helper, new MockThemeWatcher());
		repositories.insertFolderManager(manager);
		disposables.push(repositories, git, helper, manager);
		const legacyTransport = sandbox.spy(credentials, 'getHub');
		assert.strictEqual(await manager.updateRepositories(), true);
		assert.strictEqual(manager.state, ReposManagerState.RepositoriesLoaded);
		assert.strictEqual(manager.gitHubRepositories.length, 1);
		const repository = manager.gitHubRepositories[0];
		assert.strictEqual(repository.provider, sessions.provider(repository.remote));
		assert.strictEqual(repository.remote.githubServerType, GitHubServerType.AzureDevOps);
		assert.strictEqual(await repository.getDefaultBranch(), 'main');
		assert.strictEqual((await repository.getAuthenticatedUser()).id, 'First');
		assert.throws(() => repository.hub, /GitHub transport is unavailable/);
		await manager.updateRepositories();
		assert.strictEqual(manager.gitHubRepositories[0], repository);
		assert.strictEqual(legacyTransport.callCount, 0);
		assert.ok(calls.every(url => url.hostname === 'dev.azure.com'));
		assert.strictEqual(calls.some(url => /graphql|github|workitems/i.test(url.pathname)), false);
	});

	it('keeps private drafts when signing out and clears shared repository state on the session event', async () => {
		const { sessions, credentials, context, telemetry } = fixture();
		const repositories = new RepositoriesManager(credentials, telemetry);
		const git = new GitApiImpl(repositories);
		const local = new MockRepository();
		local.state.remotes.push({ name: 'origin', fetchUrl: 'https://dev.azure.com/First/Project/_git/Repo', isReadOnly: false });
		sandbox.stub(local, 'getConfigs').resolves([]);
		const helper = new CreatePullRequestHelper();
		const manager = new FolderRepositoryManager(0, context, local, telemetry, git, credentials, helper, new MockThemeWatcher());
		disposables.push(repositories, git, helper, manager, credentials.onDidChangeSessions(() => manager.clearForAuthChange()));
		await manager.updateRepositories();
		const drafts = { private: 'Keep this draft' };
		await context.globalState.update('azureDevOps.pendingReviews.v1', drafts);
		await sessions.signOut();
		assert.strictEqual(manager.gitHubRepositories.length, 0);
		assert.strictEqual(await manager.updateRepositories(), false);
		assert.strictEqual(manager.state, ReposManagerState.NeedsAuthentication);
		assert.deepStrictEqual(context.globalState.get('azureDevOps.pendingReviews.v1'), drafts);
		assert.strictEqual(await context.secrets.get('azureDevOps.pat:https://dev.azure.com/first'), undefined);
	});
});
