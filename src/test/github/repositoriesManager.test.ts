/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SinonSandbox, createSandbox } from 'sinon';
import { default as assert } from 'assert';

import { RepositoriesManager } from '../../github/repositoriesManager';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { GitApiImpl } from '../../api/api1';
import { CredentialStore } from '../../github/credentials';

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
		reposManager = new RepositoriesManager(credentialStore, telemetry);
		credentialStore = new CredentialStore(telemetry, context);
		createPrHelper = new CreatePullRequestHelper();
	});

	afterEach(function () {
		context.dispose();
		sinon.restore();
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

	describe('removeMissingRepos', function () {
		let tmpDir: string;

		beforeEach(function () {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-pr-test-'));
		});

		afterEach(function () {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it('removes folder managers whose root URIs no longer exist on disk', async function () {
			const existingDir = path.join(tmpDir, 'existing-repo');
			fs.mkdirSync(existingDir);

			const removedDir = path.join(tmpDir, 'removed-worktree');
			fs.mkdirSync(removedDir);

			const repo1 = new MockRepository();
			repo1.rootUri = vscode.Uri.file(existingDir);
			repo1.addRemote('origin', 'git@github.com:aaa/bbb');

			const repo2 = new MockRepository();
			repo2.rootUri = vscode.Uri.file(removedDir);
			repo2.addRemote('origin', 'git@github.com:aaa/bbb');

			reposManager.insertFolderManager(new FolderRepositoryManager(0, context, repo1, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));
			reposManager.insertFolderManager(new FolderRepositoryManager(1, context, repo2, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));

			assert.strictEqual(reposManager.folderManagers.length, 2);

			// Remove the directory to simulate worktree deletion
			fs.rmSync(removedDir, { recursive: true });

			await reposManager.removeMissingRepos();

			assert.strictEqual(reposManager.folderManagers.length, 1);
			assert.strictEqual(reposManager.folderManagers[0].repository.rootUri.toString(), repo1.rootUri.toString());
		});

		it('keeps all repos when all paths exist on disk', async function () {
			const dir1 = path.join(tmpDir, 'repo1');
			fs.mkdirSync(dir1);

			const dir2 = path.join(tmpDir, 'repo2');
			fs.mkdirSync(dir2);

			const repo1 = new MockRepository();
			repo1.rootUri = vscode.Uri.file(dir1);
			repo1.addRemote('origin', 'git@github.com:aaa/bbb');

			const repo2 = new MockRepository();
			repo2.rootUri = vscode.Uri.file(dir2);
			repo2.addRemote('origin', 'git@github.com:ccc/ddd');

			reposManager.insertFolderManager(new FolderRepositoryManager(0, context, repo1, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));
			reposManager.insertFolderManager(new FolderRepositoryManager(1, context, repo2, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher));

			await reposManager.removeMissingRepos();

			assert.strictEqual(reposManager.folderManagers.length, 2);
		});

		it('does nothing when there are no folder managers', async function () {
			assert.strictEqual(reposManager.folderManagers.length, 0);
			await reposManager.removeMissingRepos();
			assert.strictEqual(reposManager.folderManagers.length, 0);
		});
	});
});
