/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';

export function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(href: string | null, allowed: readonly string[]): string | undefined {
	if (!href) {
		return undefined;
	}
	try {
		const url = new URL(href);
		return allowed.includes(url.protocol) ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

const renderer = new marked.Renderer();
// Azure DevOps returns user-authored Markdown rather than sanitized HTML, so raw HTML is shown as text.
renderer.html = html => escapeHtml(html);
renderer.link = (href, title, text) => {
	const url = safeUrl(href, ['https:', 'http:', 'mailto:']);
	if (!url) {
		return text;
	}
	return `<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${text}</a>`;
};
renderer.image = (href, title, text) => {
	const url = safeUrl(href, ['https:']);
	if (!url) {
		return escapeHtml(text ?? '');
	}
	return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text ?? '')}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
};

export function renderAzureMarkdown(markdown: string | undefined): string {
	// Azure DevOps hides HTML comments (often bot metadata) rather than showing them as text.
	return marked.parse((markdown ?? '').replace(/<!--[\s\S]*?-->/g, ''), { renderer, gfm: true, breaks: false });
}
