/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as yaml from 'js-yaml';
import type { IssueTemplate } from './util';

// A Markdown issue template is a YAML frontmatter block followed by the issue body.
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function asTemplateText(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return undefined;
}

/**
 * Reads the metadata of an issue template.
 *
 * Kept free of `vscode` imports so that it can be unit tested.
 */
export function getIssueTemplateData(template: string): IssueTemplate {
	const frontmatter = FRONTMATTER.exec(template);
	if (!frontmatter) {
		return { name: undefined, about: undefined, title: undefined, body: undefined };
	}

	let meta: Record<string, unknown> = {};
	try {
		// Only the frontmatter is YAML: the frontmatter and the Markdown body together are not a single document.
		const parsed: unknown = yaml.load(frontmatter[1]);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			meta = parsed as Record<string, unknown>;
		}
	} catch {
		// Ignore frontmatter that is not valid YAML, so that a broken template is still listed.
	}

	return {
		name: asTemplateText(meta.name),
		about: asTemplateText(meta.about),
		title: asTemplateText(meta.title),
		// The body is everything after the closing frontmatter delimiter.
		body: template.substring(frontmatter[0].length),
	};
}
