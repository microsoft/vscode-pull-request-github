/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import Logger from '../common/logger';

/**
 * The built-in extension that adds KaTeX math support to VS Code's Markdown preview.
 */
export const MARKDOWN_MATH_EXTENSION_ID = 'vscode.markdown-math';
const LOG_ID = 'MarkdownMath';

interface MarkdownItPlugin {
	extendMarkdownIt(md: MarkdownIt): MarkdownIt;
}

/**
 * Renders a TeX expression to HTML. Returns undefined if the expression can't be rendered.
 */
export type TexRenderer = (tex: string, displayMode: boolean) => string | undefined;

/**
 * GitHub renders `$...$`, `$$...$$` and ```` ```math ```` blocks as `<math-renderer>` elements that contain the escaped
 * TeX source with its delimiters, and typesets them in the browser.
 */
const MATH_ELEMENT_REGEX = /<math-renderer\b(?<attributes>[^>]*)>(?<content>[^<]*)<\/math-renderer>/g;
const DISPLAY_MATH_CLASS_REGEX = /\bclass="[^"]*\bjs-display-math\b/;
const HTML_ENTITY_REGEX = /&(?:#(?<decimal>\d+)|#[xX](?<hex>[\da-fA-F]+)|(?<name>[a-zA-Z]+));/g;
const NAMED_HTML_ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', '\'']]);

const MATH_INLINE_TOKEN = 'math_inline';
const MATH_BLOCK_TOKEN = 'math_block';
const KATEX_INLINE_ROOT = '<span class="katex">';
const KATEX_DISPLAY_ROOT = '<span class="katex-display">';
const KATEX_BLOCK_REGEX = /^<p class="katex-block">(?<display>[\s\S]*)<\/p>\s*$/;

function decodeHtmlEntities(text: string): string {
	return text.replace(HTML_ENTITY_REGEX, (entity: string, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
		if (name !== undefined) {
			return NAMED_HTML_ENTITIES.get(name) ?? entity;
		}
		const codePoint = decimal !== undefined ? parseInt(decimal, 10) : parseInt(hex ?? '', 16);
		return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : entity;
	});
}

/**
 * Replaces the math elements in GitHub-rendered HTML with the output of `renderTex`.
 * Elements that can't be rendered are kept, so they still show the TeX source.
 */
export function renderMathElements(html: string, renderTex: TexRenderer): string {
	return html.replace(MATH_ELEMENT_REGEX, (element: string, attributes: string, content: string) => {
		const displayMode = DISPLAY_MATH_CLASS_REGEX.test(attributes);
		const delimiter = displayMode ? '$$' : '$';
		const source = decodeHtmlEntities(content).trim();
		if (source.length <= 2 * delimiter.length || !source.startsWith(delimiter) || !source.endsWith(delimiter)) {
			return element;
		}
		return renderTex(source.slice(delimiter.length, -delimiter.length), displayMode) ?? element;
	});
}

/**
 * Renders TeX with a markdown-it instance that has been extended by the Markdown Math extension.
 * Returns undefined unless the TeX is parsed as exactly one math expression that KaTeX can render.
 */
export function renderTexWithMarkdownIt(md: Pick<MarkdownIt, 'parseInline' | 'renderer' | 'options'>, tex: string, displayMode: boolean): string | undefined {
	const delimiter = displayMode ? '$$' : '$';
	const env = {};
	// Only the math token is rendered, so that the TeX can't add Markdown, such as links and images, around it.
	const tokens = md.parseInline(`${delimiter}${tex}${delimiter}`, env)[0]?.children;
	if (tokens?.length !== 1 || tokens[0].type !== (displayMode ? MATH_BLOCK_TOKEN : MATH_INLINE_TOKEN) || tokens[0].content !== tex) {
		return undefined;
	}
	const html = md.renderer.renderInline(tokens, md.options, env);
	if (displayMode) {
		// Display math is wrapped in a paragraph, which can't be nested in the paragraph that GitHub puts it in.
		const display = KATEX_BLOCK_REGEX.exec(html)?.groups?.display;
		return display?.startsWith(KATEX_DISPLAY_ROOT) ? display : undefined;
	}
	return html.startsWith(KATEX_INLINE_ROOT) ? html : undefined;
}

let markdownIt: { settings: string; md: Promise<MarkdownIt | undefined> } | undefined;

async function createMarkdownIt(extension: vscode.Extension<MarkdownItPlugin>): Promise<MarkdownIt | undefined> {
	try {
		const plugin = extension.isActive ? extension.exports : await extension.activate();
		return plugin?.extendMarkdownIt(new MarkdownIt());
	} catch (error) {
		Logger.error(`Failed to load the Markdown Math extension: ${error}`, LOG_ID);
		return undefined;
	}
}

function getMarkdownIt(): Promise<MarkdownIt | undefined> {
	const extension = vscode.extensions.getExtension<MarkdownItPlugin>(MARKDOWN_MATH_EXTENSION_ID);
	if (!extension) {
		return Promise.resolve(undefined);
	}
	// The Markdown Math extension reads its settings when it extends markdown-it.
	const configuration = vscode.workspace.getConfiguration('markdown.math');
	const settings = JSON.stringify([configuration.get('enabled'), configuration.get('macros')]);
	if (markdownIt?.settings !== settings) {
		markdownIt = { settings, md: createMarkdownIt(extension) };
	}
	return markdownIt.md;
}

/**
 * Typesets the math in GitHub-rendered HTML with the KaTeX support of the built-in Markdown Math extension.
 */
export async function processMath(bodyHTML: string): Promise<string> {
	if (!bodyHTML.includes('<math-renderer')) {
		return bodyHTML;
	}
	try {
		const md = await getMarkdownIt();
		return md ? renderMathElements(bodyHTML, (tex, displayMode) => renderTexWithMarkdownIt(md, tex, displayMode)) : bodyHTML;
	} catch (error) {
		Logger.error(`Failed to render math in HTML: ${error}`, LOG_ID);
		return bodyHTML;
	}
}

/**
 * The roots that a webview needs to be able to load the math styles from.
 */
export function getMathResourceRoots(): vscode.Uri[] {
	const extension = vscode.extensions.getExtension(MARKDOWN_MATH_EXTENSION_ID);
	return extension ? [extension.extensionUri] : [];
}

/**
 * The styles that the Markdown Math extension contributes to the Markdown preview, which include the KaTeX styles.
 */
export function getMathStyleUris(): vscode.Uri[] {
	const extension = vscode.extensions.getExtension(MARKDOWN_MATH_EXTENSION_ID);
	const styles: unknown = extension?.packageJSON?.contributes?.['markdown.previewStyles'];
	if (!extension || !Array.isArray(styles)) {
		return [];
	}
	return styles.filter((style): style is string => typeof style === 'string').map(style => vscode.Uri.joinPath(extension.extensionUri, style));
}
