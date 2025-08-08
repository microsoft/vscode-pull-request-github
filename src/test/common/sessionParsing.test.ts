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

			assert.strictEqual(result.toolName, 'Thought');
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
