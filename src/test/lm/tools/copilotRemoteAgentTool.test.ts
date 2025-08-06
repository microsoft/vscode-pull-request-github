/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { SinonSandbox, createSandbox } from 'sinon';
import { CopilotRemoteAgentTool } from '../../../lm/tools/copilotRemoteAgentTool';
import { CopilotRemoteAgentManager } from '../../../github/copilotRemoteAgent';
import { MockTelemetry } from '../../mocks/mockTelemetry';

describe('CopilotRemoteAgentTool', function () {
	let sandbox: SinonSandbox;
	let tool: CopilotRemoteAgentTool;
	let mockManager: Partial<CopilotRemoteAgentManager>;
	let mockTelemetry: MockTelemetry;

	beforeEach(function () {
		sandbox = createSandbox();
		mockTelemetry = new MockTelemetry();

		// Create basic mock CopilotRemoteAgentManager
		mockManager = {
			isAvailable: sandbox.stub().resolves(true),
			repoInfo: sandbox.stub().resolves({
				repo: 'test-repo',
				owner: 'test-owner'
			}),
			autoCommitAndPushEnabled: false,
			addFollowUpToExistingPR: sandbox.stub().resolves('Follow-up added'),
			invokeRemoteAgent: sandbox.stub().resolves({
				state: 'success',
				link: 'https://github.com/test-owner/test-repo/pull/123',
				number: 123,
				llmDetails: 'Coding agent completed successfully'
			}),
			getStateForPR: sandbox.stub().returns(undefined)
		};

		tool = new CopilotRemoteAgentTool(mockManager as CopilotRemoteAgentManager, mockTelemetry);
	});

	afterEach(function () {
		sandbox.restore();
	});

	describe('toolId', function () {
		it('should have correct tool ID', function () {
			assert.strictEqual(CopilotRemoteAgentTool.toolId, 'github-pull-request_copilot-coding-agent');
		});
	});

	describe('prepareInvocation', function () {
		it('should throw error when agent is not available', async function () {
			(mockManager.isAvailable as any).resolves(false);

			const options = {
				input: {
					title: 'Test task'
				}
			};

			try {
				await tool.prepareInvocation(options as any);
				assert.fail('Should have thrown an error');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok(error.message.includes('Copilot coding agent is not available'));
			}
		});

		it('should prepare invocation when agent is available', async function () {
			const options = {
				input: {
					title: 'Fix bug in authentication',
					body: 'This fixes the issue with user authentication'
				}
			};

			const result = await tool.prepareInvocation(options as any);

			assert.strictEqual(result.pastTenseMessage, 'Launched coding agent');
			assert.strictEqual(result.invocationMessage, 'Launching coding agent');
			assert.ok(result.confirmationMessages);
			assert.strictEqual(result.confirmationMessages.title, 'Start coding agent?');
		});
	});

	describe('invoke', function () {
		it('should handle successful invocation', async function () {
			const options = {
				input: {
					title: 'Implement new feature',
					body: 'Detailed description of the feature'
				}
			};

			const result = await tool.invoke(options as any, {} as any);

			assert.ok(result);
			assert.ok(result.content);
			assert.ok(result.content.length > 0);
		});

		it('should handle missing repository information', async function () {
			(mockManager.repoInfo as any).resolves(undefined);

			const options = {
				input: {
					title: 'Test task'
				}
			};

			const result = await tool.invoke(options as any, {} as any);

			assert.ok(result);
			assert.ok(result.content);
			assert.ok(result.content.length > 0);
		});

		it('should handle error from remote agent invocation', async function () {
			(mockManager.invokeRemoteAgent as any).resolves({
				state: 'error',
				error: 'Repository not found'
			});

			const options = {
				input: {
					title: 'Test task'
				}
			};

			try {
				await tool.invoke(options as any, {} as any);
				assert.fail('Should have thrown an error');
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.strictEqual(error.message, 'Repository not found');
			}
		});
	});

	describe('basic functionality', function () {
		it('should be constructible with manager and telemetry', function () {
			assert.ok(tool);
			assert.ok(tool instanceof CopilotRemoteAgentTool);
		});

		it('should have required methods', function () {
			assert.ok(typeof tool.prepareInvocation === 'function');
			assert.ok(typeof tool.invoke === 'function');
		});
	});

	describe('error scenarios', function () {
		it('should handle telemetry errors gracefully', async function () {
			// Mock telemetry to throw
			mockTelemetry.sendTelemetryEvent = sandbox.stub().throws(new Error('Telemetry error'));

			const options = {
				input: {
					title: 'Test task'
				}
			};

			// Should not throw even if telemetry fails
			const result = await tool.prepareInvocation(options as any);
			assert.ok(result);
		});
	});
});