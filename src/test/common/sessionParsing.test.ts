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
	SessionResponseLogChunk,
	ParsedToolCall,
	ParsedChoice,
	ParsedToolCallDetails,
	StrReplaceEditorToolData,
	BashToolData
} from '../../../common/sessionParsing';

describe('sessionParsing', function () {
	describe('parseSessionLogs', function () {
		it('should parse valid session logs', function () {
			const rawText = `data: {"choices":[{"finish_reason":"stop","delta":{"content":"Hello","role":"assistant"}}],"created":1234567890,"id":"test-id","usage":{"completion_tokens":1,"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":11},"model":"gpt-4","object":"chat.completion.chunk"}
data: {"choices":[{"finish_reason":"","delta":{"tool_calls":[{"function":{"arguments":"{\\"command\\":\\"view\\"}","name":"str_replace_editor"},"id":"call_123","type":"function","index":0}],"role":"assistant"}}],"created":1234567891,"id":"test-id-2","usage":{"completion_tokens":2,"prompt_tokens":15,"prompt_tokens_details":{"cached_tokens":5},"total_tokens":17},"model":"gpt-4","object":"chat.completion.chunk"}`;

			const chunks = parseSessionLogs(rawText);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0].choices[0].delta.content, 'Hello');
			assert.strictEqual(chunks[0].choices[0].delta.role, 'assistant');
			assert.strictEqual(chunks[0].choices[0].finish_reason, 'stop');
			assert.strictEqual(chunks[0].created, 1234567890);
			assert.strictEqual(chunks[0].id, 'test-id');
			assert.strictEqual(chunks[0].usage.total_tokens, 11);

			assert.strictEqual(chunks[1].choices[0].delta.tool_calls?.[0].function.name, 'str_replace_editor');
			assert.strictEqual(chunks[1].choices[0].delta.tool_calls?.[0].id, 'call_123');
			assert.strictEqual(chunks[1].choices[0].delta.tool_calls?.[0].type, 'function');
		});

		it('should handle empty input', function () {
			const chunks = parseSessionLogs('');
			assert.strictEqual(chunks.length, 0);
		});

		it('should filter out non-data lines', function () {
			const rawText = `some random line
data: {"choices":[{"finish_reason":"stop","delta":{"content":"Test","role":"assistant"}}],"created":1234567890,"id":"test-id","usage":{"completion_tokens":1,"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":11},"model":"gpt-4","object":"chat.completion.chunk"}
another random line`;

			const chunks = parseSessionLogs(rawText);
			assert.strictEqual(chunks.length, 1);
			assert.strictEqual(chunks[0].choices[0].delta.content, 'Test');
		});
	});

	describe('parseDiff', function () {
		it('should parse a valid diff', function () {
			const diffContent = `diff --git a/src/file.ts b/src/file.ts
index 123..456 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
 export function test() {
+  console.log('new line');
   return true;
 }`;

			const result = parseDiff(diffContent);
			assert.ok(result);
			assert.strictEqual(result.fileA, '/src/file.ts');
			assert.strictEqual(result.fileB, '/src/file.ts');
			assert.ok(result.content.includes('export function test()'));
			assert.ok(result.content.includes('+  console.log(\'new line\');'));
		});

		it('should handle diff with different file names', function () {
			const diffContent = `diff --git a/old-file.ts b/new-file.ts
index 123..456 100644
--- a/old-file.ts
+++ b/new-file.ts
@@ -1,2 +1,2 @@
-old content
+new content`;

			const result = parseDiff(diffContent);
			assert.ok(result);
			assert.strictEqual(result.fileA, '/old-file.ts');
			assert.strictEqual(result.fileB, '/new-file.ts');
		});

		it('should return undefined for invalid diff', function () {
			const invalidDiff = 'not a diff';
			const result = parseDiff(invalidDiff);
			assert.strictEqual(result, undefined);
		});

		it('should return undefined when no @@ line found', function () {
			const diffContent = `diff --git a/src/file.ts b/src/file.ts
index 123..456 100644
--- a/src/file.ts
+++ b/src/file.ts`;

			const result = parseDiff(diffContent);
			assert.strictEqual(result, undefined);
		});
	});

	describe('toFileLabel', function () {
		it('should convert absolute path to relative file label', function () {
			const absolutePath = '/home/runner/work/repo/repo/src/file.ts';
			const result = toFileLabel(absolutePath);
			assert.strictEqual(result, 'src/file.ts');
		});

		it('should handle nested paths', function () {
			const absolutePath = '/home/runner/work/repo/repo/src/components/Button.tsx';
			const result = toFileLabel(absolutePath);
			assert.strictEqual(result, 'src/components/Button.tsx');
		});

		it('should handle root file', function () {
			const absolutePath = '/home/runner/work/repo/repo/README.md';
			const result = toFileLabel(absolutePath);
			assert.strictEqual(result, 'README.md');
		});

		it('should handle empty result', function () {
			const absolutePath = '/home/runner/work/repo/repo/';
			const result = toFileLabel(absolutePath);
			assert.strictEqual(result, '');
		});
	});

	describe('parseToolCallDetails', function () {
		describe('str_replace_editor tool', function () {
			it('should parse view command with file path', function () {
				const toolCall = {
					function: {
						name: 'str_replace_editor',
						arguments: '{"command":"view","path":"/home/runner/work/repo/repo/src/test.ts"}'
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = 'File content here';

				const result = parseToolCallDetails(toolCall, content);

				assert.strictEqual(result.toolName, 'Read');
				assert.strictEqual(result.invocationMessage, 'Read src/test.ts');
				assert.strictEqual(result.pastTenseMessage, 'Read src/test.ts');
				assert.ok(result.toolSpecificData);
				const data = result.toolSpecificData as StrReplaceEditorToolData;
				assert.strictEqual(data.command, 'view');
				assert.strictEqual(data.filePath, '/home/runner/work/repo/repo/src/test.ts');
				assert.strictEqual(data.fileLabel, 'src/test.ts');
			});

			it('should parse view command for repository root', function () {
				const toolCall = {
					function: {
						name: 'str_replace_editor',
						arguments: '{"command":"view","path":"/home/runner/work/repo/repo/"}'
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = 'Repository listing';

				const result = parseToolCallDetails(toolCall, content);

				assert.strictEqual(result.toolName, 'Read repository');
				assert.strictEqual(result.invocationMessage, 'Read repository');
				assert.strictEqual(result.pastTenseMessage, 'Read repository');
			});

			it('should parse view command with diff content', function () {
				const toolCall = {
					function: {
						name: 'str_replace_editor',
						arguments: '{"command":"view"}'
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = `diff --git a/src/file.ts b/src/file.ts
index 123..456 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
 export function test() {
+  console.log('new line');
   return true;
 }`;

				const result = parseToolCallDetails(toolCall, content);

				assert.strictEqual(result.toolName, 'Read');
				assert.strictEqual(result.invocationMessage, 'Read [](src/file.ts)');
				assert.strictEqual(result.pastTenseMessage, 'Read [](src/file.ts)');
				assert.ok(result.toolSpecificData);
				const data = result.toolSpecificData as StrReplaceEditorToolData;
				assert.strictEqual(data.command, 'view');
				assert.strictEqual(data.filePath, '/src/file.ts');
				assert.strictEqual(data.fileLabel, 'src/file.ts');
				assert.ok(data.parsedContent);
			});

			it('should parse edit command', function () {
				const toolCall = {
					function: {
						name: 'str_replace_editor',
						arguments: '{"command":"str_replace","path":"/home/runner/work/repo/repo/src/test.ts","old_str":"old code","new_str":"new code"}'
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = 'Edit result';

				const result = parseToolCallDetails(toolCall, content);

				assert.strictEqual(result.toolName, 'Edit');
				assert.strictEqual(result.invocationMessage, 'Edit [](src/test.ts)');
				assert.strictEqual(result.pastTenseMessage, 'Edit [](src/test.ts)');
				assert.ok(result.toolSpecificData);
				const data = result.toolSpecificData as StrReplaceEditorToolData;
				assert.strictEqual(data.command, 'str_replace');
				assert.strictEqual(data.filePath, '/home/runner/work/repo/repo/src/test.ts');
				assert.strictEqual(data.fileLabel, 'src/test.ts');
			});
		});

		describe('bash tool', function () {
			it('should parse bash command with arguments', function () {
				const toolCall = {
					function: {
						name: 'bash',
						arguments: '{"command":"npm run test","description":"Run tests","sessionId":"test-session","async":false}'
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = 'Command output here';

				const result = parseToolCallDetails(toolCall, content);

				assert.strictEqual(result.toolName, 'Run Bash command');
				assert.strictEqual(result.invocationMessage, '$ npm run test\nCommand output here');
				assert.ok(result.toolSpecificData);
				const data = result.toolSpecificData as BashToolData;
				assert.strictEqual(data.commandLine.original, 'npm run test');
				assert.strictEqual(data.language, 'bash');
			});

			it('should parse bash command without arguments', function () {
				const toolCall = {
					function: {
						name: 'bash',
						arguments: '{}'
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = 'Command output here';

				const result = parseToolCallDetails(toolCall, content);

				assert.strictEqual(result.toolName, 'Run Bash command');
				assert.strictEqual(result.invocationMessage, 'Command output here');
			});
		});

		describe('think tool', function () {
			it('should parse think tool', function () {
				const toolCall = {
					function: {
						name: 'think',
						arguments: '{"thought":"Planning the next steps"}'
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = 'Planning the next steps';

				const result = parseToolCallDetails(toolCall, content);

				assert.strictEqual(result.toolName, 'Thought');
				assert.strictEqual(result.invocationMessage, 'Planning the next steps');
			});
		});

		describe('report_progress tool', function () {
			it('should parse report_progress tool with commit message', function () {
				const toolCall = {
					function: {
						name: 'report_progress',
						arguments: '{"commitMessage":"Fix issue #123","prDescription":"- [x] Fixed the bug\\n- [ ] Write tests"}'
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = 'Progress updated';

				const result = parseToolCallDetails(toolCall, content);

				assert.strictEqual(result.toolName, 'Progress Update');
				assert.strictEqual(result.invocationMessage, '- [x] Fixed the bug\n- [ ] Write tests');
				assert.strictEqual(result.originMessage, 'Commit: Fix issue #123');
			});

			it('should parse report_progress tool without commit message', function () {
				const toolCall = {
					function: {
						name: 'report_progress',
						arguments: '{"prDescription":"Updated documentation"}'
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = 'Progress updated';

				const result = parseToolCallDetails(toolCall, content);

				assert.strictEqual(result.toolName, 'Progress Update');
				assert.strictEqual(result.invocationMessage, 'Updated documentation');
				assert.strictEqual(result.originMessage, undefined);
			});
		});

		describe('unknown tool', function () {
			it('should parse unknown tool type', function () {
				const toolCall = {
					function: {
						name: 'unknown_tool',
						arguments: '{"param":"value"}'
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = 'Unknown tool output';

				const result = parseToolCallDetails(toolCall, content);

				assert.strictEqual(result.toolName, 'unknown_tool');
				assert.strictEqual(result.invocationMessage, 'Unknown tool output');
			});
		});

		describe('error handling', function () {
			it('should handle malformed JSON arguments', function () {
				const toolCall = {
					function: {
						name: 'str_replace_editor',
						arguments: 'invalid json'
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = 'Content';

				const result = parseToolCallDetails(toolCall, content);

				// Should not throw and should handle gracefully
				assert.ok(result);
				assert.strictEqual(result.toolName, 'Edit');
			});

			it('should handle empty arguments', function () {
				const toolCall = {
					function: {
						name: 'bash',
						arguments: ''
					},
					id: 'call_123',
					type: 'function',
					index: 0
				};
				const content = 'Content';

				const result = parseToolCallDetails(toolCall, content);

				assert.ok(result);
				assert.strictEqual(result.toolName, 'Run Bash command');
				assert.strictEqual(result.invocationMessage, 'Content');
			});
		});
	});
});