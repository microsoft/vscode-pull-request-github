/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('CopilotRemoteAgentManager Follow-up Feature', () => {
	let sandbox: SinonSandbox;
	let telemetry: MockTelemetry;
	let manager: CopilotRemoteAgentManager;

	beforeEach(() => {
		sandbox = createSandbox();
		telemetry = new MockTelemetry();

		// Create a basic manager instance with minimal mocks
		const mockCredentialStore = {} as any;
		const mockRepositoriesManager = {} as any;
		manager = new CopilotRemoteAgentManager(mockCredentialStore, mockRepositoriesManager, telemetry);
	});

	afterEach(() => {
		sandbox.restore();
	});

	describe('parseFollowup', () => {
		it('should parse valid followup URL with encoded JSON', () => {
			const followupUrl = 'open-pull-request-webview%7B%22owner%22%3A%22testowner%22%2C%22repo%22%3A%22testrepo%22%2C%22pullRequestNumber%22%3A123%7D';
			const repoInfo = { owner: 'testowner', repo: 'testrepo' };

			const result = (manager as any).parseFollowup(followupUrl, repoInfo);

			assert.strictEqual(result, 123);
		});

		it('should parse valid followup URL with unencoded JSON', () => {
			const followupUrl = 'open-pull-request-webview{"owner":"testowner","repo":"testrepo","pullRequestNumber":456}';
			const repoInfo = { owner: 'testowner', repo: 'testrepo' };

			const result = (manager as any).parseFollowup(followupUrl, repoInfo);

			assert.strictEqual(result, 456);
		});

		it('should return undefined for invalid followup format', () => {
			const followupUrl = 'invalid-format';
			const repoInfo = { owner: 'testowner', repo: 'testrepo' };

			const result = (manager as any).parseFollowup(followupUrl, repoInfo);

			assert.strictEqual(result, undefined);
		});

		it('should return undefined for mismatched repository', () => {
			const followupUrl = 'open-pull-request-webview{"owner":"differentowner","repo":"testrepo","pullRequestNumber":123}';
			const repoInfo = { owner: 'testowner', repo: 'testrepo' };

			const result = (manager as any).parseFollowup(followupUrl, repoInfo);

			assert.strictEqual(result, undefined);
		});

		it('should return undefined for missing followup parameter', () => {
			const result = (manager as any).parseFollowup(undefined, { owner: 'test', repo: 'test' });

			assert.strictEqual(result, undefined);
		});

		it('should return undefined for incomplete followup data', () => {
			const followupUrl = 'open-pull-request-webview{"owner":"testowner"}';
			const repoInfo = { owner: 'testowner', repo: 'testrepo' };

			const result = (manager as any).parseFollowup(followupUrl, repoInfo);

			assert.strictEqual(result, undefined);
		});
	});

	describe('commandImpl with followup integration', () => {
		it('should call parseFollowup when followup parameter is provided', async () => {
			// Mock required methods
			const repoInfoStub = sandbox.stub(manager, 'repoInfo').resolves({
				owner: 'testowner',
				repo: 'testrepo',
				baseRef: 'main',
				remote: {} as any,
				repository: {} as any,
				ghRepository: {} as any,
				fm: {} as any
			});

			const parseFollowupSpy = sandbox.spy(manager as any, 'parseFollowup');
			const addFollowUpStub = sandbox.stub(manager, 'addFollowUpToExistingPR').resolves('Follow-up added successfully');

			const args = {
				userPrompt: 'Test prompt',
				summary: 'Test summary',
				followup: 'open-pull-request-webview{"owner":"testowner","repo":"testrepo","pullRequestNumber":123}'
			};

			const result = await manager.commandImpl(args);

			// Verify that parseFollowup was called
			assert(parseFollowupSpy.calledOnce);
			assert(parseFollowupSpy.calledWith(args.followup, { owner: 'testowner', repo: 'testrepo' }));

			// Verify that addFollowUpToExistingPR was called
			assert(addFollowUpStub.calledOnce);
			assert(addFollowUpStub.calledWith(123, 'Test prompt', 'Test summary'));

			assert.strictEqual(result, 'Follow-up added successfully');
		});

		it('should not proceed with remote agent creation when followup is provided and valid', async () => {
			const repoInfoStub = sandbox.stub(manager, 'repoInfo').resolves({
				owner: 'testowner',
				repo: 'testrepo',
				baseRef: 'main',
				remote: {} as any,
				repository: {} as any,
				ghRepository: {} as any,
				fm: {} as any
			});

			const addFollowUpStub = sandbox.stub(manager, 'addFollowUpToExistingPR').resolves('Follow-up added');
			const invokeRemoteAgentSpy = sandbox.spy(manager, 'invokeRemoteAgent');

			const args = {
				userPrompt: 'Test prompt',
				followup: 'open-pull-request-webview{"owner":"testowner","repo":"testrepo","pullRequestNumber":123}'
			};

			await manager.commandImpl(args);

			// invokeRemoteAgent should NOT be called when following up
			assert(invokeRemoteAgentSpy.notCalled);
		});
	});
});