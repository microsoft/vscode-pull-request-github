/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { SinonSandbox, createSandbox } from 'sinon';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { CredentialStore } from '../../github/credentials';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('CopilotRemoteAgentManager', function () {
	let sandbox: SinonSandbox;
	let manager: CopilotRemoteAgentManager;
	let mockCredentialStore: Partial<CredentialStore>;
	let mockRepositoriesManager: Partial<RepositoriesManager>;
	let mockTelemetry: MockTelemetry;

	beforeEach(function () {
		sandbox = createSandbox();
		mockTelemetry = new MockTelemetry();

		// Mock credential store
		mockCredentialStore = {
			onDidChangeSessions: sandbox.stub().returns({ dispose: sandbox.stub() })
		};

		// Mock repositories manager  
		mockRepositoriesManager = {
			folderManagers: [],
			onDidChangeState: sandbox.stub().returns({ dispose: sandbox.stub() }),
			onDidChangeFolderRepositories: sandbox.stub().returns({ dispose: sandbox.stub() })
		};

		manager = new CopilotRemoteAgentManager(
			mockCredentialStore as CredentialStore,
			mockRepositoriesManager as RepositoriesManager,
			mockTelemetry
		);
	});

	afterEach(function () {
		sandbox.restore();
		manager.dispose();
	});

	describe('basic properties', function () {
		it('should have enabled property', function () {
			assert.strictEqual(typeof manager.enabled, 'boolean');
		});

		it('should have autoCommitAndPushEnabled property', function () {
			assert.strictEqual(typeof manager.autoCommitAndPushEnabled, 'boolean');
		});

		it('should have static ID property', function () {
			assert.strictEqual(CopilotRemoteAgentManager.ID, 'CopilotRemoteAgentManager');
		});
	});

	describe('isAvailable', function () {
		it('should return boolean value', async function () {
			const result = await manager.isAvailable();
			assert.strictEqual(typeof result, 'boolean');
		});

		it('should return false when no folder managers', async function () {
			const result = await manager.isAvailable();
			assert.strictEqual(result, false);
		});
	});

	describe('isAssignable', function () {
		it('should return boolean value', async function () {
			const result = await manager.isAssignable();
			assert.strictEqual(typeof result, 'boolean');
		});

		it('should return false when no folder managers', async function () {
			const result = await manager.isAssignable();
			assert.strictEqual(result, false);
		});
	});

	describe('repoInfo', function () {
		it('should return undefined when no folder managers', async function () {
			const result = await manager.repoInfo();
			assert.strictEqual(result, undefined);
		});
	});

	describe('addFollowUpToExistingPR', function () {
		it('should return undefined when no repo info', async function () {
			const result = await manager.addFollowUpToExistingPR(123, 'Add tests');
			assert.strictEqual(result, undefined);
		});
	});

	describe('commandImpl', function () {
		it('should return undefined for undefined args', async function () {
			const result = await manager.commandImpl(undefined);
			assert.strictEqual(result, undefined);
		});

		it('should return undefined for empty user prompt', async function () {
			const args = {
				userPrompt: '',
				source: 'chat'
			};

			const result = await manager.commandImpl(args);
			assert.strictEqual(result, undefined);
		});

		it('should return undefined when no repo info', async function () {
			const args = {
				userPrompt: 'Test',
				source: 'chat'
			};

			const result = await manager.commandImpl(args);
			assert.strictEqual(result, undefined);
		});
	});

	describe('invokeRemoteAgent', function () {
		it('should return error when copilot API unavailable', async function () {
			const result = await manager.invokeRemoteAgent('Test prompt', 'Test context');

			assert.strictEqual(result.state, 'error');
			if (result.state === 'error') {
				assert.ok(result.error);
			}
		});

		it('should return error when no repo info', async function () {
			const result = await manager.invokeRemoteAgent('Test prompt', 'Test context');

			assert.strictEqual(result.state, 'error');
			if (result.state === 'error') {
				assert.ok(result.error);
			}
		});
	});

	describe('getSessionLogsFromAction', function () {
		it('should return empty array when no copilot API', async function () {
			const mockPR = { number: 123 } as any;

			const result = await manager.getSessionLogsFromAction(mockPR);

			assert.deepStrictEqual(result, []);
		});
	});

	describe('getWorkflowStepsFromAction', function () {
		it('should return empty array when no latest run', async function () {
			const mockPR = {} as any;

			const result = await manager.getWorkflowStepsFromAction(mockPR);

			assert.deepStrictEqual(result, []);
		});
	});

	describe('state management', function () {
		it('should return notification count', function () {
			const count = manager.notificationsCount;
			assert.strictEqual(typeof count, 'number');
		});

		it('should check notification existence', function () {
			const hasNotification = manager.hasNotification('owner', 'repo', 123);
			assert.strictEqual(typeof hasNotification, 'boolean');
		});

		it('should get state for PR', function () {
			const state = manager.getStateForPR('owner', 'repo', 123);
			assert.ok(state !== undefined);
		});

		it('should get counts', function () {
			const counts = manager.getCounts();
			assert.ok(counts);
			assert.strictEqual(typeof counts.total, 'number');
			assert.strictEqual(typeof counts.inProgress, 'number');
			assert.strictEqual(typeof counts.error, 'number');
		});
	});

	describe('chat sessions', function () {
		it('should provide empty chat sessions when no copilot API', async function () {
			const token = { isCancellationRequested: false } as any;

			const result = await manager.provideChatSessions(token);

			assert.deepStrictEqual(result, []);
		});

		it('should handle cancelled token', async function () {
			const token = { isCancellationRequested: true } as any;

			const result = await manager.provideChatSessions(token);

			assert.deepStrictEqual(result, []);
		});
	});

	describe('event handling', function () {
		it('should have event emitters', function () {
			assert.ok(manager.onDidChangeStates);
			assert.ok(manager.onDidChangeNotifications);
			assert.ok(manager.onDidCreatePullRequest);
			assert.ok(manager.onDidChangeChatSessions);
		});
	});

	describe('lifecycle', function () {
		it('should dispose without errors', function () {
			assert.doesNotThrow(() => {
				manager.dispose();
			});
		});

		it('should be constructible', function () {
			assert.ok(manager);
			assert.ok(manager instanceof CopilotRemoteAgentManager);
		});
	});
});