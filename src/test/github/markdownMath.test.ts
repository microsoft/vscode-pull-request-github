/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import type { Token } from 'markdown-it';
import * as vscode from 'vscode';
import { getMathStyleUris, MARKDOWN_MATH_EXTENSION_ID, processMath, renderMathElements, renderTexWithMarkdownIt } from '../../github/markdownMath';

const INLINE_MATH = '<math-renderer class="js-inline-math" style="display: inline-block" data-run-id="1">$x^2$</math-renderer>';
const DISPLAY_MATH = '<math-renderer class="js-display-math" style="display: block" data-run-id="1">$$\n\\int \\frac{1}{\\sqrt{x}} dx,\n$$</math-renderer>';

describe('markdownMath', function () {
	describe('renderMathElements', function () {
		function render(html: string): { result: string; calls: [string, boolean][] } {
			const calls: [string, boolean][] = [];
			const result = renderMathElements(html, (tex, displayMode) => {
				calls.push([tex, displayMode]);
				return `<span class="rendered">${displayMode ? 'display' : 'inline'}</span>`;
			});
			return { result, calls };
		}

		it('renders inline and display math without the delimiters', function () {
			const { result, calls } = render(`<p dir="auto">Square ${INLINE_MATH} and integrate</p>\n<p dir="auto">${DISPLAY_MATH}</p>`);
			assert.deepStrictEqual(calls, [['x^2', false], ['\n\\int \\frac{1}{\\sqrt{x}} dx,\n', true]]);
			assert.strictEqual(result, '<p dir="auto">Square <span class="rendered">inline</span> and integrate</p>\n<p dir="auto"><span class="rendered">display</span></p>');
		});

		it('decodes the HTML escaping of the TeX', function () {
			const { calls } = render('<math-renderer class="js-inline-math">$a &lt; b &amp;&amp; c &gt; d &#39;&#x27;&quot; &unknown; &#1114112;$</math-renderer>');
			assert.deepStrictEqual(calls, [['a < b && c > d \'\'" &unknown; &#1114112;', false]]);
		});

		it('keeps math that cannot be rendered', function () {
			const html = `<p dir="auto">${INLINE_MATH}</p>`;
			assert.strictEqual(renderMathElements(html, () => undefined), html);
		});

		for (const html of [
			'<math-renderer class="js-inline-math">x^2</math-renderer>',
			'<math-renderer class="js-display-math">$x^2$</math-renderer>',
			'<math-renderer class="js-inline-math">$$</math-renderer>',
			'<math-renderer class="js-inline-math">$x <b>2</b>$</math-renderer>',
		]) {
			it(`keeps unexpected math content: ${html}`, function () {
				const { result, calls } = render(html);
				assert.deepStrictEqual(calls, []);
				assert.strictEqual(result, html);
			});
		}
	});

	describe('renderTexWithMarkdownIt', function () {
		const inline = '<span class="katex"><span class="katex-html">x</span></span>';
		const display = `<span class="katex-display">${inline}</span>`;

		function markdownIt(children: Token[], output: string) {
			const sources: string[] = [];
			const rendered: Token[][] = [];
			return {
				sources,
				rendered,
				md: {
					options: {},
					parseInline: (src: string): Token[] => {
						sources.push(src);
						return [{ type: 'inline', content: src, children }];
					},
					renderer: {
						renderInline: (tokens: Token[]) => {
							rendered.push(tokens);
							return output;
						}
					}
				}
			};
		}

		function token(type: string, content: string = 'x'): Token {
			return { type, content, children: null };
		}

		it('renders inline math as a single KaTeX expression', function () {
			const children = [token('math_inline')];
			const { md, sources, rendered } = markdownIt(children, inline);
			assert.strictEqual(renderTexWithMarkdownIt(md, 'x', false), inline);
			assert.deepStrictEqual(sources, ['$x$']);
			assert.deepStrictEqual(rendered, [children]);
		});

		it('renders display math without the paragraph around it', function () {
			const { md, sources } = markdownIt([token('math_block')], `<p class="katex-block">${display}</p>\n`);
			assert.strictEqual(renderTexWithMarkdownIt(md, 'x', true), display);
			assert.deepStrictEqual(sources, ['$$x$$']);
		});

		for (const [name, output, displayMode] of [
			['errors', '<span class="katex-error" title="\\foo">\\foo</span>', false],
			['display errors', '<p class="katex-block katex-error" title="\\foo">\\foo</p>\n', true],
		] as const) {
			it(`does not use ${name}`, function () {
				const { md } = markdownIt([token(displayMode ? 'math_block' : 'math_inline')], output);
				assert.strictEqual(renderTexWithMarkdownIt(md, 'x', displayMode), undefined);
			});
		}

		for (const [name, children, displayMode] of [
			['unparsed math', [token('text', '$x$')], false],
			['text around the math', [token('math_inline'), token('text', ' y')], false],
			['Markdown between expressions', [token('math_inline'), token('image', ''), token('math_inline', 'y')], false],
			['multiple display expressions', [token('math_block'), token('math_block')], true],
			['inline math in display mode', [token('math_inline')], true],
			['math with different content', [token('math_inline', 'y')], false],
		] as const) {
			it(`does not render ${name}`, function () {
				const { md, rendered } = markdownIt([...children], inline);
				assert.strictEqual(renderTexWithMarkdownIt(md, 'x', displayMode), undefined);
				assert.deepStrictEqual(rendered, []);
			});
		}
	});

	describe('with the Markdown Math extension', function () {
		before(function () {
			if (!vscode.extensions.getExtension(MARKDOWN_MATH_EXTENSION_ID)) {
				this.skip();
			}
		});

		it('typesets inline and display math with KaTeX', async function () {
			const result = await processMath(`<p dir="auto">${INLINE_MATH}</p>\n<p dir="auto">${DISPLAY_MATH}</p>`);
			assert.match(result, /^<p dir="auto"><span class="katex">[\s\S]*<\/span><\/p>\n<p dir="auto"><span class="katex-display">[\s\S]*<\/span><\/p>$/);
			assert.doesNotMatch(result, /<math-renderer|katex-block/);
		});

		it('typesets escaped dollar signs', async function () {
			const result = await processMath('<math-renderer class="js-inline-math">$x = \\$$</math-renderer>');
			assert.match(result, /^<span class="katex">[\s\S]*\$[\s\S]*<\/span>$/);
		});

		for (const html of [
			'<p dir="auto"><math-renderer class="js-inline-math">$\\notacommand$</math-renderer></p>',
			'<p dir="auto"><math-renderer class="js-inline-math">$x$ ![](https://example.com/a.png) [a](https://example.com) $\\relax\\foo$</math-renderer></p>',
			'<p dir="auto"><math-renderer class="js-display-math">$$x$$ ![](https://example.com/a.png) $$y$$</math-renderer></p>',
		]) {
			it(`keeps math that cannot be rendered as a single expression: ${html}`, async function () {
				assert.strictEqual(await processMath(html), html);
			});
		}

		it('provides the KaTeX styles', function () {
			assert.ok(getMathStyleUris().some(uri => uri.path.endsWith('katex.min.css')));
		});
	});

	it('does not change HTML without math', async function () {
		const html = '<p dir="auto">Costs $5 and $10</p>';
		assert.strictEqual(await processMath(html), html);
	});
});
