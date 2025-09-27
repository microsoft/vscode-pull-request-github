/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as marked from 'marked';
import { PlainTextRenderer } from '../../github/markdownUtils';

describe('PlainTextRenderer', () => {
	it('should escape inline code by default', () => {
		const renderer = new PlainTextRenderer();
		const result = marked.parse('rename the `Foo` class', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'rename the \\`Foo\\` class');
	});

	it('should preserve inline code when allowSimpleMarkdown is true', () => {
		const renderer = new PlainTextRenderer(true);
		const result = marked.parse('rename the `Foo` class', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'rename the `Foo` class');
	});

	it('should handle multiple inline code spans', () => {
		const renderer = new PlainTextRenderer(true);
		const result = marked.parse('rename the `Foo` class to `Bar`', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'rename the `Foo` class to `Bar`');
	});

	it('should still escape when allowSimpleMarkdown is false', () => {
		const renderer = new PlainTextRenderer(false);
		const result = marked.parse('rename the `Foo` class to `Bar`', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'rename the \\`Foo\\` class to \\`Bar\\`');
	});

	it('should strip all formatting by default', () => {
		const renderer = new PlainTextRenderer(false);
		const result = marked.parse('rename the `Foo` class to **`Bar`** and make it *italic*', { renderer, smartypants: true });
		assert.strictEqual(result.trim(), 'rename the \\`Foo\\` class to \\`Bar\\` and make it italic');
	});
});