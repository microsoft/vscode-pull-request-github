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

export interface ParsedToolCall {
	type: 'str_replace_editor' | 'think' | 'bash' | 'report_progress' | 'unknown';
	name: string;
	args: any;
	content: string;
	command?: string; // For str_replace_editor
}

export interface ParsedChoice {
	type: 'assistant_content' | 'tool_call' | 'pr_title';
	content?: string;
	toolCall?: ParsedToolCall;
	finishReason?: string;
}

export interface ParsedToolCallDetails {
	toolName: string;
	invocationMessage: string;
	pastTenseMessage?: string;
	originMessage?: string;
	toolSpecificData?: any;
}

/**
 * Parse tool call arguments and return normalized tool details
 */
export function parseToolCallDetails(
	toolCall: {
		function: { name: string; arguments: string };
		id: string;
		type: string;
		index: number;
	},
	content: string
): ParsedToolCallDetails {
	let args: any = {};
	try {
		args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
	} catch {
		// fallback to empty args
	}

	const name = toolCall.function.name;

	if (name === 'str_replace_editor') {
		if (args.command === 'view') {
			return {
				toolName: args.path ? `View ${args.path}` : 'View repository',
				invocationMessage: `View ${args.path}`,
				pastTenseMessage: `View ${args.path}`
			};
		} else {
			return {
				toolName: 'Edit',
				invocationMessage: `Edit: ${args.path}`,
				pastTenseMessage: `Edit: ${args.path}`
			};
		}
	} else if (name === 'think') {
		return {
			toolName: 'Thought',
			invocationMessage: content
		};
	} else if (name === 'report_progress') {
		const details: ParsedToolCallDetails = {
			toolName: 'Progress Update',
			invocationMessage: args.prDescription || content
		};
		if (args.commitMessage) {
			details.originMessage = `Commit: ${args.commitMessage}`;
		}
		return details;
	} else if (name === 'bash') {
		const command = args.command ? `$ ${args.command}` : undefined;
		const bashContent = [command, content].filter(Boolean).join('\n');
		const details: ParsedToolCallDetails = {
			toolName: 'Run Bash command',
			invocationMessage: bashContent
		};

		// Use the terminal-specific data for bash commands
		if (args.command) {
			details.toolSpecificData = {
				command: args.command,
				language: 'bash'
			};
		}
		return details;
	} else {
		// Unknown tool type
		return {
			toolName: name || 'unknown',
			invocationMessage: content
		};
	}
}

/**
 * Parse raw session logs text into structured log chunks
 */
export function parseSessionLogs(rawText: string): SessionResponseLogChunk[] {
	const parts = rawText
		.split(/\r?\n/)
		.filter(part => part.startsWith('data: '))
		.map(part => part.slice('data: '.length).trim())
		.map(part => JSON.parse(part));

	return parts as SessionResponseLogChunk[];
}
