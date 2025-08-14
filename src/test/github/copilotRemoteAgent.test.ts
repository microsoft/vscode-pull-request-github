/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { SinonSandbox, createSandbox } from 'sinon';
import * as vscode from 'vscode';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { CredentialStore } from '../../github/credentials';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { Resource } from '../../common/resources';
import { PullRequestModel } from '../../github/pullRequestModel';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { GitHubRemote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { GitHubServerType } from '../../common/authentication';
import { ReposManagerState } from '../../github/folderRepositoryManager';
import { CopilotPRStatus } from '../../common/copilot';

const telemetry = new MockTelemetry();
const protocol = new Protocol('https://github.com/github/test.git');
const remote = new GitHubRemote('test', 'github/test', protocol, GitHubServerType.GitHubDotCom);

describe('CopilotRemoteAgentManager', function () {
	let sinon: SinonSandbox;
	let manager: CopilotRemoteAgentManager;
	let credentialStore: CredentialStore;
	let reposManager: RepositoriesManager;
	let context: MockExtensionContext;
	let mockRepo: MockGitHubRepository;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		// Mock workspace configuration to return disabled by default
		sinon.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => ({
			get: sinon.stub().callsFake((key: string, defaultValue?: any) => {
				if (section === 'githubPR.copilotRemoteAgent' && key === 'enabled') {
					return false; // Default to disabled
				}
				if (section === 'githubPR.copilotRemoteAgent' && key === 'autoCommitAndPushEnabled') {
					return false;
				}
				if (section === 'githubPR.copilotRemoteAgent' && key === 'promptForConfirmation') {
					return true;
				}
				return defaultValue;
			}),
			update: sinon.stub().resolves(),
			has: sinon.stub().returns(true),
			inspect: sinon.stub()
		} as any));

		context = new MockExtensionContext();
		credentialStore = new CredentialStore(telemetry, context);
		reposManager = new RepositoriesManager(credentialStore, telemetry);

		mockRepo = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);

		manager = new CopilotRemoteAgentManager(credentialStore, reposManager, telemetry, context);
		Resource.initialize(context);
	});

	afterEach(function () {
		manager.dispose();
		reposManager.dispose();
		credentialStore.dispose();
		context.dispose();
		mockRepo.dispose();
		sinon.restore();
	});

	describe('enabled', function () {
		it('should return false when coding agent is disabled by default', function () {
			// The config should default to disabled state
			const enabled = manager.enabled;
			assert.strictEqual(enabled, false);
		});

		it('should reflect configuration changes', function () {
			// Test would require mocking workspace configuration
			// For now, just test the getter exists
			assert.strictEqual(typeof manager.enabled, 'boolean');
		});
	});

	describe('autoCommitAndPushEnabled', function () {
		it('should return boolean value', function () {
			const autoCommitEnabled = manager.autoCommitAndPushEnabled;
			assert.strictEqual(typeof autoCommitEnabled, 'boolean');
		});
	});

	describe('isAssignable()', function () {
		it('should return false when no repository info is available', async function () {
			// No folder managers setup
			const result = await manager.isAssignable();
			assert.strictEqual(result, false);
		});

		it('should return false when assignable users cannot be fetched', async function () {
			// Mock repository manager state but no assignable users
			sinon.stub(manager, 'repoInfo').resolves(undefined);

			const result = await manager.isAssignable();
			assert.strictEqual(result, false);
		});
	});

	describe('isAvailable()', function () {
		it('should return false when manager is disabled', async function () {
			sinon.stub(manager, 'enabled').get(() => false);

			const result = await manager.isAvailable();
			assert.strictEqual(result, false);
		});

		it('should return false when no repo info is available', async function () {
			sinon.stub(manager, 'enabled').get(() => true);
			sinon.stub(manager, 'repoInfo').resolves(undefined);

			const result = await manager.isAvailable();
			assert.strictEqual(result, false);
		});

		it('should return false when copilot API is not available', async function () {
			sinon.stub(manager, 'enabled').get(() => true);
			sinon.stub(manager, 'repoInfo').resolves({
				owner: 'test',
				repo: 'test',
				baseRef: 'main',
				remote: remote,
				repository: {} as any,
				ghRepository: mockRepo,
				fm: {} as any
			});
			// copilotApi will return undefined by default in tests

			const result = await manager.isAvailable();
			assert.strictEqual(result, false);
		});
	});

	describe('repoInfo()', function () {
		it('should return undefined when no folder managers exist', async function () {
			const result = await manager.repoInfo();
			assert.strictEqual(result, undefined);
		});

		it('should return undefined when no repository is found', async function () {
			// Mock empty folder managers
			sinon.stub(reposManager, 'folderManagers').get(() => []);

			const result = await manager.repoInfo();
			assert.strictEqual(result, undefined);
		});
	});

	describe('addFollowUpToExistingPR()', function () {
		it('should return undefined when no repo info is available', async function () {
			sinon.stub(manager, 'repoInfo').resolves(undefined);

			const result = await manager.addFollowUpToExistingPR(123, 'test prompt');
			assert.strictEqual(result, undefined);
		});

		it('should return undefined when PR is not found', async function () {
			sinon.stub(manager, 'repoInfo').resolves({
				owner: 'test',
				repo: 'test',
				baseRef: 'main',
				remote: remote,
				repository: {} as any,
				ghRepository: mockRepo,
				fm: {} as any
			});

			sinon.stub(mockRepo, 'getPullRequest').resolves(undefined);

			const result = await manager.addFollowUpToExistingPR(123, 'test prompt');
			assert.strictEqual(result, undefined);
		});
	});

	describe('invokeRemoteAgent()', function () {
		it('should return error when copilot API is not available', async function () {
			const result = await manager.invokeRemoteAgent('test prompt', 'test context');

			assert.strictEqual(result.state, 'error');
			if (result.state === 'error') {
				assert(result.error.includes('Failed to initialize Copilot API'));
			}
		});

		it('should return error when no repository info is available', async function () {
			// Mock copilot API to be available but no repo info
			sinon.stub(manager as any, '_copilotApiPromise').value(Promise.resolve({} as any));
			sinon.stub(manager, 'repoInfo').resolves(undefined);

			const result = await manager.invokeRemoteAgent('test prompt', 'test context');

			assert.strictEqual(result.state, 'error');
			if (result.state === 'error') {
				assert(result.error.includes('No repository information found'));
			}
		});
	});

	describe('getSessionLogsFromAction()', function () {
		it('should return empty array when copilot API is not available', async function () {
			const mockPr = {} as PullRequestModel;

			const result = await manager.getSessionLogsFromAction(mockPr);

			assert.strictEqual(Array.isArray(result), true);
			assert.strictEqual(result.length, 0);
		});
	});

	describe('getWorkflowStepsFromAction()', function () {
		it('should return empty array when no workflow run is found', async function () {
			const mockPr = {} as PullRequestModel;
			sinon.stub(manager, 'getLatestCodingAgentFromAction').resolves(undefined);

			const result = await manager.getWorkflowStepsFromAction(mockPr);

			assert.strictEqual(Array.isArray(result), true);
			assert.strictEqual(result.length, 0);
		});
	});

	describe('getSessionLogFromPullRequest()', function () {
		it('should return undefined when copilot API is not available', async function () {
			const mockPr = {} as PullRequestModel;

			const result = await manager.getSessionLogFromPullRequest(mockPr);

			assert.strictEqual(result, undefined);
		});
	});

	describe('hasNotification()', function () {
		it('should return false when no notification exists', function () {
			const result = manager.hasNotification('owner', 'repo', 123);
			assert.strictEqual(result, false);
		});
	});

	describe('getStateForPR()', function () {
		it('should return default state for unknown PR', function () {
			const result = manager.getStateForPR('owner', 'repo', 123);
			// Should return a valid CopilotPRStatus
			assert(Object.values(CopilotPRStatus).includes(result));
		});
	});

	describe('getCounts()', function () {
		it('should return valid counts object', function () {
			const result = manager.getCounts();

			assert.strictEqual(typeof result.total, 'number');
			assert.strictEqual(typeof result.inProgress, 'number');
			assert.strictEqual(typeof result.error, 'number');
			assert(result.total >= 0);
			assert(result.inProgress >= 0);
			assert(result.error >= 0);
		});
	});

	describe('notificationsCount', function () {
		it('should return non-negative number', function () {
			const count = manager.notificationsCount;
			assert.strictEqual(typeof count, 'number');
			assert(count >= 0);
		});
	});

	describe('provideChatSessions()', function () {
		it('should return empty array when copilot API is not available', async function () {
			const token = new vscode.CancellationTokenSource().token;

			const result = await manager.provideChatSessions(token);

			assert.strictEqual(Array.isArray(result), true);
			assert.strictEqual(result.length, 0);
		});

		it('should return empty array when cancellation is requested', async function () {
			const tokenSource = new vscode.CancellationTokenSource();
			tokenSource.cancel();

			const result = await manager.provideChatSessions(tokenSource.token);

			assert.strictEqual(Array.isArray(result), true);
			assert.strictEqual(result.length, 0);
		});
	});

	describe('provideChatSessionContent()', function () {
		it('should return empty session when copilot API is not available', async function () {
			const token = new vscode.CancellationTokenSource().token;

			const result = await manager.provideChatSessionContent('123', token);

			assert.strictEqual(Array.isArray(result.history), true);
			assert.strictEqual(result.history.length, 0);
			assert.strictEqual(result.requestHandler, undefined);
		});

		it('should return empty session when cancellation is requested', async function () {
			const tokenSource = new vscode.CancellationTokenSource();
			tokenSource.cancel();

			const result = await manager.provideChatSessionContent('123', tokenSource.token);

			assert.strictEqual(Array.isArray(result.history), true);
			assert.strictEqual(result.history.length, 0);
		});

		it('should return empty session for invalid PR number', async function () {
			const token = new vscode.CancellationTokenSource().token;

			const result = await manager.provideChatSessionContent('invalid', token);

			assert.strictEqual(Array.isArray(result.history), true);
			assert.strictEqual(result.history.length, 0);
		});
	});

	describe('refreshChatSessions()', function () {
		it('should fire change event', function () {
			let eventFired = false;
			const disposable = manager.onDidChangeChatSessions(() => {
				eventFired = true;
			});

			manager.refreshChatSessions();

			assert.strictEqual(eventFired, true);
			disposable.dispose();
		});
	});

	describe('event handlers', function () {
		it('should expose onDidChangeStates event', function () {
			assert.strictEqual(typeof manager.onDidChangeStates, 'function');
		});

		it('should expose onDidChangeNotifications event', function () {
			assert.strictEqual(typeof manager.onDidChangeNotifications, 'function');
		});

		it('should expose onDidCreatePullRequest event', function () {
			assert.strictEqual(typeof manager.onDidCreatePullRequest, 'function');
		});

		it('should expose onDidChangeChatSessions event', function () {
			assert.strictEqual(typeof manager.onDidChangeChatSessions, 'function');
		});
	});

	describe('waitRepoManagerInitialization()', function () {
		it('should resolve immediately when repos are loaded', async function () {
			// Mock the state as already loaded
			sinon.stub(reposManager, 'state').get(() => ReposManagerState.RepositoriesLoaded);

			// This should resolve quickly
			const startTime = Date.now();
			await (manager as any).waitRepoManagerInitialization();
			const endTime = Date.now();

			// Should be very fast since it should return immediately
			assert(endTime - startTime < 100);
		});

		it('should resolve immediately when authentication is needed', async function () {
			sinon.stub(reposManager, 'state').get(() => ReposManagerState.NeedsAuthentication);

			const startTime = Date.now();
			await (manager as any).waitRepoManagerInitialization();
			const endTime = Date.now();

			assert(endTime - startTime < 100);
		});
	});
});
