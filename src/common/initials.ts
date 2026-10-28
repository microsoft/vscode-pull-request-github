/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shared by the extension host and the webviews, so it must not depend on `vscode`.

/** Initials as Azure DevOps shows them: the first letters of the first and last words. */
export function initials(name: string | undefined): string {
	const words = (name ?? '').replace(/@.*$/, '').replace(/\([^)]*\)/g, ' ').trim().split(/[\s._@-]+/).filter(word => /[\p{L}\p{N}]/u.test(word));
	if (!words.length) {
		return '?';
	}
	const first = Array.from(words[0])[0];
	const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
	return (first + last).toUpperCase();
}

const palette = ['#0078d4', '#8764b8', '#038387', '#ca5010', '#c239b3', '#498205', '#da3b01', '#00838f', '#4f6bed', '#b146c2', '#986f0b', '#e3008c'];

/** A stable background colour for a name, so a person keeps the same colour everywhere. */
export function initialsColor(name: string | undefined): string {
	let hash = 0;
	for (const char of name ?? '') {
		hash = (hash * 31 + char.charCodeAt(0)) | 0;
	}
	return palette[Math.abs(hash) % palette.length];
}

function escapeXml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A round initials avatar as SVG markup. */
export function initialsSvg(name: string | undefined, size: number): string {
	const text = initials(name);
	const fontSize = Math.round(size * (text.length > 1 ? 0.42 : 0.5));
	return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">`
		+ `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${initialsColor(name)}"/>`
		+ `<text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="#ffffff" font-family="Segoe UI, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${fontSize}" font-weight="600">${escapeXml(text)}</text>`
		+ `</svg>`;
}
