/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import { Uri } from 'vscode';
import { GitHubServerType } from '../../common/authentication';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { GitApiImpl } from '../../api/api1';
import { RemoteOnlyRepository } from '../../api/remoteOnlyRepository';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { FolderRepositoryManagerResolver } from '../../github/folderRepositoryManagerResolver';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';

describe('FolderRepositoryManagerResolver', function () {
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;
	let repositoriesManager: RepositoriesManager;
	let sandbox: SinonSandbox;

	beforeEach(function () {
		sandbox = createSandbox();
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
	});

	afterEach(function () {
		repositoriesManager.dispose();
		credentialStore.dispose();
		context.dispose();
		sandbox.restore();
	});

	function createResolver(): FolderRepositoryManagerResolver {
		const resolver = new FolderRepositoryManagerResolver(context, repositoriesManager, telemetry);
		context.subscriptions.push(resolver);
		return resolver;
	}

	async function addLocalManager(url: string): Promise<FolderRepositoryManager> {
		const repository = new MockRepository();
		repository.rootUri = Uri.file('/workspace');
		await repository.addRemote('origin', url);
		const git = new GitApiImpl(repositoriesManager);
		const helper = new CreatePullRequestHelper();
		context.subscriptions.push(git, helper);
		const manager = new FolderRepositoryManager(0, context, repository, telemetry, git, credentialStore, helper, new MockThemeWatcher());
		const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		const repo = new MockGitHubRepository(remote, credentialStore, telemetry, sandbox);
		context.subscriptions.push(repo);
		sandbox.stub(manager, 'gitHubRepositories').get(() => [repo]);
		repositoriesManager.insertFolderManager(manager);
		return manager;
	}

	for (const url of ['https://github.com/Owner/Repo.git', 'git@github.com:Owner/Repo.git']) {
		it(`uses the discovered local manager for ${url}`, async function () {
			const manager = await addLocalManager(url);
			const resolver = createResolver();

			assert.strictEqual(resolver.getManagerForRepository('owner', 'repo'), manager);
		});
	}

	it('reuses the remote-only manager only when no local repository matches', async function () {
		const resolver = createResolver();
		const remoteManager = resolver.getManagerForRepository('owner', 'repo');
		assert.ok(remoteManager.repository instanceof RemoteOnlyRepository);
		assert.strictEqual(resolver.getManagerForRepository('other', 'repo'), remoteManager);
		const localManager = await addLocalManager('https://github.com/owner/repo.git');

		assert.strictEqual(resolver.getManagerForRepository('owner', 'repo'), localManager);
		assert.strictEqual(resolver.getManagerForRepository('other', 'repo'), remoteManager);
	});

	it('can supply a temporary remote-only manager even when a local repository is already discovered', async function () {
		const localManager = await addLocalManager('https://github.com/owner/repo.git');
		const resolver = createResolver();

		assert.strictEqual(resolver.getManagerForRepository('owner', 'repo'), localManager);
		assert.ok(resolver.getRemoteOnlyManager().repository instanceof RemoteOnlyRepository);
		assert.strictEqual(resolver.getRemoteOnlyManager(), resolver.getRemoteOnlyManager());
	});
});
