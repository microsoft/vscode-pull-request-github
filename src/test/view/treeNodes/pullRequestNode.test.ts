/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SinonSandbox, createSandbox } from 'sinon';
import { default as assert } from 'assert';

import { PRNode } from '../../../view/treeNodes/pullRequestNode';
import { PullRequestModel } from '../../../github/pullRequestModel';
import { FolderRepositoryManager } from '../../../github/folderRepositoryManager';
import { MockTelemetry } from '../../mocks/mockTelemetry';
import { MockExtensionContext } from '../../mocks/mockExtensionContext';
import { MockRepository } from '../../mocks/mockRepository';
import { MockGitHubRepository } from '../../mocks/mockGitHubRepository';
import { MockThemeWatcher } from '../../mocks/mockThemeWatcher';
import { GitHubRemote } from '../../../common/remote';
import { Protocol } from '../../../common/protocol';
import { CredentialStore } from '../../../github/credentials';
import { parseGraphQLPullRequest } from '../../../github/utils';
import { GitApiImpl } from '../../../api/api1';
import { RepositoriesManager } from '../../../github/repositoriesManager';
import { GitHubServerType } from '../../../common/authentication';
import { CreatePullRequestHelper } from '../../../view/createPullRequestHelper';
import { MockNotificationManager } from '../../mocks/mockNotificationManager';
import { PrsTreeModel } from '../../../view/prsTreeModel';
import { NotificationsManager } from '../../../notifications/notificationsManager';

