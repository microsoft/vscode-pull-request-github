/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PullInfo } from './messages';

// Issue/PR reference patterns - copied from src/github/utils.ts
export const ISSUE_EXPRESSION = /(([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+))?(#|GH-)([1-9][0-9]*)($|\b)/;
export const ISSUE_OR_URL_EXPRESSION = /(https?:\/\/github\.com\/(([^\s]+)\/([^\s]+))\/([^\s]+\/)?(issues|pull)\/([0-9]+)(#issuecomment\-([0-9]+))?)|(([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+))?(#|GH-)([1-9][0-9]*)($|\b)/;

export type ParsedIssue = {
	owner: string | undefined;
	name: string | undefined;
	issueNumber: number;
	commentNumber?: number;
};

export function parseIssueExpressionOutput(output: RegExpMatchArray | null): ParsedIssue | undefined {
	if (!output) {
		return undefined;
	}
	const issue: ParsedIssue = { owner: undefined, name: undefined, issueNumber: 0 };
	if (output.length === 7) {
		issue.owner = output[2];
		issue.name = output[3];
		issue.issueNumber = parseInt(output[5]);
		return issue;
	} else if (output.length === 16) {
		issue.owner = output[3] || output[11];
		issue.name = output[4] || output[12];
		issue.issueNumber = parseInt(output[7] || output[14]);
		issue.commentNumber = output[9] !== undefined ? parseInt(output[9]) : undefined;
		return issue;
	} else {
		return undefined;
	}
}

export function getIssueNumberLabelFromParsed(parsed: ParsedIssue): string {
	if (parsed.owner && parsed.name) {
		return `${parsed.owner}/${parsed.name}#${parsed.issueNumber}`;
	}
	return `#${parsed.issueNumber}`;
}

/**
 * Converts issue/PR references in text to clickable links
 * @param text The text to process
 * @param pullInfo Repository context for creating links
 * @returns The text with issue references converted to markdown links
 */
export async function convertIssueReferencesToLinks(text: string, pullInfo: PullInfo | undefined): Promise<string> {
	if (!pullInfo) {
		return text;
	}

	// Use a simple approach to find and replace issue references
	return text.replace(ISSUE_OR_URL_EXPRESSION, (match) => {
		const parsed = parseIssueExpressionOutput(match.match(ISSUE_OR_URL_EXPRESSION));
		if (!parsed) {
			return match;
		}

		// If no owner/name specified, use the current repository context
		if (!parsed.owner || !parsed.name) {
			parsed.owner = pullInfo.owner;
			parsed.name = pullInfo.repo;
		}

		const issueNumberLabel = getIssueNumberLabelFromParsed(parsed);

		// Create GitHub URL for the issue/PR
		const githubUrl = `https://${pullInfo.host || 'github.com'}/${parsed.owner}/${parsed.name}/issues/${parsed.issueNumber}`;

		return `[${issueNumberLabel}](${githubUrl})`;
	});
}