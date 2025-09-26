/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { MAX_PROBLEM_STATEMENT_LENGTH } from './copilotApi';

/**
 * Truncation utility to ensure the problem statement sent to Copilot API is under the maximum length.
 * Truncation is not ideal. The caller providing the prompt/context should be summarizing so this is a no-op whenever possible.
 *
 * @param prompt The final message submitted by the user
 * @param context Any additional context collected by the caller (chat history, open files, etc...)
 * @returns A complete 'problem statement' string that is under the maximum length, and a flag indicating if truncation occurred
 */
export function truncatePrompt(prompt: string, context?: string): { problemStatement: string; isTruncated: boolean } {
	// Prioritize the userPrompt
	// Take the last n characters that fit within the limit
	if (prompt.length >= MAX_PROBLEM_STATEMENT_LENGTH) {
		Logger.warn(`Truncation: Prompt length ${prompt.length} exceeds max of ${MAX_PROBLEM_STATEMENT_LENGTH}`);
		prompt = prompt.slice(-MAX_PROBLEM_STATEMENT_LENGTH);
		return { problemStatement: prompt, isTruncated: true };
	}

	if (context && (prompt.length + context.length >= MAX_PROBLEM_STATEMENT_LENGTH)) {
		const availableLength = MAX_PROBLEM_STATEMENT_LENGTH - prompt.length - 2 /* new lines */;
		Logger.warn(`Truncation: Combined prompt and context length ${prompt.length + context.length} exceeds max of ${MAX_PROBLEM_STATEMENT_LENGTH}`);
		context = context.slice(-availableLength);
		return {
			problemStatement: prompt + (context ? `\n\n${context}` : ''),
			isTruncated: true
		};
	}

	// No truncation occurred
	return {
		problemStatement: prompt + (context ? `\n\n${context}` : ''),
		isTruncated: false
	};
}

export function extractTitle(prompt: string, context: string | undefined): string | undefined {
	if (!context) {
		return;
	}
	const titleMatch = context.match(/TITLE: \s*(.*)/i);
	if (titleMatch && titleMatch[1]) {
		return titleMatch[1].trim();
	}
	if (prompt.length <= 20) {
		return prompt;
	}
	return prompt.substring(0, 20) + '...';
}

export function formatBodyPlaceholder(title: string | undefined): string {
	return vscode.l10n.t('Coding agent has begun work on **{0}** and will update this pull request as work progresses.', title || vscode.l10n.t('your request'));
}