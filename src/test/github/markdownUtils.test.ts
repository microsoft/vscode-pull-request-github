/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as marked from 'marked';
import { escapeMarkdownText, PlainTextRenderer } from '../../github/markdownUtils';

describe('escapeMarkdownText', () => {
	it('preserves breakable spaces and paragraph boundaries', () => {
		const text = 'Using ghe.io for GitHub Enterprise.\n\nSelect an account for github.ghe.com.';
		const escaped = escapeMarkdownText(text);
		assert.ok(escaped.includes(' for GitHub Enterprise'));
		assert.ok(escaped.includes('\n\n'));
		assert.doesNotMatch(escaped, /&nbsp;|\u00a0/);
		assert.strictEqual(marked.parse(escaped), '<p>Using ghe.io for GitHub Enterprise.</p>\n<p>Select an account for github.ghe.com.</p>\n');
	});

	it('renders links, HTML, and formatting from instance names as text', () => {
		const text = 'host.example/[open](command:unexpected) *name* <script>alert(1)</script> &nbsp; `code`';
		const rendered = marked.parse(escapeMarkdownText(text));
		assert.doesNotMatch(rendered, /<a\b|<script\b|<em\b|<code\b/);
		assert.ok(rendered.includes('[open](command:unexpected)'));
		assert.ok(rendered.includes('&lt;script&gt;'));
		assert.ok(rendered.includes('&amp;nbsp;'));
	});
});

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