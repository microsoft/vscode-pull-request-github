/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface SessionResponseLogChunk {
	choices: Array<{
		finish_reason?: 'tool_calls' | 'null' | (string & {});
		delta: {
			content?: string;
			role: 'assistant' | (string & {});
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
	// args: any;
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
	toolSpecificData?: StrReplaceEditorToolData | BashToolData;
}

export interface StrReplaceEditorToolData {
	command: 'view' | 'edit' | string;
	filePath?: string;
	fileLabel?: string;
	parsedContent?: { content: string; fileA: string | undefined; fileB: string | undefined; };
}

export interface BashToolData {
	commandLine: {
		original: string;
	};
	language: 'bash';
}

/**
 * Parse diff content and extract file information
 */
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



/**
 * Convert absolute file path to relative file label
 * File paths are absolute and look like: `/home/runner/work/repo/repo/<path>`
 */
export function toFileLabel(file: string): string {
	const parts = file.split('/');
	return parts.slice(6).join('/');
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
	let args: { command?: string, path?: string, prDescription?: string, commitMessage?: string } = {};
	try {
		args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
	} catch {
		// fallback to empty args
	}

	const name = toolCall.function.name;

	if (name === 'str_replace_editor') {
		if (args.command === 'view') {
			const parsedContent = parseDiff(content);
			if (parsedContent) {
				const file = parsedContent.fileA ?? parsedContent.fileB;
				const fileLabel = file && toFileLabel(file);
				return {
					toolName: fileLabel === '' ? 'Read repository' : 'Read',
					invocationMessage: fileLabel ? `Read [](${fileLabel})` : 'Read repository',
					pastTenseMessage: fileLabel ? `Read [](${fileLabel})` : 'Read repository',
					toolSpecificData: fileLabel ? {
						command: 'view',
						filePath: file,
						fileLabel: fileLabel,
						parsedContent: parsedContent
					} : undefined
				};
			} else {
				const filePath = args.path;
				let fileLabel = filePath ? toFileLabel(filePath) : undefined;

				if (fileLabel === undefined) {
					fileLabel = filePath;

					return {
						toolName: fileLabel ? `Read ${fileLabel}` : 'Read repository',
						invocationMessage: fileLabel ? `Read ${fileLabel}` : 'Read repository',
						pastTenseMessage: fileLabel ? `Read ${fileLabel}` : 'Read repository',
					};
				} else if (fileLabel === '') {
					return {
						toolName: 'Read repository',
						invocationMessage: 'Read repository',
						pastTenseMessage: 'Read repository',
					};
				} else {
					return {
						toolName: `Read`,
						invocationMessage: `Read ${fileLabel}`,
						pastTenseMessage: `Read ${fileLabel}`,
						toolSpecificData: {
							command: 'view',
							filePath: filePath,
							fileLabel: fileLabel
						}
					};
				}
			}
		} else {
			const filePath = args.path;
			const fileLabel = filePath && toFileLabel(filePath);
			return {
				toolName: 'Edit',
				invocationMessage: fileLabel ? `Edit [](${fileLabel})` : 'Edit',
				pastTenseMessage: fileLabel ? `Edit [](${fileLabel})` : 'Edit',
				toolSpecificData: fileLabel ? {
					command: args.command || 'edit',
					filePath: filePath,
					fileLabel: fileLabel
				} : undefined
			};
		}
	} else if (name === 'think') {
		return {
			toolName: 'Thought',
			invocationMessage: content || 'Thought',
		};
	} else if (name === 'report_progress') {
		const details: ParsedToolCallDetails = {
			toolName: 'Progress Update',
			invocationMessage: `${args.prDescription}` || content || 'Progress Update'
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
			invocationMessage: bashContent || 'Run Bash command',
		};

		// Use the terminal-specific data for bash commands
		if (args.command) {
			const bashToolData: BashToolData = {
				commandLine: {
					original: args.command,
				},
				language: 'bash'
			};
			details.toolSpecificData = bashToolData;
		}
		return details;
	} else {
		// Unknown tool type
		return {
			toolName: name || 'unknown',
			invocationMessage: content || name || 'unknown'
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
