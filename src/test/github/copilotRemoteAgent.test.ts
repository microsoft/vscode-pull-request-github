/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { SinonSandbox, createSandbox } from 'sinon';
import { CredentialStore } from '../../github/credentials';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockRepository } from '../mocks/mockRepository';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { GitHubRepository } from '../../github/githubRepository';
import { GitApiImpl } from '../../api/api1';
import { CreatePullRequestHelper } from '../../view/createPullRequestHelper';
import { MockThemeWatcher } from '../mocks/mockThemeWatcher';

describe('CopilotRemoteAgentManager', function () {
	let sinon: SinonSandbox;
	let manager: CopilotRemoteAgentManager;
	let credentialStore: CredentialStore;
	let repositoriesManager: RepositoriesManager;
	let telemetry: MockTelemetry;
	let mockThemeWatcher: MockThemeWatcher;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		telemetry = new MockTelemetry();
		mockThemeWatcher = new MockThemeWatcher();
		const context = new MockExtensionContext();
		credentialStore = new CredentialStore(telemetry, context);
		repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		manager = new CopilotRemoteAgentManager(credentialStore, repositoriesManager);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('invokeRemoteAgent base_ref check', function () {
		it('should handle the case when base_ref exists on remote', async function () {
			// Create mock folder repository manager
			const repository = new MockRepository();
			const context = new MockExtensionContext();
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(repositoriesManager), credentialStore, new CreatePullRequestHelper(), mockThemeWatcher);
			
			// Mock repoInfo to return valid info
			sinon.stub(manager, 'repoInfo').resolves({
				owner: 'testowner',
				repo: 'testrepo',
				remote: 'origin',
				baseRef: 'main',
				repository: repository as any
			});

			// Mock getFolderManagerForRepo to return our folder manager
			sinon.stub(manager as any, 'getFolderManagerForRepo').returns(folderManager);

			// Mock the GitHub repository and its methods
			const mockGitHubRepository = sinon.createStubInstance(GitHubRepository);
			mockGitHubRepository.hasBranch.resolves(true); // base_ref exists
			sinon.stub(folderManager, 'getOrigin').resolves(mockGitHubRepository as any);

			// Mock other required methods
			const mockCopilotApi = {
				postRemoteAgentJob: sinon.stub().resolves({
					pull_request: {
						number: 123,
						html_url: 'https://github.com/testowner/testrepo/pull/123'
					}
				})
			};
			sinon.stub(manager as any, 'copilotApi').resolves(mockCopilotApi);

			// Mock autoCommitAndPushEnabled
			sinon.stub(manager, 'autoCommitAndPushEnabled').returns(false);

			const result = await manager.invokeRemoteAgent('test prompt', 'test context', false);

			// Verify that the hasBranch method was called
			assert(mockGitHubRepository.hasBranch.calledOnce);
			assert(mockGitHubRepository.hasBranch.calledWith('main'));
			
			// Since branch exists, no fallback should occur
			assert.equal(mockGitHubRepository.hasBranch.callCount, 1);
		});

		it('should fallback to default branch when base_ref does not exist', async function () {
			const repository = new MockRepository();
			const context = new MockExtensionContext();
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(repositoriesManager), credentialStore, new CreatePullRequestHelper(), mockThemeWatcher);
			
			sinon.stub(manager, 'repoInfo').resolves({
				owner: 'testowner',
				repo: 'testrepo',
				remote: 'origin',
				baseRef: 'nonexistent-branch',
				repository: repository as any
			});

			sinon.stub(manager as any, 'getFolderManagerForRepo').returns(folderManager);

			const mockGitHubRepository = sinon.createStubInstance(GitHubRepository);
			// First call (nonexistent-branch) returns false, second call (default branch) returns true
			mockGitHubRepository.hasBranch.onFirstCall().resolves(false);
			mockGitHubRepository.hasBranch.onSecondCall().resolves(true);
			sinon.stub(folderManager, 'getOrigin').resolves(mockGitHubRepository as any);

			// Mock getPullRequestDefaults to return default branch
			sinon.stub(folderManager, 'getPullRequestDefaults').resolves({
				owner: 'testowner',
				repo: 'testrepo',
				base: 'main'
			});

			sinon.stub(manager as any, 'copilotApi').resolves({
				postRemoteAgentJob: sinon.stub().resolves({
					pull_request: {
						number: 123,
						html_url: 'https://github.com/testowner/testrepo/pull/123'
					}
				})
			});

			sinon.stub(manager, 'autoCommitAndPushEnabled').returns(false);

			const result = await manager.invokeRemoteAgent('test prompt', 'test context', false);

			// Verify that hasBranch was called twice (once for original, once for default)
			assert.equal(mockGitHubRepository.hasBranch.callCount, 2);
			assert(mockGitHubRepository.hasBranch.firstCall.calledWith('nonexistent-branch'));
			assert(mockGitHubRepository.hasBranch.secondCall.calledWith('main'));
		});

		it('should return error when neither base_ref nor default branch exist', async function () {
			const repository = new MockRepository();
			const context = new MockExtensionContext();
			const folderManager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(repositoriesManager), credentialStore, new CreatePullRequestHelper(), mockThemeWatcher);
			
			sinon.stub(manager, 'repoInfo').resolves({
				owner: 'testowner',
				repo: 'testrepo',
				remote: 'origin',
				baseRef: 'nonexistent-branch',
				repository: repository as any
			});

			sinon.stub(manager as any, 'getFolderManagerForRepo').returns(folderManager);

			const mockGitHubRepository = sinon.createStubInstance(GitHubRepository);
			// Both calls return false (neither branch exists)
			mockGitHubRepository.hasBranch.resolves(false);
			sinon.stub(folderManager, 'getOrigin').resolves(mockGitHubRepository as any);

			sinon.stub(folderManager, 'getPullRequestDefaults').resolves({
				owner: 'testowner',
				repo: 'testrepo',
				base: 'main'
			});

			sinon.stub(manager, 'autoCommitAndPushEnabled').returns(false);

			const result = await manager.invokeRemoteAgent('test prompt', 'test context', false);

			// Should return error
			assert.equal(result.state, 'error');
			if (result.state === 'error') {
				assert(result.error.includes('Neither the target branch'));
			}
			
			// Verify that hasBranch was called twice
			assert.equal(mockGitHubRepository.hasBranch.callCount, 2);
		});
	});
});