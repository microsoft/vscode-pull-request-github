/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface SessionResponseLogChunk {
	choices: Array<{
		finish_reason: string;
		delta: {
			content?: string;
			role: string;
			tool_calls?: Array<{
				function: {
					arguments: string;
					name: string;
				};
				id: string;
				type: string;
				index: number;
			}>;
		};
	}>;
	created: number;
	id: string;
	usage: {
		completion_tokens: number;
		prompt_tokens: number;
		prompt_tokens_details: {
			cached_tokens: number;
		};
		total_tokens: number;
	};
	model: string;
	object: string;
}

interface SessionsResponse {
	sessions: readonly SessionInfo[];
}

export interface SessionInfo {
	id: string;
	name: string;
	user_id: number;
	agent_id: number;
	logs: string;
	logs_blob_id: string;
	state: string;
	owner_id: number;
	repo_id: number;
	resource_type: string;
	resource_id: number;
	last_updated_at: string;
	created_at: string;
	completed_at: string;
	event_type: string;
	workflow_run_id: number;
	premium_requests: number;
	error: string | null;
}


export async function fetchSessions(authToken: string): Promise<SessionsResponse> {
	const response = await fetch('https://api.githubcopilot.com/agents/sessions', {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${authToken}`,
			'Accept': 'application/json'
		}
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch sessions: ${response.status} ${response.statusText}`);
	}

	return (await response.json()) as SessionsResponse;
}

export async function fetchSessionInfo(authToken: string, sessionId: string): Promise<SessionInfo> {
	const response = await fetch(`https://api.githubcopilot.com/agents/sessions/${sessionId}`, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${authToken}`,
			'Accept': 'application/json'
		}
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch session: ${response.status} ${response.statusText}`);
	}

	return (await response.json()) as SessionInfo;
}

export async function fetchSessionLogs(authToken: string, sessionId: string): Promise<string> {
	const request = await fetch(`https://api.githubcopilot.com/agents/sessions/${sessionId}/logs`, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${authToken}`,
			'Accept': 'application/json'
		}
	});

	if (!request.ok) {
		throw new Error(`Failed to fetch session: ${request.status} ${request.statusText}`);
	}

	return request.text();
}

export function parseSessionLogs(rawText: string): SessionResponseLogChunk[] {
	const parts = rawText
		.split(/\r?\n/)
		.filter(part => part.startsWith('data: '))
		.map(part => part.slice('data: '.length).trim())
		.map(part => JSON.parse(part));

	return parts as SessionResponseLogChunk[];
}

