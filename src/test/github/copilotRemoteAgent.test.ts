/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';

import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { COPILOT_LOGINS } from '../../common/copilot';
import { CredentialStore } from '../../github/credentials';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';

describe('CopilotRemoteAgentManager', function () {
	let sinon: SinonSandbox;
	let copilotManager: CopilotRemoteAgentManager;
	let credentialStore: CredentialStore;
	let repositoriesManager: RepositoriesManager;
	let telemetry: MockTelemetry;

	beforeEach(function () {
		sinon = createSandbox();
		telemetry = new MockTelemetry();
		const context = new MockExtensionContext();
		credentialStore = new CredentialStore(telemetry, context);
		repositoriesManager = new RepositoriesManager(credentialStore, telemetry);
		copilotManager = new CopilotRemoteAgentManager(credentialStore, repositoriesManager);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('isAssignable', function () {
		it('should return false when no repo info available', async function () {
			sinon.stub(copilotManager, 'repoInfo').resolves(undefined);
			const result = await copilotManager.isAssignable();
			assert.strictEqual(result, false);
		});

		it('should return false when no assignable users available', async function () {
			const mockRepoInfo = {
				owner: 'testowner',
				repo: 'testrepo',
				remote: 'origin',
				baseRef: 'main',
				repository: {} as any
			};
			sinon.stub(copilotManager, 'repoInfo').resolves(mockRepoInfo);
			
			const mockFolderManager = {
				getAssignableUsers: sinon.stub().resolves({}),
				getAllAssignableUsers: sinon.stub().returns(undefined)
			};
			sinon.stub(copilotManager as any, 'getFolderManagerForRepo').returns(mockFolderManager);

			const result = await copilotManager.isAssignable();
			assert.strictEqual(result, false);
		});

		it('should return true when copilot agent is in assignable users', async function () {
			const mockRepoInfo = {
				owner: 'testowner',
				repo: 'testrepo',
				remote: 'origin',
				baseRef: 'main',
				repository: {} as any
			};
			sinon.stub(copilotManager, 'repoInfo').resolves(mockRepoInfo);
			
			const mockAssignableUsers = [
				{ login: 'user1', id: '1', url: '', accountType: 0 },
				{ login: COPILOT_LOGINS[1], id: '2', url: '', accountType: 1 }, // copilot-swe-agent
				{ login: 'user3', id: '3', url: '', accountType: 0 }
			];

			const mockFolderManager = {
				getAssignableUsers: sinon.stub().resolves({}),
				getAllAssignableUsers: sinon.stub().returns(mockAssignableUsers)
			};
			sinon.stub(copilotManager as any, 'getFolderManagerForRepo').returns(mockFolderManager);

			const result = await copilotManager.isAssignable();
			assert.strictEqual(result, true);
		});

		it('should return false when copilot agent is not in assignable users', async function () {
			const mockRepoInfo = {
				owner: 'testowner',
				repo: 'testrepo',
				remote: 'origin',
				baseRef: 'main',
				repository: {} as any
			};
			sinon.stub(copilotManager, 'repoInfo').resolves(mockRepoInfo);
			
			const mockAssignableUsers = [
				{ login: 'user1', id: '1', url: '', accountType: 0 },
				{ login: 'user2', id: '2', url: '', accountType: 0 },
				{ login: 'user3', id: '3', url: '', accountType: 0 }
			];

			const mockFolderManager = {
				getAssignableUsers: sinon.stub().resolves({}),
				getAllAssignableUsers: sinon.stub().returns(mockAssignableUsers)
			};
			sinon.stub(copilotManager as any, 'getFolderManagerForRepo').returns(mockFolderManager);

			const result = await copilotManager.isAssignable();
			assert.strictEqual(result, false);
		});

		it('should return false when there is an error fetching assignable users', async function () {
			const mockRepoInfo = {
				owner: 'testowner',
				repo: 'testrepo',
				remote: 'origin',
				baseRef: 'main',
				repository: {} as any
			};
			sinon.stub(copilotManager, 'repoInfo').resolves(mockRepoInfo);
			
			const mockFolderManager = {
				getAssignableUsers: sinon.stub().rejects(new Error('Network error')),
				getAllAssignableUsers: sinon.stub().returns([])
			};
			sinon.stub(copilotManager as any, 'getFolderManagerForRepo').returns(mockFolderManager);

			const result = await copilotManager.isAssignable();
			assert.strictEqual(result, false);
		});
	});

	describe('isAvailable', function () {
		it('should return false when not enabled', async function () {
			sinon.stub(copilotManager, 'enabled').returns(false);
			sinon.stub(copilotManager, 'isAssignable').resolves(true);

			const result = await copilotManager.isAvailable();
			assert.strictEqual(result, false);
		});

		it('should return false when not assignable', async function () {
			sinon.stub(copilotManager, 'enabled').returns(true);
			sinon.stub(copilotManager, 'isAssignable').resolves(false);

			const result = await copilotManager.isAvailable();
			assert.strictEqual(result, false);
		});

		it('should return true when both enabled and assignable', async function () {
			sinon.stub(copilotManager, 'enabled').returns(true);
			sinon.stub(copilotManager, 'isAssignable').resolves(true);

			const result = await copilotManager.isAvailable();
			assert.strictEqual(result, true);
		});
	});
});