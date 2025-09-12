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
});