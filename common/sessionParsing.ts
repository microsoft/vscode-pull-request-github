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
	viewRange?: { start: number, end: number }
}

export namespace StrReplaceEditorToolData {
	export function is(value: any): value is StrReplaceEditorToolData {
		return value && (typeof value.command === 'string');
	}
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

export function parseRange(view_range: unknown): { start: number, end: number } | undefined {
	if (!view_range) {
		return undefined;
	}

	if (!Array.isArray(view_range)) {
		return undefined;
	}

	if (view_range.length !== 2) {
		return undefined;
	}

	const start = view_range[0];
	const end = view_range[1];

	if (typeof start !== 'number' || typeof end !== 'number') {
		return undefined;
	}

	return {
		start,
		end
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
	// Parse arguments once with graceful fallback
	let args: { command?: string, path?: string, prDescription?: string, commitMessage?: string, view_range?: unknown } = {};
	try { args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {}; } catch { /* ignore */ }

	const name = toolCall.function.name;

	// Small focused helpers to remove duplication while preserving behavior
	const buildReadDetails = (filePath: string | undefined, parsedRange: { start: number, end: number } | undefined, opts?: { parsedContent?: { content: string; fileA: string | undefined; fileB: string | undefined; } }): ParsedToolCallDetails => {
		const fileLabel = filePath && toFileLabel(filePath);
		if (fileLabel === undefined || fileLabel === '') {
			return { toolName: 'Read repository', invocationMessage: 'Read repository', pastTenseMessage: 'Read repository' };
		}
		const rangeSuffix = parsedRange ? `, lines ${parsedRange.start} to ${parsedRange.end}` : '';
		// Default helper returns bracket variant (used for generic view). Plain variant handled separately for str_replace_editor non-diff.
		return {
			toolName: 'Read',
			invocationMessage: `Read [](${fileLabel})${rangeSuffix}`,
			pastTenseMessage: `Read [](${fileLabel})${rangeSuffix}`,
			toolSpecificData: {
				command: 'view',
				filePath: filePath,
				fileLabel: fileLabel,
				parsedContent: opts?.parsedContent,
				viewRange: parsedRange
			}
		};
	};

	const buildEditDetails = (filePath: string | undefined, command: string, parsedRange: { start: number, end: number } | undefined, opts?: { defaultName?: string }): ParsedToolCallDetails => {
		const fileLabel = filePath && toFileLabel(filePath);
		const rangeSuffix = parsedRange ? `, lines ${parsedRange.start} to ${parsedRange.end}` : '';
		let invocationMessage: string;
		let pastTenseMessage: string;
		if (fileLabel) {
			invocationMessage = `Edit [](${fileLabel})${rangeSuffix}`;
			pastTenseMessage = `Edit [](${fileLabel})${rangeSuffix}`;
		} else {
			if (opts?.defaultName === 'Create') {
				invocationMessage = pastTenseMessage = `Create File ${filePath}`;
			} else {
				invocationMessage = pastTenseMessage = (opts?.defaultName || 'Edit');
			}
			invocationMessage += rangeSuffix;
			pastTenseMessage += rangeSuffix;
		}

		return {
			toolName: opts?.defaultName || 'Edit',
			invocationMessage,
			pastTenseMessage,
			toolSpecificData: fileLabel ? {
				command: command || (opts?.defaultName === 'Create' ? 'create' : (command || 'edit')),
				filePath: filePath,
				fileLabel: fileLabel,
				viewRange: parsedRange
			} : undefined
		};
	};

	const buildStrReplaceDetails = (filePath: string | undefined): ParsedToolCallDetails => {
		const fileLabel = filePath && toFileLabel(filePath);
		const message = fileLabel ? `Edit [](${fileLabel})` : `Edit ${filePath}`;
		return {
			toolName: 'Edit',
			invocationMessage: message,
			pastTenseMessage: message,
			toolSpecificData: fileLabel ? { command: 'str_replace', filePath, fileLabel } : undefined
		};
	};

	const buildCreateDetails = (filePath: string | undefined): ParsedToolCallDetails => {
		const fileLabel = filePath && toFileLabel(filePath);
		const message = fileLabel ? `Create [](${fileLabel})` : `Create File ${filePath}`;
		return {
			toolName: 'Create',
			invocationMessage: message,
			pastTenseMessage: message,
			toolSpecificData: fileLabel ? { command: 'create', filePath, fileLabel } : undefined
		};
	};

	const buildBashDetails = (bashArgs: typeof args, contentStr: string): ParsedToolCallDetails => {
		const command = bashArgs.command ? `$ ${bashArgs.command}` : undefined;
		const bashContent = [command, contentStr].filter(Boolean).join('\n');
		const details: ParsedToolCallDetails = { toolName: 'Run Bash command', invocationMessage: bashContent || 'Run Bash command' };
		if (bashArgs.command) { details.toolSpecificData = { commandLine: { original: bashArgs.command }, language: 'bash' }; }
		return details;
	};

	switch (name) {
		case 'str_replace_editor': {
			if (args.command === 'view') {
				const parsedContent = parseDiff(content);
				const parsedRange = parseRange(args.view_range);
				if (parsedContent) {
					const file = parsedContent.fileA ?? parsedContent.fileB;
					const fileLabel = file && toFileLabel(file);
					if (fileLabel === '') {
						return { toolName: 'Read repository', invocationMessage: 'Read repository', pastTenseMessage: 'Read repository' };
					} else if (fileLabel === undefined) {
						return { toolName: 'Read', invocationMessage: 'Read repository', pastTenseMessage: 'Read repository' };
					} else {
						const rangeSuffix = parsedRange ? `, lines ${parsedRange.start} to ${parsedRange.end}` : '';
						return {
							toolName: 'Read',
							invocationMessage: `Read [](${fileLabel})${rangeSuffix}`,
							pastTenseMessage: `Read [](${fileLabel})${rangeSuffix}`,
							toolSpecificData: { command: 'view', filePath: file, fileLabel, parsedContent, viewRange: parsedRange }
						};
					}
				}
				// No diff parsed: use PLAIN (non-bracket) variant for str_replace_editor views
				const plainRange = parseRange(args.view_range);
				const fp = args.path; const fl = fp && toFileLabel(fp);
				if (fl === undefined || fl === '') {
					return { toolName: 'Read repository', invocationMessage: 'Read repository', pastTenseMessage: 'Read repository' };
				}
				const suffix = plainRange ? `, lines ${plainRange.start} to ${plainRange.end}` : '';
				return {
					toolName: 'Read',
					invocationMessage: `Read ${fl}${suffix}`,
					pastTenseMessage: `Read ${fl}${suffix}`,
					toolSpecificData: { command: 'view', filePath: fp, fileLabel: fl, viewRange: plainRange }
				};
			}
			return buildEditDetails(args.path, args.command || 'edit', parseRange(args.view_range));
		}
		case 'str_replace':
			return buildStrReplaceDetails(args.path);
		case 'create':
			return buildCreateDetails(args.path);
		case 'view':
			return buildReadDetails(args.path, parseRange(args.view_range)); // generic view always bracket variant
		case 'think': {
			const thought = (args as unknown as { thought?: string }).thought || content || 'Thought';
			return { toolName: 'think', invocationMessage: thought };
		}
		case 'report_progress': {
			const details: ParsedToolCallDetails = { toolName: 'Progress Update', invocationMessage: `${args.prDescription}` || content || 'Progress Update' };
			if (args.commitMessage) { details.originMessage = `Commit: ${args.commitMessage}`; }
			return details;
		}
		case 'bash':
			return buildBashDetails(args, content);
		case 'read_bash':
			return { toolName: 'read_bash', invocationMessage: 'Read logs from Bash session' };
		case 'stop_bash':
			return { toolName: 'stop_bash', invocationMessage: 'Stop Bash session' };
		default:
			return { toolName: name || 'unknown', invocationMessage: content || name || 'unknown' };
	}
}

/**
 * Parse raw session logs text into structured log chunks
 */
export function parseSessionLogs(rawText: string): SessionResponseLogChunk[] {
	const parts = rawText
		.split(/\r?\n/)
		.filter(part => part.startsWith('data: '))
		.map(part => {
			const trimmed = part.slice('data: '.length).trim();
			return JSON.parse(trimmed);
		});

	return parts as SessionResponseLogChunk[];
}
