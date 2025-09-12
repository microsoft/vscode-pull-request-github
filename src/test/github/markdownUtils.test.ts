/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as marked from 'marked';
import { PlainTextRenderer } from '../../github/markdownUtils';

suite('PlainTextRenderer', () => {
	test('should escape inline code by default', () => {
		const renderer = new PlainTextRenderer();
		const result = marked.parse('rename the `Foo` class', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'rename the \\`Foo\\` class');
	});

	test('should preserve inline code when allowSimpleMarkdown is true', () => {
		const renderer = new PlainTextRenderer(true);
		const result = marked.parse('rename the `Foo` class', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'rename the `Foo` class');
	});

	test('should handle multiple inline code spans', () => {
		const renderer = new PlainTextRenderer(true);
		const result = marked.parse('rename the `Foo` class to `Bar`', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'rename the `Foo` class to `Bar`');
	});

	test('should still escape when allowSimpleMarkdown is false', () => {
		const renderer = new PlainTextRenderer(false);
		const result = marked.parse('rename the `Foo` class to `Bar`', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'rename the \\`Foo\\` class to \\`Bar\\`');
	});

	test('should strip strong formatting by default', () => {
		const renderer = new PlainTextRenderer();
		const result = marked.parse('This is **bold** text', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'This is bold text');
	});

	test('should preserve strong formatting when allowSimpleMarkdown is true', () => {
		const renderer = new PlainTextRenderer(true);
		const result = marked.parse('This is **bold** text', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'This is **bold** text');
	});

	test('should strip em formatting by default', () => {
		const renderer = new PlainTextRenderer();
		const result = marked.parse('This is *italic* text', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'This is italic text');
	});

	test('should preserve em formatting when allowSimpleMarkdown is true', () => {
		const renderer = new PlainTextRenderer(true);
		const result = marked.parse('This is *italic* text', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'This is *italic* text');
	});

	test('should handle combined formatting when allowSimpleMarkdown is true', () => {
		const renderer = new PlainTextRenderer(true);
		const result = marked.parse('rename the `Foo` class to **`Bar`** and make it *italic*', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'rename the `Foo` class to **`Bar`** and make it *italic*');
	});

	test('should strip all formatting by default', () => {
		const renderer = new PlainTextRenderer(false);
		const result = marked.parse('rename the `Foo` class to **`Bar`** and make it *italic*', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'rename the \\`Foo\\` class to \\`Bar\\` and make it italic');
	});
});