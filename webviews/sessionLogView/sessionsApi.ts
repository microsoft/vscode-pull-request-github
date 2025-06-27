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

export function parseSessionLogs(rawText: string): SessionResponseLogChunk[] {
	const parts = rawText
		.split(/\r?\n/)
		.filter(part => part.startsWith('data: '))
		.map(part => part.slice('data: '.length).trim())
		.map(part => JSON.parse(part));

	return parts as SessionResponseLogChunk[];
}

export function parseDiff(content: string): { content: string; fileA: string | undefined; fileB: string | undefined; } | undefined {
	const lines = content.split(/\r?\n/g);
	let fileA: string | undefined;
	let fileB: string | undefined;

	let startDiffLineIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith('diff --git')) {
			const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
			if (match) {
				fileA = match[1];
				fileB = match[2];
			}
		} else if (line.startsWith('@@ ')) {
			startDiffLineIndex = i + 1;
			break;
		}
	}
	if (startDiffLineIndex < 0) {
		return undefined;
	}

	return {
		content: lines.slice(startDiffLineIndex).join('\n'),
		fileA: typeof fileA === 'string' ? '/' + fileA : undefined,
		fileB: typeof fileB === 'string' ? '/' + fileB : undefined
	};
}

