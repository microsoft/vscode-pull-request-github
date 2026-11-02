/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
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

		function renderer(output: string) {
			const sources: string[] = [];
			return {
				sources,
				md: {
					renderInline: (src: string) => {
						sources.push(src);
						return output;
					}
				}
			};
		}

		it('renders inline math as a single KaTeX expression', function () {
			const { md, sources } = renderer(inline);
			assert.strictEqual(renderTexWithMarkdownIt(md, 'x', false), inline);
			assert.deepStrictEqual(sources, ['$x$']);
		});

		it('renders display math without the paragraph around it', function () {
			const { md, sources } = renderer(`<p class="katex-block">${display}</p>\n`);
			assert.strictEqual(renderTexWithMarkdownIt(md, 'x', true), display);
			assert.deepStrictEqual(sources, ['$$x$$']);
		});

		for (const [name, output, displayMode] of [
			['errors', '<span class="katex-error" title="\\foo">\\foo</span>', false],
			['display errors', '<p class="katex-block katex-error" title="\\foo">\\foo</p>\n', true],
			['unparsed math', '$x$', false],
			['text around the math', `${inline}y`, false],
			['multiple expressions', `${inline} y ${inline}`, false],
			['multiple display expressions', `<p class="katex-block">${display}</p>\n<p class="katex-block">${display}</p>\n`, true],
		] as const) {
			it(`does not use ${name}`, function () {
				assert.strictEqual(renderTexWithMarkdownIt(renderer(output).md, 'x', displayMode), undefined);
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

		it('keeps math that KaTeX cannot render', async function () {
			const html = '<p dir="auto"><math-renderer class="js-inline-math">$\\notacommand$</math-renderer></p>';
			assert.strictEqual(await processMath(html), html);
		});

		it('provides the KaTeX styles', function () {
			assert.ok(getMathStyleUris().some(uri => uri.path.endsWith('katex.min.css')));
		});
	});

	it('does not change HTML without math', async function () {
		const html = '<p dir="auto">Costs $5 and $10</p>';
		assert.strictEqual(await processMath(html), html);
	});
});
