/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { SinonSandbox, createSandbox } from 'sinon';
import * as vscode from 'vscode';
import { CopilotRemoteAgentTool, CopilotRemoteAgentToolParameters } from '../../../lm/tools/copilotRemoteAgentTool';
import { CopilotRemoteAgentManager } from '../../../github/copilotRemoteAgent';
import { MockTelemetry } from '../../mocks/mockTelemetry';
import { RemoteAgentResult } from '../../../github/common';

describe('CopilotRemoteAgentTool', function () {
	let sinon: SinonSandbox;
	let tool: CopilotRemoteAgentTool;
	let mockManager: sinon.SinonStubbedInstance<CopilotRemoteAgentManager>;
	let telemetry: MockTelemetry;

	beforeEach(function () {
		sinon = createSandbox();
		telemetry = new MockTelemetry();
		mockManager = sinon.createStubInstance(CopilotRemoteAgentManager);

		// Mock the VSCode Language Model API that may not be available in test environment
		if (!(vscode as any).LanguageModelPartAudience) {
			(vscode as any).LanguageModelPartAudience = {
				Assistant: 0,
				User: 1,
				Extension: 2
			};
		}

		tool = new CopilotRemoteAgentTool(mockManager as any, telemetry);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('toolId', function () {
		it('should have the correct tool ID', function () {
			assert.strictEqual(CopilotRemoteAgentTool.toolId, 'github-pull-request_copilot-coding-agent');
		});
	});

	describe('prepareInvocation()', function () {
		const mockInput: CopilotRemoteAgentToolParameters = {
			title: 'Test PR Title',
			body: 'Test PR body',
		};

		it('should throw error when coding agent is not available', async function () {
			mockManager.isAvailable.resolves(false);

			const options = { input: mockInput } as any;

			await assert.rejects(
				async () => await tool.prepareInvocation(options),
				/Copilot coding agent is not available/
			);
		});

		it('should prepare invocation for new PR when agent is available', async function () {
			mockManager.isAvailable.resolves(true);
			mockManager.repoInfo.resolves({
				owner: 'test',
				repo: 'test-repo',
				baseRef: 'main',
				remote: {} as any,
				repository: {} as any,
				ghRepository: {} as any,
				fm: {} as any
			});
			sinon.stub(mockManager, 'autoCommitAndPushEnabled').get(() => true);

			const options = { input: mockInput } as any;

			const result = await tool.prepareInvocation(options);

			assert.strictEqual(result.pastTenseMessage, 'Launched coding agent');
			assert.strictEqual(result.invocationMessage, 'Launching coding agent');
			// Handle both string and MarkdownString types
			const message = result.confirmationMessages?.message;
			const messageText = typeof message === 'string' ? message : message?.value || '';
			assert(messageText.includes('test/test-repo'));
			assert(messageText.includes('automatically pushed'));
		});

		it('should prepare invocation for existing PR', async function () {
			mockManager.isAvailable.resolves(true);
			mockManager.repoInfo.resolves({
				owner: 'test',
				repo: 'test',
				baseRef: 'main',
				remote: {} as any,
				repository: {} as any,
				ghRepository: {} as any,
				fm: {} as any
			});

			// Mock the config getter to avoid access issues
			Object.defineProperty(mockManager, 'autoCommitAndPushEnabled', {
				get: () => false
			});

			const inputWithExistingPR: CopilotRemoteAgentToolParameters = {
				title: 'Test PR Title',
				existingPullRequest: '123',
			};

			const options = { input: inputWithExistingPR } as any;

			const result = await tool.prepareInvocation(options);

			// Handle both string and MarkdownString types
			const message = result.confirmationMessages?.message;
			const messageText = typeof message === 'string' ? message : message?.value || '';
			assert(messageText.includes('existing pull request **#123**'));
		});

		it('should handle active PR with session', async function () {
			mockManager.isAvailable.resolves(true);
			mockManager.repoInfo.resolves({
				owner: 'test',
				repo: 'test-repo',
				baseRef: 'main',
				remote: {} as any,
				repository: {} as any,
				ghRepository: {} as any,
				fm: {
					activePullRequest: { number: 456 } as any
				} as any
			});
			mockManager.getStateForPR.returns({} as any); // Non-falsy state

			// Mock the config getter to avoid access issues
			Object.defineProperty(mockManager, 'autoCommitAndPushEnabled', {
				get: () => false
			});

			const options = { input: mockInput } as any;

			const result = await tool.prepareInvocation(options);

			// Handle both string and MarkdownString types
			const message = result.confirmationMessages?.message;
			const messageText = typeof message === 'string' ? message : message?.value || '';
			assert(messageText.includes('existing pull request **#456**'));
		});
	});

	describe('invoke()', function () {
		const mockInput: CopilotRemoteAgentToolParameters = {
			title: 'Test PR Title',
			body: 'Test PR body',
		};

		const mockOptions = {
			input: mockInput
		} as any;

		const mockToken = new vscode.CancellationTokenSource().token;

		it('should return error when no repository information is found', async function () {
			mockManager.repoInfo.resolves(undefined);

			const result = await tool.invoke(mockOptions, mockToken);

			assert(result);

			// VSCode wraps the result with content array
			if ((result as any).content && Array.isArray((result as any).content)) {
				const content = (result as any).content;
				const textValue = content[0]?.value || content[0]?.text || '';
				assert(textValue.includes('No repository information found') || textValue.includes('repository information'));
			} else {
				// Check that it returns a text result with error message
				const resultParts = (result as any)._parts || (result as any).parts;
				assert(Array.isArray(resultParts));
				assert(resultParts.length > 0);
				const firstPart = resultParts[0];
				assert(firstPart.value?.includes('No repository information found') || firstPart.text?.includes('No repository information found'));
			}
		});

		it('should return error for invalid existing PR number', async function () {
			mockManager.repoInfo.resolves({
				owner: 'test',
				repo: 'test',
				baseRef: 'main',
				remote: {} as any,
				repository: {} as any,
				ghRepository: {} as any,
				fm: {} as any
			});

			const invalidInput = {
				...mockInput,
				existingPullRequest: 'invalid'
			};

			const result = await tool.invoke({ input: invalidInput } as any, mockToken);

			assert(result);

			// VSCode wraps the result with content array
			if ((result as any).content && Array.isArray((result as any).content)) {
				const content = (result as any).content;
				const textValue = content[0]?.value || content[0]?.text || '';
				assert(textValue.includes('Invalid pull request number') || textValue.includes('invalid'));
			} else {
				const resultParts = (result as any)._parts || (result as any).parts;
				assert(Array.isArray(resultParts));
				assert(resultParts.length > 0);
				const firstPart = resultParts[0];
				assert(firstPart.value?.includes('Invalid pull request number') || firstPart.text?.includes('Invalid pull request number'));
			}
		});

		it('should add follow-up to existing PR', async function () {
			mockManager.repoInfo.resolves({
				owner: 'test',
				repo: 'test-repo',
				baseRef: 'main',
				remote: {} as any,
				repository: {} as any,
				ghRepository: {} as any,
				fm: {} as any
			});
			mockManager.addFollowUpToExistingPR.resolves('Follow-up added');

			const inputWithExistingPR: CopilotRemoteAgentToolParameters = {
				title: 'Test PR Title',
				existingPullRequest: '123',
			};

			const optionsWithExistingPR = {
				input: inputWithExistingPR
			} as any;

			const result = await tool.invoke(optionsWithExistingPR, mockToken);

			assert(result);

			// VSCode wraps the result with content array
			if ((result as any).content && Array.isArray((result as any).content)) {
				const content = (result as any).content;
				const textValue = content[0]?.value || content[0]?.text || '';
				assert(textValue.includes('Follow-up added to pull request #123') || textValue.includes('follow-up') || textValue.includes('Follow-up added'));
			} else {
				const resultParts = (result as any)._parts || (result as any).parts;
				assert(Array.isArray(resultParts));
				const firstPart = resultParts[0];
				assert(firstPart.value?.includes('Follow-up added to pull request #123') || firstPart.text?.includes('Follow-up added to pull request #123'));
			}
		});

		it('should invoke remote agent for new PR successfully', async function () {
			mockManager.repoInfo.resolves({
				owner: 'test',
				repo: 'test-repo',
				baseRef: 'main',
				remote: {} as any,
				repository: {} as any,
				ghRepository: {} as any,
				fm: {
					resolvePullRequest: sinon.stub().resolves({
						number: 789,
						title: 'Test PR',
						body: 'Test body',
						author: { login: 'copilot-swe-agent' },
						githubRepository: {
							remote: {
								owner: 'test',
								repositoryName: 'test-repo'
							}
						}
					})
				} as any
			});

			const successResult: RemoteAgentResult = {
				state: 'success',
				number: 789,
				link: 'https://github.com/test/test-repo/pull/789',
				webviewUri: vscode.Uri.parse('https://example.com'),
				llmDetails: 'Agent created PR successfully',
				sessionId: '123-456'
			};

			mockManager.invokeRemoteAgent.resolves(successResult);

			const result = await tool.invoke(mockOptions, mockToken);

			assert(result);
			const resultParts = (result as any).content;
			assert(Array.isArray(resultParts));
			assert(resultParts.length >= 1);
			const firstPart = resultParts[0];
			assert(firstPart.value?.includes('Agent created PR successfully') || firstPart.text?.includes('Agent created PR successfully'));
		});

		it('should throw error when invocation fails', async function () {
			mockManager.repoInfo.resolves({
				owner: 'test',
				repo: 'test-repo',
				baseRef: 'main',
				remote: {} as any,
				repository: {} as any,
				ghRepository: {} as any,
				fm: {} as any
			});

			const errorResult: RemoteAgentResult = {
				state: 'error',
				error: 'Something went wrong'
			};

			mockManager.invokeRemoteAgent.resolves(errorResult);

			await assert.rejects(
				async () => await tool.invoke(mockOptions, mockToken),
				/Something went wrong/
			);
		});
	});

	describe('getActivePullRequestWithSession()', function () {
		it('should return undefined when no repo info is provided', async function () {
			const result = await (tool as any).getActivePullRequestWithSession(undefined);
			assert.strictEqual(result, undefined);
		});

		it('should return undefined when no active PR exists', async function () {
			const repoInfo = {
				owner: 'test',
				repo: 'test-repo',
				fm: {
					activePullRequest: undefined
				}
			};

			const result = await (tool as any).getActivePullRequestWithSession(repoInfo);
			assert.strictEqual(result, undefined);
		});

		it('should return undefined when active PR has no copilot state', async function () {
			const repoInfo = {
				owner: 'test',
				repo: 'test-repo',
				fm: {
					activePullRequest: { number: 123 }
				}
			};

			mockManager.getStateForPR.returns(undefined as any);

			const result = await (tool as any).getActivePullRequestWithSession(repoInfo);
			assert.strictEqual(result, undefined);
		});

		it('should return PR number when active PR has copilot state', async function () {
			const repoInfo = {
				owner: 'test',
				repo: 'test-repo',
				fm: {
					activePullRequest: { number: 123 }
				}
			};

			mockManager.getStateForPR.returns({} as any); // Non-falsy state

			const result = await (tool as any).getActivePullRequestWithSession(repoInfo);
			assert.strictEqual(result, 123);
		});
	});
});
