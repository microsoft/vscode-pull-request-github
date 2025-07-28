/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';

import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { CredentialStore } from '../../github/credentials';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { ReposManagerState } from '../../github/folderRepositoryManager';

describe('CopilotRemoteAgentManager', function () {
	let sinon: SinonSandbox;
	let manager: CopilotRemoteAgentManager;
	let credentialStore: CredentialStore;
	let repositoriesManager: RepositoriesManager;
	let telemetry: MockTelemetry;

	beforeEach(function () {
		sinon = createSandbox();
		telemetry = new MockTelemetry();
		const context = new MockExtensionContext();
		credentialStore = new CredentialStore(telemetry, context);
		repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		manager = new CopilotRemoteAgentManager(credentialStore, repositoriesManager, telemetry);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('provideChatSessions', function () {
		it('should wait for repository manager initialization', async function () {
			// Arrange
			const token = new vscode.CancellationTokenSource().token;

			// Mock the copilot API to return undefined (no API available)
			sinon.stub(manager as any, 'copilotApi').get(() => Promise.resolve(undefined));

			// Spy on waitRepoManagerInitialization to verify it's called
			const waitSpy = sinon.stub(manager as any, 'waitRepoManagerInitialization').resolves();

			// Act
			const result = await manager.provideChatSessions(token);

			// Assert
			assert(waitSpy.calledOnce, 'waitRepoManagerInitialization should be called');
			assert.strictEqual(result.length, 0, 'Should return empty array when no copilot API');
		});

		it('should call waitRepoManagerInitialization before getAllCodingAgentPRs', async function () {
			// Arrange
			const token = new vscode.CancellationTokenSource().token;

			// Create mock copilot API
			const mockCopilotApi = {
				getAllCodingAgentPRs: sinon.stub().resolves([])
			};

			sinon.stub(manager as any, 'copilotApi').get(() => Promise.resolve(mockCopilotApi));

			// Spy on waitRepoManagerInitialization
			const waitSpy = sinon.stub(manager as any, 'waitRepoManagerInitialization').resolves();

			// Act
			await manager.provideChatSessions(token);

			// Assert - verify waitRepoManagerInitialization was called before getAllCodingAgentPRs
			assert(waitSpy.calledBefore(mockCopilotApi.getAllCodingAgentPRs),
				'waitRepoManagerInitialization should be called before getAllCodingAgentPRs');
		});

		it('should return early if cancelled before waiting for repo manager', async function () {
			// Arrange
			const tokenSource = new vscode.CancellationTokenSource();
			tokenSource.cancel(); // Cancel immediately
			const token = tokenSource.token;

			// Mock the copilot API
			const mockCopilotApi = {
				getAllCodingAgentPRs: sinon.stub().resolves([])
			};
			sinon.stub(manager as any, 'copilotApi').get(() => Promise.resolve(mockCopilotApi));

			// Spy on waitRepoManagerInitialization
			const waitSpy = sinon.stub(manager as any, 'waitRepoManagerInitialization').resolves();

			// Act
			const result = await manager.provideChatSessions(token);

			// Assert - should return early and not call waitRepoManagerInitialization
			assert(!waitSpy.called, 'waitRepoManagerInitialization should not be called when token is cancelled');
			assert(!mockCopilotApi.getAllCodingAgentPRs.called, 'getAllCodingAgentPRs should not be called when token is cancelled');
			assert.strictEqual(result.length, 0, 'Should return empty array when cancelled');
		});
	});
});