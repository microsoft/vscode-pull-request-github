/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EventType, TimelineEvent } from './timelineEvent';
import { AccountType, IAccount } from '../github/interface';

export const COPILOT_SWE_AGENT = 'copilot-swe-agent';
export const COPILOT_CLOUD_AGENT = 'copilot-cloud-agent';
export const COPILOT_REVIEWER = 'copilot-pull-request-reviewer';
export const COPILOT_REVIEWER_ID = 'BOT_kgDOCnlnWA';

export const COPILOT_LOGINS = [
	COPILOT_REVIEWER,
	COPILOT_SWE_AGENT,
	'Copilot'
];

export const COPILOT_REVIEWER_ACCOUNT: IAccount = {
	login: COPILOT_REVIEWER,
	id: COPILOT_REVIEWER_ID,
	url: '',
	avatarUrl: '',
	name: 'Copilot',
	accountType: AccountType.Bot
};

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