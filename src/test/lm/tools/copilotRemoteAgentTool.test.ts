/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';

import { CopilotRemoteAgentTool } from '../../../lm/tools/copilotRemoteAgentTool';
import { CopilotRemoteAgentManager } from '../../../github/copilotRemoteAgent';

describe('CopilotRemoteAgentTool', function () {
	let sinon: SinonSandbox;
	let tool: CopilotRemoteAgentTool;
	let mockManager: CopilotRemoteAgentManager;

	beforeEach(function () {
		sinon = createSandbox();
		// Create a mock manager
		mockManager = {
			isAvailable: sinon.stub(),
			repoInfo: sinon.stub(),
			autoCommitAndPushEnabled: sinon.stub()
		} as any;
		tool = new CopilotRemoteAgentTool(mockManager);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('prepareInvocation', function () {
		it('should throw error when coding agent is not available', async function () {
			mockManager.isAvailable = sinon.stub().resolves(false);
			
			const options = {
				input: { title: 'Test task' }
			} as any;

			try {
				await tool.prepareInvocation(options);
				assert.fail('Expected error to be thrown');
			} catch (error) {
				assert.ok(error.message.includes('GitHub Coding Agent is not available'));
			}
		});

		it('should return proper invocation when available', async function () {
			mockManager.isAvailable = sinon.stub().resolves(true);
			mockManager.repoInfo = sinon.stub().resolves({
				owner: 'testowner',
				repo: 'testrepo',
				remote: 'origin'
			});
			mockManager.autoCommitAndPushEnabled = sinon.stub().returns(true);
			
			const options = {
				input: { title: 'Test task' }
			} as any;

			const result = await tool.prepareInvocation(options);
			
			assert.ok(result);
			assert.ok(result.pastTenseMessage);
			assert.ok(result.invocationMessage);
			assert.ok(result.confirmationMessages);
		});
	});
});