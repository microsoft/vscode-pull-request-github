import { default as assert } from 'assert';
import { RemoteAgentJobPayload } from '../../github/copilotApi';

describe('CopilotApi Tests', function () {
	describe('RemoteAgentJobPayload', () => {
		it('should have optional head_ref property', () => {
			// Test payload without head_ref (when not pushing)
			const payloadWithoutHeadRef: RemoteAgentJobPayload = {
				problem_statement: 'Test problem',
				pull_request: {
					title: 'Test title',
					body_placeholder: 'Test body',
					base_ref: 'main'
				}
			};
			
			assert.strictEqual(payloadWithoutHeadRef.pull_request?.head_ref, undefined);
			assert.strictEqual(payloadWithoutHeadRef.pull_request?.base_ref, 'main');
		});

		it('should include head_ref when pushing async branch', () => {
			// Test payload with head_ref (when pushing to async branch)
			const payloadWithHeadRef: RemoteAgentJobPayload = {
				problem_statement: 'Test problem',
				pull_request: {
					title: 'Test title',
					body_placeholder: 'Test body',
					base_ref: 'main',
					head_ref: 'continue-from-1234567890'
				}
			};
			
			assert.strictEqual(payloadWithHeadRef.pull_request?.head_ref, 'continue-from-1234567890');
			assert.strictEqual(payloadWithHeadRef.pull_request?.base_ref, 'main');
		});

		it('should support conditional head_ref property using spread operator', () => {
			const hasChanges = true;
			const autoPushAndCommit = true;
			const baseRef = 'main';
			const ref = 'continue-from-1234567890';

			// Simulate the logic from copilotRemoteAgent.ts
			const payload: RemoteAgentJobPayload = {
				problem_statement: 'Test problem',
				pull_request: {
					title: 'Test title',
					body_placeholder: 'Test body',
					base_ref: hasChanges && autoPushAndCommit ? baseRef : ref,
					...(hasChanges && autoPushAndCommit && { head_ref: ref })
				}
			};

			assert.strictEqual(payload.pull_request?.base_ref, 'main');
			assert.strictEqual(payload.pull_request?.head_ref, 'continue-from-1234567890');
		});

		it('should not include head_ref when not pushing', () => {
			const hasChanges = false;
			const autoPushAndCommit = true;
			const baseRef = 'main';
			const ref = 'main';

			// Simulate the logic from copilotRemoteAgent.ts
			const payload: RemoteAgentJobPayload = {
				problem_statement: 'Test problem',
				pull_request: {
					title: 'Test title',
					body_placeholder: 'Test body',
					base_ref: hasChanges && autoPushAndCommit ? baseRef : ref,
					...(hasChanges && autoPushAndCommit && { head_ref: ref })
				}
			};

			assert.strictEqual(payload.pull_request?.base_ref, 'main');
			assert.strictEqual(payload.pull_request?.head_ref, undefined);
		});
	});
});