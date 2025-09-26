/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { truncatePrompt, extractTitle, formatBodyPlaceholder } from '../../github/copilotRemoteAgentUtils';
import { MAX_PROBLEM_STATEMENT_LENGTH } from '../../github/copilotApi';

describe('copilotRemoteAgentUtils', () => {

	describe('truncatePrompt', () => {
		it('should return prompt and context unchanged when under limit', () => {
			const prompt = 'This is a short prompt';
			const context = 'This is some additional context';
			const result = truncatePrompt(prompt, context);
			assert.strictEqual(result.problemStatement, `${prompt}\n\n${context}`);
			assert.strictEqual(result.isTruncated, false);
		});

		it('should return only prompt when no context provided and under limit', () => {
			const prompt = 'This is a short prompt';
			const result = truncatePrompt(prompt);
			assert.strictEqual(result.problemStatement, 'This is a short prompt');
			assert.strictEqual(result.isTruncated, false);
		});

		it('should truncate prompt when it exceeds the maximum length', () => {
			const longPrompt = 'a'.repeat(MAX_PROBLEM_STATEMENT_LENGTH + 100);
			const result = truncatePrompt(longPrompt);
			assert.strictEqual(result.problemStatement.length, MAX_PROBLEM_STATEMENT_LENGTH);
			assert.strictEqual(result.isTruncated, true);
		});

		it('should truncate context when combined length exceeds limit', () => {
			const prompt = 'Short prompt';
			const longContext = 'b'.repeat(MAX_PROBLEM_STATEMENT_LENGTH);

			const result = truncatePrompt(prompt, longContext);

			assert.strictEqual(result.isTruncated, true);
			assert(result.problemStatement.startsWith(prompt));
			assert(result.problemStatement.includes('\n\n'));
			const expectedAvailableLength = MAX_PROBLEM_STATEMENT_LENGTH - prompt.length;
			const expectedContext = longContext.slice(-expectedAvailableLength + 2);
			assert.strictEqual(result.problemStatement, `${prompt}\n\n${expectedContext}`);
		});

		it('long prompts are prioritized when truncating', () => {
			const longPrompt = 'a'.repeat(MAX_PROBLEM_STATEMENT_LENGTH + 100);
			const context = 'B';

			const result = truncatePrompt(longPrompt, context);

			assert.strictEqual(result.isTruncated, true);
			assert.strictEqual(result.problemStatement.length, MAX_PROBLEM_STATEMENT_LENGTH);
			assert(!result.problemStatement.includes(context));
		});
	});

	describe('extractTitle', () => {
		it('should extract title from context with TITLE prefix', () => {
			const context = 'Some initial text\nTITLE: Fix authentication bug\nSome other content';

			const result = extractTitle(context);

			assert.strictEqual(result, 'Fix authentication bug');
		});

		it('should extract title with case insensitive matching', () => {
			const context = 'Some text\ntitle: Add new feature\nMore text';

			const result = extractTitle(context);

			assert.strictEqual(result, 'Add new feature');
		});

		it('should extract title with extra whitespace', () => {
			const context = 'TITLE:   Refactor code structure   \n';

			const result = extractTitle(context);

			assert.strictEqual(result, 'Refactor code structure');
		});

		it('should return undefined when no title is found', () => {
			const context = 'Some text without any title marker\nJust regular content';

			const result = extractTitle(context);

			assert.strictEqual(result, undefined);
		});

		it('should return undefined when context is undefined', () => {
			const result = extractTitle(undefined);

			assert.strictEqual(result, undefined);
		});

		it('should return undefined when context is empty string', () => {
			const result = extractTitle('');

			assert.strictEqual(result, undefined);
		});
	});
});