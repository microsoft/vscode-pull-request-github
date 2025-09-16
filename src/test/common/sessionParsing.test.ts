/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import {
	parseSessionLogs,
	parseToolCallDetails,
	parseDiff,
	toFileLabel,
	SessionResponseLogChunk
} from '../../../common/sessionParsing';
import { diffHeaders, diffNoAts, simpleDiff } from './fixtures/gitdiff/sessionParsing';

// Helper to construct a toolCall object
function makeToolCall(name: string, args: any): any {
	return {
		function: { name, arguments: JSON.stringify(args) },
		id: 'id_' + name + '_' + Math.random().toString(36).slice(2),
		type: 'function',
		index: 0
	};
}

describe('sessionParsing', function () {
	describe('parseSessionLogs()', function () {
		it('should parse valid session logs', function () {
			const rawText = `data: {"choices":[{"finish_reason":"tool_calls","delta":{"content":"","role":"assistant","tool_calls":[{"function":{"arguments":"{\\"command\\": \\"view\\", \\"path\\": \\"/home/runner/work/repo/repo/src/file.ts\\"}","name":"str_replace_editor"},"id":"call_123","type":"function","index":0}]}}],"created":1640995200,"id":"chatcmpl-123","usage":{"completion_tokens":10,"prompt_tokens":50,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":60},"model":"gpt-4","object":"chat.completion.chunk"}`;

			const result = parseSessionLogs(rawText);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].choices.length, 1);
			assert.strictEqual(result[0].choices[0].finish_reason, 'tool_calls');
			assert.strictEqual(result[0].choices[0].delta.role, 'assistant');
			assert.strictEqual(result[0].choices[0].delta.tool_calls?.length, 1);
			assert.strictEqual(result[0].choices[0].delta.tool_calls?.[0].function.name, 'str_replace_editor');
		});

		it('should handle malformed JSON gracefully', function () {
			const rawText = `data: {"invalid": "json"
data: {"choices":[{"finish_reason":"stop","delta":{"content":"Hello","role":"assistant"}}],"created":1640995200,"id":"chatcmpl-123","usage":{"completion_tokens":1,"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":11},"model":"gpt-4","object":"chat.completion.chunk"}`;

			assert.throws(() => {
				parseSessionLogs(rawText);
			});
		});

		it('should parse tool calls correctly', function () {
			const rawText = `data: {"choices":[{"finish_reason":"tool_calls","delta":{"content":"","role":"assistant","tool_calls":[{"function":{"arguments":"{\\"command\\": \\"bash\\", \\"args\\": \\"ls -la\\"}","name":"bash"},"id":"call_456","type":"function","index":0}]}}],"created":1640995200,"id":"chatcmpl-456","usage":{"completion_tokens":5,"prompt_tokens":20,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":25},"model":"gpt-4","object":"chat.completion.chunk"}`;

			const result = parseSessionLogs(rawText);

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].choices[0].delta.tool_calls?.[0].function.name, 'bash');
		});

		it('should filter out non-data lines', function () {
			const rawText = `some random line
data: {"choices":[{"finish_reason":"stop","delta":{"content":"Hello","role":"assistant"}}],"created":1640995200,"id":"chatcmpl-123","usage":{"completion_tokens":1,"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":11},"model":"gpt-4","object":"chat.completion.chunk"}
another non-data line`;

			const result = parseSessionLogs(rawText);

			assert.strictEqual(result.length, 1);
		});
	});

	describe('parseToolCallDetails()', function () {
		it('should parse str_replace_editor tool calls with view command', function () {
			const toolCall = {
				function: {
					name: 'str_replace_editor',
					arguments: '{"command": "view", "path": "/home/runner/work/repo/repo/src/example.ts"}'
				},
				id: 'call_123',
				type: 'function',
				index: 0
			};

			const result = parseToolCallDetails(toolCall, '');

			assert.strictEqual(result.toolName, 'Read');
			assert.strictEqual(result.invocationMessage, 'Read src/example.ts');
			assert.strictEqual(result.pastTenseMessage, 'Read src/example.ts');
			if (result.toolSpecificData && 'command' in result.toolSpecificData) {
				assert.strictEqual(result.toolSpecificData.command, 'view');
			}
		});

		it('should parse str_replace_editor tool calls with edit command', function () {
			const toolCall = {
				function: {
					name: 'str_replace_editor',
					arguments: '{"command": "str_replace", "path": "/home/runner/work/repo/repo/src/example.ts"}'
				},
				id: 'call_123',
				type: 'function',
				index: 0
			};

			const result = parseToolCallDetails(toolCall, '');

			assert.strictEqual(result.toolName, 'Edit');
			assert.strictEqual(result.invocationMessage, 'Edit [](src/example.ts)');
			assert.strictEqual(result.pastTenseMessage, 'Edit [](src/example.ts)');
			if (result.toolSpecificData && 'command' in result.toolSpecificData) {
				assert.strictEqual(result.toolSpecificData.command, 'str_replace');
			}
		});

		it('should parse bash tool calls', function () {
			const toolCall = {
				function: {
					name: 'bash',
					arguments: '{"command": "npm test"}'
				},
				id: 'call_456',
				type: 'function',
				index: 0
			};

			const result = parseToolCallDetails(toolCall, 'Test output here');

			assert.strictEqual(result.toolName, 'Run Bash command');
			assert.strictEqual(result.invocationMessage, '$ npm test\nTest output here');
			if (result.toolSpecificData && 'language' in result.toolSpecificData) {
				assert.strictEqual(result.toolSpecificData.language, 'bash');
				assert.strictEqual(result.toolSpecificData.commandLine.original, 'npm test');
			}
		});

		it('should parse think tool calls', function () {
			const toolCall = {
				function: {
					name: 'think',
					arguments: '{}'
				},
				id: 'call_789',
				type: 'function',
				index: 0
			};

			const result = parseToolCallDetails(toolCall, 'I need to analyze this code');

			assert.strictEqual(result.toolName, 'think');
			assert.strictEqual(result.invocationMessage, 'I need to analyze this code');
		});

		it('should parse report_progress tool calls', function () {
			const toolCall = {
				function: {
					name: 'report_progress',
					arguments: '{"prDescription": "Updated the test files", "commitMessage": "feat: add new tests"}'
				},
				id: 'call_101',
				type: 'function',
				index: 0
			};

			const result = parseToolCallDetails(toolCall, '');

			assert.strictEqual(result.toolName, 'Progress Update');
			assert.strictEqual(result.invocationMessage, 'Updated the test files');
			assert.strictEqual(result.originMessage, 'Commit: feat: add new tests');
		});

		it('should handle unknown tool types', function () {
			const toolCall = {
				function: {
					name: 'unknown_tool',
					arguments: '{"param": "value"}'
				},
				id: 'call_999',
				type: 'function',
				index: 0
			};

			const result = parseToolCallDetails(toolCall, 'some content');

			assert.strictEqual(result.toolName, 'unknown_tool');
			assert.strictEqual(result.invocationMessage, 'some content');
		});

		it('should handle malformed tool arguments', function () {
			const toolCall = {
				function: {
					name: 'str_replace_editor',
					arguments: '{"invalid": json}'
				},
				id: 'call_error',
				type: 'function',
				index: 0
			};

			const result = parseToolCallDetails(toolCall, '');

			// Should fall back gracefully with empty args - goes to the 'else' branch which returns 'Edit'
			assert.strictEqual(result.toolName, 'Edit');
		});

		it('should handle repository root paths correctly', function () {
			const toolCall = {
				function: {
					name: 'str_replace_editor',
					arguments: '{"command": "view", "path": "/home/runner/work/repo/repo/"}'
				},
				id: 'call_root',
				type: 'function',
				index: 0
			};

			const result = parseToolCallDetails(toolCall, '');

			assert.strictEqual(result.toolName, 'Read repository');
			assert.strictEqual(result.invocationMessage, 'Read repository');
		});

		it('handles str_replace_editor view with diff-parsed content (empty file label -> repository)', function () {
			const diff = [
				'diff --git a/src/file.ts b/src/file.ts',
				'index 1111111..2222222 100644',
				'--- a/src/file.ts',
				'+++ b/src/file.ts',
				'@@ -1,2 +1,2 @@',
				'-old line',
				'+new line'
			].join('\n');
			const toolCall = makeToolCall('str_replace_editor', { command: 'view', view_range: [1, 10] });
			const result = parseToolCallDetails(toolCall, diff);
			assert.strictEqual(result.toolName, 'Read repository');
			assert.strictEqual(result.invocationMessage, 'Read repository');
		});

		it('handles str_replace_editor view with diff-parsed content (non-empty file label)', function () {
			const diff = [
				'diff --git a/home/runner/work/repo/repo/src/deep/file.ts b/home/runner/work/repo/repo/src/deep/file.ts',
				'index 1111111..2222222 100644',
				'--- a/home/runner/work/repo/repo/src/deep/file.ts',
				'+++ b/home/runner/work/repo/repo/src/deep/file.ts',
				'@@ -1,2 +1,2 @@',
				'-old line',
				'+new line'
			].join('\n');
			const toolCall = makeToolCall('str_replace_editor', { command: 'view', view_range: [2, 8] });
			const result = parseToolCallDetails(toolCall, diff);
			assert.strictEqual(result.toolName, 'Read');
			assert.ok(result.invocationMessage.includes('src/deep/file.ts'));
			assert.ok(result.invocationMessage.includes('lines 2 to 8'));
			assert.ok(result.toolSpecificData && 'command' in result.toolSpecificData);
		});

		it('handles str_replace_editor view with path but unparsable diff content (no diff headers)', function () {
			const content = 'just some file content without diff headers';
			const toolCall = makeToolCall('str_replace_editor', { command: 'view', path: '/home/runner/work/repo/repo/src/other.ts' });
			const result = parseToolCallDetails(toolCall, content);
			assert.strictEqual(result.toolName, 'Read');
			assert.strictEqual(result.invocationMessage, 'Read src/other.ts');
		});

		it('handles str_replace_editor view with undefined path (no label)', function () {
			const toolCall = makeToolCall('str_replace_editor', { command: 'view' });
			const result = parseToolCallDetails(toolCall, 'plain content');
			assert.strictEqual(result.toolName, 'Read repository');
			assert.strictEqual(result.invocationMessage, 'Read repository');
		});

		it('handles str_replace_editor view with root repository path empty label branch', function () {
			const toolCall = makeToolCall('str_replace_editor', { command: 'view', path: '/home/runner/work/repo/repo/' });
			const result = parseToolCallDetails(toolCall, 'content');
			assert.strictEqual(result.toolName, 'Read repository');
		});

		it('handles str_replace_editor edit with range', function () {
			const toolCall = makeToolCall('str_replace_editor', { command: 'edit', path: '/home/runner/work/repo/repo/src/editMe.ts', view_range: [5, 15] });
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Edit');
			assert.ok(result.invocationMessage.includes('lines 5 to 15'));
		});

		it('handles str_replace (non-editor) path missing label fallback', function () {
			// Provide a path that toFileLabel will still shorten; assert structure
			const toolCall = makeToolCall('str_replace', { path: '/home/runner/work/repo/repo/src/x.ts' });
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Edit');
			assert.strictEqual(result.invocationMessage, 'Edit [](src/x.ts)');
		});

		it('handles create tool call', function () {
			const toolCall = makeToolCall('create', { path: '/home/runner/work/repo/repo/new/file.txt' });
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Create');
			assert.strictEqual(result.invocationMessage, 'Create [](new/file.txt)');
		});

		it('handles view tool call (non str_replace_editor) with range and root path giving repository label', function () {
			const toolCall = makeToolCall('view', { path: '/home/runner/work/repo/repo/', view_range: [2, 3] });
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Read repository');
			assert.strictEqual(result.invocationMessage, 'Read repository');
		});

		it('handles view tool call (non str_replace_editor) with file path and range', function () {
			const toolCall = makeToolCall('view', { path: '/home/runner/work/repo/repo/src/app.ts', view_range: [3, 7] });
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Read');
			assert.ok(result.invocationMessage.includes('lines 3 to 7'));
		});

		it('handles bash tool call without command (only content)', function () {
			const toolCall = makeToolCall('bash', {});
			const result = parseToolCallDetails(toolCall, 'only output');
			assert.strictEqual(result.toolName, 'Run Bash command');
			assert.strictEqual(result.invocationMessage, 'only output');
			assert.ok(!result.toolSpecificData); // no command so no toolSpecificData
		});

		it('handles read_bash tool call', function () {
			const toolCall = makeToolCall('read_bash', {});
			const result = parseToolCallDetails(toolCall, 'ignored');
			assert.strictEqual(result.toolName, 'read_bash');
			assert.strictEqual(result.invocationMessage, 'Read logs from Bash session');
		});

		it('handles stop_bash tool call', function () {
			const toolCall = makeToolCall('stop_bash', {});
			const result = parseToolCallDetails(toolCall, 'ignored');
			assert.strictEqual(result.toolName, 'stop_bash');
			assert.strictEqual(result.invocationMessage, 'Stop Bash session');
		});

		it('handles unknown tool call with empty content falling back to name', function () {
			const toolCall = makeToolCall('mystery_tool', { some: 'arg' });
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'mystery_tool');
			assert.strictEqual(result.invocationMessage, 'mystery_tool');
		});

		it('gracefully handles invalid JSON arguments for non-view str_replace_editor (edit path undefined)', function () {
			const toolCall = {
				function: { name: 'str_replace_editor', arguments: '{"command": "edit", invalid' },
				id: 'bad_json',
				type: 'function',
				index: 0
			};
			// Since JSON parse fails, args becomes {} and we are in else branch -> toolName Edit without file label
			const result = parseToolCallDetails(toolCall as any, '');
			assert.strictEqual(result.toolName, 'Edit');
			assert.strictEqual(result.invocationMessage, 'Edit');
		});
	});

	describe('parseDiff()', function () {
		it('should parse diff content correctly', function () {
			const result = parseDiff(simpleDiff);

			assert(result);
			assert.strictEqual(result.fileA, '/src/file.ts');
			assert.strictEqual(result.fileB, '/src/file.ts');
			assert(result.content.includes("export function hello()"));
			assert(result.content.includes("console.log('hello world')"));
		});

		it('should extract file paths from diff headers', function () {
			const result = parseDiff(diffHeaders);

			assert(result);
			assert.strictEqual(result.fileA, '/package.json');
			assert.strictEqual(result.fileB, '/package.json');
		});

		it('should handle malformed diffs', function () {
			const diffContent = `not a diff at all`;

			const result = parseDiff(diffContent);

			assert.strictEqual(result, undefined);
		});

		it('should handle diffs without @@ lines', function () {
			const result = parseDiff(diffNoAts);

			assert.strictEqual(result, undefined);
		});
	});

	describe('toFileLabel()', function () {
		it('should convert absolute paths to relative labels', function () {
			const path = '/home/runner/work/repo/repo/src/components/Button.tsx';

			const result = toFileLabel(path);

			assert.strictEqual(result, 'src/components/Button.tsx');
		});

		it('should handle various path formats', function () {
			assert.strictEqual(toFileLabel('/home/runner/work/repo/repo/package.json'), 'package.json');
			assert.strictEqual(toFileLabel('/home/runner/work/repo/repo/src/index.ts'), 'src/index.ts');
			assert.strictEqual(toFileLabel('/home/runner/work/repo/repo/docs/README.md'), 'docs/README.md');
		});

		it('should handle edge cases', function () {
			assert.strictEqual(toFileLabel('/home/runner/work/repo/repo/'), '');
			assert.strictEqual(toFileLabel('/'), '');
			assert.strictEqual(toFileLabel(''), '');
		});

		it('should handle shorter paths', function () {
			const shortPath = '/home/runner/work/repo';

			const result = toFileLabel(shortPath);

			// Should return empty string when path is too short
			assert.strictEqual(result, '');
		});
	});
});