describe('PRNode', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;
	let reposManager: RepositoriesManager;
	let createPrHelper: CreatePullRequestHelper;
	let mockThemeWatcher: MockThemeWatcher;
	let mockNotificationsManager: MockNotificationManager;
	let prsTreeModel: PrsTreeModel;

	beforeEach(function () {
		sinon = createSandbox();
		mockThemeWatcher = new MockThemeWatcher();
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentialStore = new CredentialStore(telemetry, context);
		reposManager = new RepositoriesManager(credentialStore, telemetry);
		prsTreeModel = new PrsTreeModel(telemetry, reposManager, context);
		mockNotificationsManager = new MockNotificationManager();
		createPrHelper = new CreatePullRequestHelper();
	});

	afterEach(function () {
		context.dispose();
		sinon.restore();
	});

	describe('PR title truncation', function () {
		it('truncates long PR titles when horizontal scrolling is disabled', async function () {
			// Setup a PR with a very long title
			const longTitle = 'This is a very long pull request title that exceeds fifty characters and should be truncated when horizontal scrolling is disabled';
			const url = 'git@github.com:test/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const gitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			gitHubRepository.buildMetadata(m => {
				m.clone_url('https://github.com/test/repo');
			});

			const pr = gitHubRepository.addGraphQLPullRequest(builder => {
				builder.pullRequest(pr => {
					pr.repository(r =>
						r.pullRequest(p => {
							p.databaseId(1234);
							p.number(1234);
							p.title(longTitle);
							p.author(a => a.login('testuser').avatarUrl('https://github.com/testuser.jpg'));
							p.baseRef!(b => b.repository(br => br.url('https://github.com/test/repo')));
							p.baseRepository(r => r.url('https://github.com/test/repo'));
						}),
					);
				});
			}).pullRequest;
			const prItem = await parseGraphQLPullRequest(pr.repository!.pullRequest, gitHubRepository);
			const pullRequestModel = new PullRequestModel(credentialStore, telemetry, gitHubRepository, remote, prItem);

			const repository = new MockRepository();
			await repository.addRemote(remote.remoteName, remote.url);
			const manager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);

			// Stub horizontal scrolling setting to be false (default)
			sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
				if (section === 'workbench') {
					return {
						get: (key: string, defaultValue?: any) => {
							if (key === 'list.horizontalScrolling') {
								return false;
							}
							return defaultValue;
						},
					} as any;
				}
				// Return a mock for other configurations
				return {
					get: (key: string, defaultValue?: any) => defaultValue,
				} as any;
			});

			const prNode = new PRNode(
				{} as any,
				manager,
				pullRequestModel,
				false,
				mockNotificationsManager as NotificationsManager,
				prsTreeModel,
			);

			const treeItem = await prNode.getTreeItem();
			const label = (treeItem.label as vscode.TreeItemLabel2).label as vscode.MarkdownString;

			// Title should be truncated to 50 characters plus '...'
			assert.ok(label.value.includes('...'));
			assert.ok(label.value.length < longTitle.length);
			assert.strictEqual(label.value, longTitle.substring(0, 50) + '...');
		});

		it('shows full PR title when horizontal scrolling is enabled', async function () {
			// Setup a PR with a very long title
			const longTitle = 'This is a very long pull request title that exceeds fifty characters and should NOT be truncated when horizontal scrolling is enabled';
			const url = 'git@github.com:test/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const gitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			gitHubRepository.buildMetadata(m => {
				m.clone_url('https://github.com/test/repo');
			});

			const pr = gitHubRepository.addGraphQLPullRequest(builder => {
				builder.pullRequest(pr => {
					pr.repository(r =>
						r.pullRequest(p => {
							p.databaseId(5678);
							p.number(5678);
							p.title(longTitle);
							p.author(a => a.login('testuser').avatarUrl('https://github.com/testuser.jpg'));
							p.baseRef!(b => b.repository(br => br.url('https://github.com/test/repo')));
							p.baseRepository(r => r.url('https://github.com/test/repo'));
						}),
					);
				});
			}).pullRequest;
			const prItem = await parseGraphQLPullRequest(pr.repository!.pullRequest, gitHubRepository);
			const pullRequestModel = new PullRequestModel(credentialStore, telemetry, gitHubRepository, remote, prItem);

			const repository = new MockRepository();
			await repository.addRemote(remote.remoteName, remote.url);
			const manager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);

			// Stub horizontal scrolling setting to be true
			sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
				if (section === 'workbench') {
					return {
						get: (key: string, defaultValue?: any) => {
							if (key === 'list.horizontalScrolling') {
								return true;
							}
							return defaultValue;
						},
					} as any;
				}
				// Return a mock for other configurations
				return {
					get: (key: string, defaultValue?: any) => defaultValue,
				} as any;
			});

			const prNode = new PRNode(
				{} as any,
				manager,
				pullRequestModel,
				false,
				mockNotificationsManager as NotificationsManager,
				prsTreeModel,
			);

			const treeItem = await prNode.getTreeItem();
			const label = (treeItem.label as vscode.TreeItemLabel2).label as vscode.MarkdownString;

			// Title should NOT be truncated when horizontal scrolling is enabled
			assert.ok(!label.value.includes('...'));
			assert.strictEqual(label.value, longTitle);
		});

		it('does not truncate short PR titles regardless of horizontal scrolling setting', async function () {
			const shortTitle = 'Short title';
			const url = 'git@github.com:test/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const gitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
			gitHubRepository.buildMetadata(m => {
				m.clone_url('https://github.com/test/repo');
			});

			const pr = gitHubRepository.addGraphQLPullRequest(builder => {
				builder.pullRequest(pr => {
					pr.repository(r =>
						r.pullRequest(p => {
							p.databaseId(9999);
							p.number(9999);
							p.title(shortTitle);
							p.author(a => a.login('testuser').avatarUrl('https://github.com/testuser.jpg'));
							p.baseRef!(b => b.repository(br => br.url('https://github.com/test/repo')));
							p.baseRepository(r => r.url('https://github.com/test/repo'));
						}),
					);
				});
			}).pullRequest;
			const prItem = await parseGraphQLPullRequest(pr.repository!.pullRequest, gitHubRepository);
			const pullRequestModel = new PullRequestModel(credentialStore, telemetry, gitHubRepository, remote, prItem);

			const repository = new MockRepository();
			await repository.addRemote(remote.remoteName, remote.url);
			const manager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(reposManager), credentialStore, createPrHelper, mockThemeWatcher);

			// Test with horizontal scrolling disabled
			sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
				if (section === 'workbench') {
					return {
						get: (key: string, defaultValue?: any) => {
							if (key === 'list.horizontalScrolling') {
								return false;
							}
							return defaultValue;
						},
					} as any;
				}
				return {
					get: (key: string, defaultValue?: any) => defaultValue,
				} as any;
			});

			const prNode = new PRNode(
				{} as any,
				manager,
				pullRequestModel,
				false,
				mockNotificationsManager as NotificationsManager,
				prsTreeModel,
			);

			const treeItem = await prNode.getTreeItem();
			const label = (treeItem.label as vscode.TreeItemLabel2).label as vscode.MarkdownString;

			// Short title should not be truncated
			assert.ok(!label.value.includes('...'));
			assert.strictEqual(label.value, shortTitle);
		});
	});
});
