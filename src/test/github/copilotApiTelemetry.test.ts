/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { CopilotApi } from '../../github/copilotApi';
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

suite('CopilotApi Telemetry', () => {
	let testTelemetry: TestTelemetry;

	setup(() => {
		testTelemetry = new TestTelemetry();
	});

	test('should send telemetry on successful API call', async () => {
		// Mock successful fetch response
		const mockFetch = (url: string, options: any) => {
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve({
					pull_request: {
						html_url: 'https://github.com/owner/repo/pull/123',
						number: 123
					}
				})
			} as Response);
		};

		// Replace global fetch temporarily
		const originalFetch = global.fetch;
		global.fetch = mockFetch as any;

		try {
			const mockOctokit = {} as any;
			const copilotApi = new CopilotApi(mockOctokit, 'test-token', testTelemetry);

			await copilotApi.postRemoteAgentJob('owner', 'repo', {
				problem_statement: 'test problem'
			});

			// Verify telemetry was sent
			assert.strictEqual(testTelemetry.events.length, 1);
			const event = testTelemetry.events[0];
			assert.strictEqual(event.eventName, 'copilot.remoteAgent.apiCall');
			assert.strictEqual(event.properties?.status, '200');
			assert.strictEqual(event.properties?.repoSlug, 'owner/repo');
			assert.strictEqual(event.properties?.outcome, 'success');
		} finally {
			global.fetch = originalFetch;
		}
	});

	test('should send error telemetry on API failure', async () => {
		// Mock failed fetch response
		const mockFetch = (url: string, options: any) => {
			return Promise.resolve({
				ok: false,
				status: 403,
				text: () => Promise.resolve('Forbidden')
			} as Response);
		};

		// Replace global fetch temporarily
		const originalFetch = global.fetch;
		global.fetch = mockFetch as any;

		try {
			const mockOctokit = {} as any;
			const copilotApi = new CopilotApi(mockOctokit, 'test-token', testTelemetry);

			try {
				await copilotApi.postRemoteAgentJob('owner', 'repo', {
					problem_statement: 'test problem'
				});
				assert.fail('Expected an error to be thrown');
			} catch (error) {
				// Expected error
			}

			// Verify error telemetry was sent
			assert.strictEqual(testTelemetry.events.length, 1);
			const event = testTelemetry.events[0];
			assert.strictEqual(event.eventName, 'copilot.remoteAgent.apiCall');
			assert.strictEqual(event.properties?.status, '403');
			assert.strictEqual(event.properties?.repoSlug, 'owner/repo');
			assert.strictEqual(event.properties?.outcome, 'error');
		} finally {
			global.fetch = originalFetch;
		}
	});
});