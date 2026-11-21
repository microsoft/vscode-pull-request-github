/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as yaml from 'js-yaml';
import type { IssueTemplate, YamlIssueTemplate } from './util';

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

function asTemplateTextList(value: unknown): string[] | undefined {
	const list = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map(item => item.trim()) : [])
		.map(asTemplateText)
		.filter((item): item is string => !!item);
	return list.length > 0 ? list : undefined;
}

/**
 * Reads the metadata of an issue template.
 *
 * Kept free of `vscode` imports so that it can be unit tested.
 */
export function getIssueTemplateData(template: string): IssueTemplate {
	// YAML issue forms (`.yml`) are a single YAML document.
	try {
		const parsed: unknown = yaml.load(template);
		if (parsed && typeof parsed === 'object' && (parsed as YamlIssueTemplate).name && (parsed as YamlIssueTemplate).body) {
			return parseYamlIssueForm(parsed as YamlIssueTemplate);
		}
	} catch {
		// Not a YAML issue form, continue with the Markdown frontmatter.
	}

	const frontmatter = FRONTMATTER.exec(template);
	if (!frontmatter) {
		return { name: undefined, about: undefined, title: undefined, labels: undefined, assignees: undefined, body: undefined };
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
		labels: asTemplateTextList(meta.labels),
		assignees: asTemplateTextList(meta.assignees),
		// The body is everything after the closing frontmatter delimiter.
		body: template.substring(frontmatter[0].length),
	};
}
function parseYamlIssueForm(parsed: YamlIssueTemplate): IssueTemplate {
		const name = parsed.name;
		const about = parsed.description || parsed.about;
		const title = parsed.title;

		// Extract labels and assignees from YAML
		const labels = parsed.labels && Array.isArray(parsed.labels) ? parsed.labels : undefined;
		const assignees = parsed.assignees && Array.isArray(parsed.assignees) ? parsed.assignees : undefined;

		// Convert YAML body fields to markdown
		let body = '';
		if (parsed.body && Array.isArray(parsed.body)) {
			for (const field of parsed.body) {
				if (field.type === 'markdown' && field.attributes?.value) {
					body += field.attributes.value + '\n\n';
				} else if (field.type === 'textarea' && field.attributes?.label) {
					body += `## ${field.attributes.label}\n\n`;
					if (field.attributes.description) {
						body += `${field.attributes.description}\n\n`;
					}
					if (field.attributes.placeholder) {
						body += `${field.attributes.placeholder}\n\n`;
					} else if (field.attributes.value) {
						body += `${field.attributes.value}\n\n`;
					}
				} else if (field.type === 'input' && field.attributes?.label) {
					body += `## ${field.attributes.label}\n\n`;
					if (field.attributes.description) {
						body += `${field.attributes.description}\n\n`;
					}
					if (field.attributes.placeholder) {
						body += `${field.attributes.placeholder}\n\n`;
					}
				} else if (field.type === 'dropdown' && field.attributes?.label) {
					body += `## ${field.attributes.label}\n\n`;
					if (field.attributes.description) {
						body += `${field.attributes.description}\n\n`;
					}
					if (field.attributes.options && Array.isArray(field.attributes.options)) {
						body += field.attributes.options.map((opt: string | { label?: string }) => typeof opt === 'string' ? `- ${opt}` : `- ${opt.label || ''}`).join('\n') + '\n\n';
					}
				} else if (field.type === 'checkboxes' && field.attributes?.label) {
					body += `## ${field.attributes.label}\n\n`;
					if (field.attributes.description) {
						body += `${field.attributes.description}\n\n`;
					}
					if (field.attributes.options && Array.isArray(field.attributes.options)) {
						body += field.attributes.options.map((opt: { label?: string } | string) => `- [ ] ${typeof opt === 'string' ? opt : opt.label || ''}`).join('\n') + '\n\n';
					}
				}
			}
		}

		return { title, name, about, labels, assignees, body: body.trim() || undefined };
	}
