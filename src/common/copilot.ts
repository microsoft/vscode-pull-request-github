/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventType, TimelineEvent } from './timelineEvent';

export const COPILOT_LOGINS = [
	'copilot-pull-request-reviewer',
	'copilot-swe-agent',
	'Copilot'
];

export enum CopilotPRStatus {
	None = 0,
	Started = 1,
	Completed = 2,
	Failed = 3,
}

export function copilotEventToStatus(event: TimelineEvent | undefined): CopilotPRStatus {
	if (!event) {
		return CopilotPRStatus.None;
	}

	switch (event.event) {
		case EventType.CopilotStarted:
			return CopilotPRStatus.Started;
		case EventType.CopilotFinished:
			return CopilotPRStatus.Completed;
		case EventType.CopilotFinishedError:
			return CopilotPRStatus.Failed;
		default:
			return CopilotPRStatus.None;
	}
}

export function mostRecentCopilotEvent(events: TimelineEvent[]): TimelineEvent | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const status = copilotEventToStatus(events[i]);
		if (status !== CopilotPRStatus.None) {
			return events[i];
		}
	}
	return undefined;
}