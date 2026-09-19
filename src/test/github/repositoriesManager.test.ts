/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
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
import { GitHubServerType } from '../../common/authentication';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { PullRequestModel } from '../../github/pullRequestModel';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';

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
	describe('getManagerForIssueModel', function () {
		const protocol = new Protocol('https://github.com/aaa/bbb.git');
		const remote = new GitHubRemote('origin', 'aaa/bbb', protocol, GitHubServerType.GitHubDotCom);

		function createFolderManagers(): { mainFolder: FolderRepositoryManager; worktreeFolder: FolderRepositoryManager } {
			// A repository and one of its worktrees, both open as folders and both pointing at the same GitHub remote.
			const mainRepo = new MockRepository();
			mainRepo.rootUri = vscode.Uri.file('/repo');
			mainRepo.addRemote('origin', 'git@github.com:aaa/bbb');

			const worktreeRepo = new MockRepository();
			worktreeRepo.rootUri = vscode.Uri.file('/repo/worktrees/2');
			worktreeRepo.addRemote('origin', 'git@github.com:aaa/bbb');

			const mainFolder = new FolderRepositoryManager(0, context, mainRepo, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			const worktreeFolder = new FolderRepositoryManager(1, context, worktreeRepo, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);
			reposManager.insertFolderManager(mainFolder);
			reposManager.insertFolderManager(worktreeFolder);
			return { mainFolder, worktreeFolder };
		}

		function createPullRequest(gitHubRepository: MockGitHubRepository, number: number): PullRequestModel {
			const pr = new PullRequestBuilder().number(number).build();
			return new PullRequestModel(credentialStore, telemetry, gitHubRepository, remote, convertRESTPullRequestToRawPullRequest(pr, gitHubRepository));
		}

		it('prefers the folder that owns the model when several folders share the remote', function () {
			const { mainFolder, worktreeFolder } = createFolderManagers();
			const mainGitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			const worktreeGitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			sinon.stub(mainFolder, 'gitHubRepositories').get(() => [mainGitHubRepository]);
			sinon.stub(worktreeFolder, 'gitHubRepositories').get(() => [worktreeGitHubRepository]);

			const pullRequest = createPullRequest(worktreeGitHubRepository, 1);

			// The plain remote lookup returns whichever folder comes first.
			assert.strictEqual(reposManager.getManagerForRepository('aaa', 'bbb'), reposManager.folderManagers[0]);
			// The model lookup returns the folder the model came from.
			assert.strictEqual(reposManager.getManagerForIssueModel(pullRequest), worktreeFolder);
		});

		it('falls back to the folder that has the pull request checked out', function () {
			const { mainFolder, worktreeFolder } = createFolderManagers();
			const mainGitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			const worktreeGitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			const detachedGitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			sinon.stub(mainFolder, 'gitHubRepositories').get(() => [mainGitHubRepository]);
			sinon.stub(worktreeFolder, 'gitHubRepositories').get(() => [worktreeGitHubRepository]);
			sinon.stub(worktreeFolder, 'activePullRequest').get(() => createPullRequest(worktreeGitHubRepository, 2));

			// A model that belongs to neither folder, e.g. resolved from a URI, for the pull request checked out in the worktree.
			const pullRequest = createPullRequest(detachedGitHubRepository, 2);

			assert.strictEqual(reposManager.getManagerForIssueModel(pullRequest), worktreeFolder);
		});

		it('falls back to the remote match when no folder owns or has checked out the model', function () {
			const { mainFolder, worktreeFolder } = createFolderManagers();
			const mainGitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			const worktreeGitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			const detachedGitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			sinon.stub(mainFolder, 'gitHubRepositories').get(() => [mainGitHubRepository]);
			sinon.stub(worktreeFolder, 'gitHubRepositories').get(() => [worktreeGitHubRepository]);

			const pullRequest = createPullRequest(detachedGitHubRepository, 3);

			assert.strictEqual(reposManager.getManagerForIssueModel(pullRequest), reposManager.getManagerForRepository('aaa', 'bbb'));
		});

		it('returns undefined for an undefined model', function () {
			createFolderManagers();
			assert.strictEqual(reposManager.getManagerForIssueModel(undefined), undefined);
		});
	});
});
