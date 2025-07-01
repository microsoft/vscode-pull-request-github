/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as vscode from 'vscode';
import { CopilotRemoteAgentTool } from '../../lm/tools/copilotRemoteAgentTool';
import { ITelemetry } from '../../common/telemetry';

class TestTelemetry implements ITelemetry {
	public events: Array<{ eventName: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];
	public errorEvents: Array<{ eventName: string; properties?: Record<string, string>; measurements?: Record<string, number> }> = [];

	sendTelemetryEvent(eventName: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
		this.events.push({ eventName, properties, measurements });
	}

	sendTelemetryErrorEvent(eventName: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
		this.errorEvents.push({ eventName, properties, measurements });
	}

	dispose(): Promise<any> {
		return Promise.resolve();
	}
}

class MockCopilotRemoteAgentManager {
	async isAvailable(): Promise<boolean> {
		return true;
	}

	async repoInfo() {
		return {
			owner: 'test-owner',
			repo: 'test-repo'
		};
	}

	autoCommitAndPushEnabled(): boolean {
		return true;
	}

	async invokeRemoteAgent(title: string, body: string) {
		return {
			state: 'success' as const,
			number: 123,
			link: 'https://github.com/test-owner/test-repo/pull/123',
			webviewUri: vscode.Uri.parse('vscode://test'),
			llmDetails: 'Remote agent started successfully'
		};
	}

	async addFollowUpToExistingPR(pullRequestNumber: number, title: string, body: string) {
		return 'Follow-up added successfully';
	}
}

suite('CopilotRemoteAgentTool Telemetry', () => {
	let testTelemetry: TestTelemetry;
	let mockManager: MockCopilotRemoteAgentManager;
	let tool: CopilotRemoteAgentTool;

	setup(() => {
		testTelemetry = new TestTelemetry();
		mockManager = new MockCopilotRemoteAgentManager();
		tool = new CopilotRemoteAgentTool(mockManager as any, testTelemetry);
	});

	test('should send telemetry on successful tool preparation', async () => {
		const options = {
			input: {
				title: 'Test task',
				body: 'Test description'
			}
		} as vscode.LanguageModelToolInvocationPrepareOptions<any>;

		await tool.prepareInvocation(options);

		// Verify telemetry was sent
		assert.strictEqual(testTelemetry.events.length, 1);
		const event = testTelemetry.events[0];
		assert.strictEqual(event.eventName, 'copilot.remoteAgent.tool.prepare');
		assert.strictEqual(event.properties?.hasExistingPR, 'false');
		assert.strictEqual(event.properties?.autoPushEnabled, 'true');
		assert.strictEqual(event.properties?.outcome, 'success');
	});

	test('should send error telemetry when agent not available', async () => {
		// Mock unavailable agent
		mockManager.isAvailable = async () => false;

		const options = {
			input: {
				title: 'Test task',
				existingPullRequest: '123'
			}
		} as vscode.LanguageModelToolInvocationPrepareOptions<any>;

		try {
			await tool.prepareInvocation(options);
			assert.fail('Expected an error to be thrown');
		} catch (error) {
			// Expected error
		}

		// Verify error telemetry was sent
		assert.strictEqual(testTelemetry.errorEvents.length, 1);
		const errorEvent = testTelemetry.errorEvents[0];
		assert.strictEqual(errorEvent.eventName, 'copilot.remoteAgent.tool.prepare');
		assert.strictEqual(errorEvent.properties?.hasExistingPR, 'true');
		assert.strictEqual(errorEvent.properties?.outcome, 'error');
		assert.strictEqual(errorEvent.properties?.errorType, 'agentNotAvailable');
	});

	test('should send telemetry on successful tool invocation', async () => {
		const options = {
			input: {
				title: 'Test task',
				body: 'Test description'
			}
		} as vscode.LanguageModelToolInvocationOptions<any>;

		const result = await tool.invoke(options, {} as vscode.CancellationToken);

		// Verify result is successful
		assert.ok(result);
		assert.ok(result instanceof vscode.LanguageModelToolResult);

		// Verify telemetry was sent
		assert.strictEqual(testTelemetry.events.length, 1);
		const event = testTelemetry.events[0];
		assert.strictEqual(event.eventName, 'copilot.remoteAgent.tool.invoke');
		assert.strictEqual(event.properties?.hasExistingPR, 'false');
		assert.strictEqual(event.properties?.hasBody, 'true');
		assert.strictEqual(event.properties?.outcome, 'success');
	});

	test('should send telemetry on tool invocation with existing PR', async () => {
		const options = {
			input: {
				title: 'Test task',
				body: 'Test description',
				existingPullRequest: '456'
			}
		} as vscode.LanguageModelToolInvocationOptions<any>;

		await tool.invoke(options, {} as vscode.CancellationToken);

		// Verify telemetry was sent with correct PR context
		assert.strictEqual(testTelemetry.events.length, 1);
		const event = testTelemetry.events[0];
		assert.strictEqual(event.eventName, 'copilot.remoteAgent.tool.invoke');
		assert.strictEqual(event.properties?.hasExistingPR, 'true');
		assert.strictEqual(event.properties?.hasBody, 'true');
		assert.strictEqual(event.properties?.outcome, 'success');
	});
});