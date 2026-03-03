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
		it('should handle empty arguments string (covers ternary else)', function () {
			// forces the ternary at line ~165 in sessionParsing.ts to take the else branch
			const toolCall = {
				function: {
					name: 'str_replace_editor',
					arguments: '' // empty string -> falsy -> args stays {}
				},
				id: 'call_empty_args',
				type: 'function',
				index: 0
			};

			const result = parseToolCallDetails(toolCall as any, '');
			assert.strictEqual(result.toolName, 'Edit');
			assert.strictEqual(result.invocationMessage, 'Edit');
		});
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

		it('should default think tool call to Thought when no args.thought and no content', function () {
			const toolCall = {
				function: {
					name: 'think',
					arguments: '{}' // no thought provided
				},
				id: 'call_790',
				type: 'function',
				index: 0
			};

			// Pass empty string content so code falls back to 'Thought'
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'think');
			assert.strictEqual(result.invocationMessage, 'Thought');
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

		it('report_progress falls back to content when prDescription empty string', function () {
			// prDescription provided but empty => falsy, so chain uses content
			const toolCall = {
				function: {
					name: 'report_progress',
					arguments: '{"prDescription": ""}'
				},
				id: 'call_102',
				type: 'function',
				index: 0
			};

			const fallbackContent = 'Using content as progress update';
			const result = parseToolCallDetails(toolCall, fallbackContent);
			assert.strictEqual(result.toolName, 'Progress Update');
			assert.strictEqual(result.invocationMessage, fallbackContent);
		});

		it('report_progress falls back to default when prDescription and content empty', function () {
			// Both prDescription (empty string) and content ('') are falsy => 'Progress Update'
			const toolCall = {
				function: {
					name: 'report_progress',
					arguments: '{"prDescription": ""}'
				},
				id: 'call_103',
				type: 'function',
				index: 0
			};

			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Progress Update');
			assert.strictEqual(result.invocationMessage, 'Progress Update');
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

		it('handles str_replace_editor view with diff-parsed content and no range (parsedRange undefined)', function () {
			// This exercises the branch where parsedRange is falsy so no ", lines X to Y" suffix is appended
			const diff = [
				'diff --git a/home/runner/work/repo/repo/src/another/file.ts b/home/runner/work/repo/repo/src/another/file.ts',
				'index aaaaaaa..bbbbbbb 100644',
				'--- a/home/runner/work/repo/repo/src/another/file.ts',
				'+++ b/home/runner/work/repo/repo/src/another/file.ts',
				'@@ -1,2 +1,2 @@',
				'-old line',
				'+new line'
			].join('\n');
			const toolCall = makeToolCall('str_replace_editor', { command: 'view' }); // no view_range provided
			const result = parseToolCallDetails(toolCall, diff);
			assert.strictEqual(result.toolName, 'Read');
			assert.ok(result.invocationMessage.includes('src/another/file.ts'));
			assert.ok(!/lines \d+ to \d+/.test(result.invocationMessage), 'invocationMessage should not contain line range');
			assert.ok(result.pastTenseMessage && result.pastTenseMessage === result.invocationMessage);
		});

		it('handles str_replace_editor view with path but unparsable diff content (no diff headers)', function () {
			const content = 'just some file content without diff headers';
			const toolCall = makeToolCall('str_replace_editor', { command: 'view', path: '/home/runner/work/repo/repo/src/other.ts' });
			const result = parseToolCallDetails(toolCall, content);
			assert.strictEqual(result.toolName, 'Read');
			assert.strictEqual(result.invocationMessage, 'Read src/other.ts');
		});

		it('handles str_replace_editor view with path and range (parsedRange defined)', function () {
			// This covers the branch in sessionParsing.ts lines ~202-212 where parsedRange is defined
			// and a normal file path (no diff content) is provided so invocationMessage includes the lines suffix.
			const toolCall = makeToolCall('str_replace_editor', { command: 'view', path: '/home/runner/work/repo/repo/src/ranged.ts', view_range: [4, 9] });
			const result = parseToolCallDetails(toolCall, 'plain file content');
			assert.strictEqual(result.toolName, 'Read');
			assert.strictEqual(result.invocationMessage, 'Read src/ranged.ts, lines 4 to 9');
			assert.strictEqual(result.pastTenseMessage, 'Read src/ranged.ts, lines 4 to 9');
			assert.ok(result.toolSpecificData && 'viewRange' in result.toolSpecificData, 'Expected viewRange in toolSpecificData');
			if (result.toolSpecificData && 'viewRange' in result.toolSpecificData) {
				assert.strictEqual(result.toolSpecificData.viewRange?.start, 4);
				assert.strictEqual(result.toolSpecificData.viewRange?.end, 9);
			}
		});

		it('handles str_replace_editor view with diff hunk but no diff header (fileA undefined)', function () {
			// This diff content has an @@ hunk so parseDiff returns an object, but no 'diff --git' header,
			// therefore fileA and fileB remain undefined. This exercises the fallback at line ~177 where
			// file is chosen via parsedContent.fileA ?? parsedContent.fileB resulting in undefined and thus
			// a repository-level read.
			const diffOnlyHunk = [
				'@@ -1,2 +1,2 @@',
				'-old line',
				'+new line'
			].join('\n');
			const toolCall = makeToolCall('str_replace_editor', { command: 'view', view_range: [1, 2] });
			const result = parseToolCallDetails(toolCall, diffOnlyHunk);
			// fileLabel is undefined so toolName is 'Read' but invocation message falls back to 'Read repository'
			assert.strictEqual(result.toolName, 'Read');
			assert.strictEqual(result.invocationMessage, 'Read repository');
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

		it('handles str_replace_editor edit when args.command is undefined (defaults to edit)', function () {
			// Covers sessionParsing.ts lines 220-230 where args.command || 'edit' supplies default
			const toolCall = makeToolCall('str_replace_editor', { path: '/home/runner/work/repo/repo/src/implicitEdit.ts' });
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Edit');
			assert.strictEqual(result.invocationMessage, 'Edit [](src/implicitEdit.ts)');
			assert.ok(result.toolSpecificData && 'command' in result.toolSpecificData, 'Expected toolSpecificData for edit operation');
			if (result.toolSpecificData && 'command' in result.toolSpecificData) {
				assert.strictEqual(result.toolSpecificData.command, 'edit'); // default applied
			}
		});

		it('handles str_replace (non-editor) path missing label fallback', function () {
			// Provide a path that toFileLabel will still shorten; assert structure
			const toolCall = makeToolCall('str_replace', { path: '/home/runner/work/repo/repo/src/x.ts' });
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Edit');
			assert.strictEqual(result.invocationMessage, 'Edit [](src/x.ts)');
		});

		it('handles str_replace with undefined path (fileLabel undefined)', function () {
			// No path provided -> filePath undefined -> fileLabel undefined, should fall back to `Edit ${filePath}` which is 'Edit undefined'
			const toolCall = makeToolCall('str_replace', { /* no path */ });
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Edit');
			assert.strictEqual(result.invocationMessage, 'Edit undefined');
			assert.strictEqual(result.pastTenseMessage, 'Edit undefined');
			assert.strictEqual(result.toolSpecificData, undefined);
		});

		it('handles create tool call', function () {
			const toolCall = makeToolCall('create', { path: '/home/runner/work/repo/repo/new/file.txt' });
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Create');
			assert.strictEqual(result.invocationMessage, 'Create [](new/file.txt)');
		});

		it('handles create tool call without path (fileLabel undefined)', function () {
			const toolCall = makeToolCall('create', { /* no path provided */ });
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Create');
			assert.strictEqual(result.invocationMessage, 'Create File undefined');
			assert.strictEqual(result.pastTenseMessage, 'Create File undefined');
			assert.strictEqual(result.toolSpecificData, undefined);
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

		it('handles view tool call (non str_replace_editor) with file path and no range (parsedRange undefined)', function () {
			// Covers lines 261-275 in sessionParsing.ts where parsedRange is falsy, so
			// the ", lines X to Y" suffix should NOT be appended.
			const toolCall = makeToolCall('view', { path: '/home/runner/work/repo/repo/src/noRange.ts' });
			const result = parseToolCallDetails(toolCall, 'file content');
			assert.strictEqual(result.toolName, 'Read');
			assert.ok(result.invocationMessage === 'Read [](src/noRange.ts)', 'invocationMessage should not contain line range');
			assert.ok(result.pastTenseMessage === 'Read [](src/noRange.ts)', 'pastTenseMessage should not contain line range');
			assert.ok(result.toolSpecificData && 'viewRange' in result.toolSpecificData && !result.toolSpecificData.viewRange, 'viewRange should be undefined');
		});

		it('handles bash tool call without command (only content)', function () {
			const toolCall = makeToolCall('bash', {});
			const result = parseToolCallDetails(toolCall, 'only output');
			assert.strictEqual(result.toolName, 'Run Bash command');
			assert.strictEqual(result.invocationMessage, 'only output');
			assert.ok(!result.toolSpecificData); // no command so no toolSpecificData
		});

		it('handles bash tool call without command and without content (fallback to default message)', function () {
			// Exercises bashContent empty so code uses 'Run Bash command' fallback (lines ~292-300)
			const toolCall = makeToolCall('bash', {});
			const result = parseToolCallDetails(toolCall, '');
			assert.strictEqual(result.toolName, 'Run Bash command');
			assert.strictEqual(result.invocationMessage, 'Run Bash command');
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

		it('handles unknown tool call with falsy name (empty string) returning unknown', function () {
			// Directly craft toolCall without using makeToolCall so we can force empty name
			const toolCall = {
				function: { name: '', arguments: '{}' },
				id: 'call_empty_name',
				type: 'function',
				index: 0
			};
			const result = parseToolCallDetails(toolCall as any, '');
			assert.strictEqual(result.toolName, 'unknown');
			assert.strictEqual(result.invocationMessage, 'unknown');
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

		it('handles str_replace_editor view with no path and no range (fileLabel undefined branch)', function () {
			// Triggers the branch where args.path is undefined and thus fileLabel is undefined
			const toolCall = makeToolCall('str_replace_editor', { command: 'view', path: '' });
			const result = parseToolCallDetails(toolCall, 'plain non-diff content');
			assert.strictEqual(result.toolName, 'Read repository');
			assert.strictEqual(result.invocationMessage, 'Read repository');
			assert.strictEqual(result.pastTenseMessage, 'Read repository');
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
