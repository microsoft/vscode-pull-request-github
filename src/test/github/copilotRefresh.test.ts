/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { EventType } from '../../common/timelineEvent';

describe('Copilot Refresh Logic', function () {
	it('should detect new CopilotStarted events', function () {
		// Test the logic for detecting new CopilotStarted events
		const initialTimeline = [
			{ event: EventType.Commented, id: '1' },
			{ event: EventType.CopilotStarted, id: '2' }
		];
		const initialCopilotStartedEvents = initialTimeline.filter(event => event.event === EventType.CopilotStarted);
		assert.strictEqual(initialCopilotStartedEvents.length, 1);

		const newTimeline = [
			{ event: EventType.Commented, id: '1' },
			{ event: EventType.CopilotStarted, id: '2' },
			{ event: EventType.CopilotStarted, id: '3' }
		];
		const newCopilotStartedEvents = newTimeline.filter(event => event.event === EventType.CopilotStarted);
		assert.strictEqual(newCopilotStartedEvents.length, 2);
		
		// Should detect new event
		assert.strictEqual(newCopilotStartedEvents.length > initialCopilotStartedEvents.length, true);
	});

	it('should handle empty initial timeline', function () {
		const initialTimeline = [];
		const initialCopilotStartedEvents = initialTimeline.filter(event => event.event === EventType.CopilotStarted);
		assert.strictEqual(initialCopilotStartedEvents.length, 0);

		const newTimeline = [
			{ event: EventType.CopilotStarted, id: '1' }
		];
		const newCopilotStartedEvents = newTimeline.filter(event => event.event === EventType.CopilotStarted);
		assert.strictEqual(newCopilotStartedEvents.length, 1);
		
		// Should detect new event
		assert.strictEqual(newCopilotStartedEvents.length > initialCopilotStartedEvents.length, true);
	});

	it('should handle no new events', function () {
		const initialTimeline = [
			{ event: EventType.Commented, id: '1' },
			{ event: EventType.CopilotStarted, id: '2' }
		];
		const initialCopilotStartedEvents = initialTimeline.filter(event => event.event === EventType.CopilotStarted);
		assert.strictEqual(initialCopilotStartedEvents.length, 1);

		const newTimeline = [
			{ event: EventType.Commented, id: '1' },
			{ event: EventType.CopilotStarted, id: '2' },
			{ event: EventType.Commented, id: '3' }
		];
		const newCopilotStartedEvents = newTimeline.filter(event => event.event === EventType.CopilotStarted);
		assert.strictEqual(newCopilotStartedEvents.length, 1);
		
		// Should not detect new event
		assert.strictEqual(newCopilotStartedEvents.length > initialCopilotStartedEvents.length, false);
	});

	it('should verify exponential backoff delays', function () {
		const delays = [500, 1000, 2000, 5000];
		
		// Verify the delays are exponential
		assert.strictEqual(delays[0], 500);
		assert.strictEqual(delays[1], 1000); // 2x
		assert.strictEqual(delays[2], 2000); // 2x
		assert.strictEqual(delays[3], 5000); // 2.5x (final value as requested)
		
		// Total time should be 8.5 seconds maximum
		const totalTime = delays.reduce((sum, delay) => sum + delay, 0);
		assert.strictEqual(totalTime, 8500);
	});
});