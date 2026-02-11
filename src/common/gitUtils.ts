/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { GitApiImpl } from '../api/api1';

/**
 * Unwraps lines that were wrapped for conventional commit message formatting (typically at 72 characters).
 * Similar to GitHub's behavior when converting commit messages to PR descriptions.
 *
 * Rules:
 * - Preserves blank lines as paragraph breaks
 * - Preserves fenced code blocks (```)
 * - Preserves list items (-, *, +, numbered)
 * - Preserves blockquotes (>)
 * - Preserves indented code blocks (4+ spaces at start, when not in a list context)
 * - Joins consecutive plain text lines that appear to be wrapped mid-sentence
 */
export function unwrapCommitMessageBody(body: string): string {
	if (!body) {
		return body;
	}

	// Pattern to detect list item markers at the start of a line and capture the marker
	const LIST_ITEM_PATTERN = /^(?<leadingWhitespace>[ \t]*)(?<marker>[*+\-]|\d+\.)(?<markerTrailingWhitespace>[ \t]+)/;
	// Pattern to detect blockquote markers
	const BLOCKQUOTE_PATTERN = /^[ \t]*>/;
	// Pattern to detect fenced code block markers
	const FENCE_PATTERN = /^[ \t]*```/;

	const getLeadingWhitespaceLength = (text: string): number => text.match(/^[ \t]*/)?.[0].length ?? 0;
	const hasHardLineBreak = (text: string): boolean => / {2}$/.test(text);
	const appendWithSpace = (base: string, addition: string): string => {
		if (!addition) {
			return base;
		}
		return base.length > 0 && !/\s$/.test(base) ? `${base} ${addition}` : `${base}${addition}`;
	};

	// Get the content indent for a list item (position where actual content starts)
	const getListItemContentIndent = (line: string): number => {
		const match = line.match(LIST_ITEM_PATTERN);
		if (!match?.groups) {
			return 0;
		}
		// Content indent = leading whitespace + marker + space after marker
		return match.groups.leadingWhitespace.length + match.groups.marker.length + match.groups.markerTrailingWhitespace.length;
	};

	const lines = body.split('\n');
	const result: string[] = [];
	let i = 0;
	let inFencedBlock = false;
	// Stack stores { markerIndent, contentIndent } for each nesting level
	const listStack: { markerIndent: number; contentIndent: number }[] = [];

	// Find the active list context for a given line indent
	// Returns the content indent if the line is within an active list context
	const getActiveListContentIndent = (lineIndent: number): number | undefined => {
		for (let idx = listStack.length - 1; idx >= 0; idx--) {
			const { markerIndent, contentIndent } = listStack[idx];
			// A line is part of a list item if it has at least 1 space indent
			// (but less than contentIndent + 4 which would be a code block)
			if (lineIndent >= 1 && lineIndent >= markerIndent) {
				listStack.length = idx + 1;
				return contentIndent;
			}
			listStack.pop();
		}
		return undefined;
	};

	const shouldJoinListContinuation = (lineIndex: number, contentIndent: number, baseLine: string): boolean => {
		const currentLine = lines[lineIndex];
		if (!currentLine) {
			return false;
		}

		const trimmed = currentLine.trim();
		if (!trimmed) {
			return false;
		}

		if (hasHardLineBreak(baseLine) || hasHardLineBreak(currentLine)) {
			return false;
		}

		if (LIST_ITEM_PATTERN.test(currentLine)) {
			return false;
		}

		if (BLOCKQUOTE_PATTERN.test(currentLine) || FENCE_PATTERN.test(currentLine)) {
			return false;
		}

		const currentIndent = getLeadingWhitespaceLength(currentLine);
		// Need at least 1 space to be a continuation
		if (currentIndent < 1) {
			return false;
		}

		// 4+ spaces beyond content indent is an indented code block
		if (currentIndent >= contentIndent + 4) {
			return false;
		}

		return true;
	};

	while (i < lines.length) {
		const line = lines[i];

		// Preserve blank lines but don't clear list context
		// (multi-paragraph lists are allowed in GitHub markdown)
		if (line.trim() === '') {
			result.push(line);
			i++;
			continue;
		}

		// Check for fenced code block markers
		if (FENCE_PATTERN.test(line)) {
			inFencedBlock = !inFencedBlock;
			result.push(line);
			i++;
			continue;
		}

		// Preserve everything inside fenced code blocks
		if (inFencedBlock) {
			result.push(line);
			i++;
			continue;
		}

		const lineIndent = getLeadingWhitespaceLength(line);
		const listItemMatch = line.match(LIST_ITEM_PATTERN);

		if (listItemMatch?.groups) {
			const markerIndent = listItemMatch.groups.leadingWhitespace.length;
			const contentIndent = getListItemContentIndent(line);

			// Pop list levels that are at or beyond this indent
			while (listStack.length && markerIndent <= listStack[listStack.length - 1].markerIndent) {
				listStack.pop();
			}

			listStack.push({ markerIndent, contentIndent });
			result.push(line);
			i++;
			continue;
		}

		// Handle non-indented lines that should be joined to a previous list item
		// This happens when commit messages are wrapped at 72 characters
		// Check this BEFORE calling getActiveListContentIndent which would clear the stack
		if (listStack.length > 0 && lineIndent === 0 && !LIST_ITEM_PATTERN.test(line)) {
			const isBlockquote = BLOCKQUOTE_PATTERN.test(line);
			if (!isBlockquote) {
				const baseIndex = result.length - 1;
				const baseLine = baseIndex >= 0 ? result[baseIndex] : '';
				const previousLineIsBlank = baseLine.trim() === '';

				if (!previousLineIsBlank && baseIndex >= 0) {
					// Join this line and any following non-list-item lines with the previous list item
					let joinedLine = baseLine;
					let currentIndex = i;

					while (currentIndex < lines.length) {
						const currentLine = lines[currentIndex];
						const trimmed = currentLine.trim();

						// Stop at blank lines
						if (!trimmed) {
							break;
						}

						// Stop at list items
						if (LIST_ITEM_PATTERN.test(currentLine)) {
							break;
						}

						// Stop at blockquotes or fences
						if (BLOCKQUOTE_PATTERN.test(currentLine) || FENCE_PATTERN.test(currentLine)) {
							break;
						}

						// Stop at indented code blocks
						const currentLineIndent = getLeadingWhitespaceLength(currentLine);
						if (currentLineIndent >= 4) {
							break;
						}

						// Stop if previous line has hard line break
						if (hasHardLineBreak(joinedLine)) {
							break;
						}

						joinedLine = appendWithSpace(joinedLine, trimmed);
						currentIndex++;
					}

					if (currentIndex > i) {
						result[baseIndex] = joinedLine;
						i = currentIndex;
						continue;
					}
				}
			}
		}

		const activeContentIndent = getActiveListContentIndent(lineIndent);
		const codeIndentThreshold = activeContentIndent !== undefined ? activeContentIndent + 4 : 4;
		const isBlockquote = BLOCKQUOTE_PATTERN.test(line);
		const isIndentedCode = lineIndent >= codeIndentThreshold;

		if (isBlockquote || isIndentedCode) {
			result.push(line);
			i++;
			continue;
		}

		// Handle list item continuations
		if (activeContentIndent !== undefined && lineIndent >= 1) {
			const baseIndex = result.length - 1;
			// Only try to join with previous line if it's not blank
			// Multi-paragraph lists have blank lines that should be preserved
			const baseLine = baseIndex >= 0 ? result[baseIndex] : '';
			const previousLineIsBlank = baseLine.trim() === '';

			if (!previousLineIsBlank && baseIndex >= 0) {
				let joinedLine = baseLine;
				let appended = false;
				let currentIndex = i;

				while (
					currentIndex < lines.length &&
					shouldJoinListContinuation(currentIndex, activeContentIndent, joinedLine)
				) {
					const continuationText = lines[currentIndex].trim();
					if (continuationText) {
						joinedLine = appendWithSpace(joinedLine, continuationText);
						appended = true;
					}
					currentIndex++;
				}

				if (appended) {
					result[baseIndex] = joinedLine;
					i = currentIndex;
					continue;
				}
			}

			// For multi-paragraph continuations or standalone indented lines,
			// preserve indentation but unwrap consecutive continuation lines
			let joinedLine = line;
			i++;

			while (i < lines.length) {
				const nextLine = lines[i];

				if (nextLine.trim() === '') {
					break;
				}

				if (FENCE_PATTERN.test(nextLine)) {
					break;
				}

				if (LIST_ITEM_PATTERN.test(nextLine)) {
					break;
				}

				if (BLOCKQUOTE_PATTERN.test(nextLine)) {
					break;
				}

				const nextIndent = getLeadingWhitespaceLength(nextLine);
				// Check for code block
				if (nextIndent >= activeContentIndent + 4) {
					break;
				}

				// Must have at least 1 space to be a continuation
				if (nextIndent < 1) {
					break;
				}

				// Check for hard line break
				if (hasHardLineBreak(joinedLine)) {
					break;
				}

				// Join this line - preserve the original indentation for the first line
				joinedLine = appendWithSpace(joinedLine, nextLine.trim());
				i++;
			}

			result.push(joinedLine);
			continue;
		}

		// Start accumulating lines that should be joined (plain text)
		let joinedLine = line;
		i++;

		// Keep joining lines until we hit a blank line or a line that shouldn't be joined
		while (i < lines.length) {
			const nextLine = lines[i];

			// Stop at blank lines
			if (nextLine.trim() === '') {
				break;
			}

			// Stop at fenced code blocks
			if (FENCE_PATTERN.test(nextLine)) {
				break;
			}

			// Stop at list items
			if (LIST_ITEM_PATTERN.test(nextLine)) {
				break;
			}

			// Stop at blockquotes
			if (BLOCKQUOTE_PATTERN.test(nextLine)) {
				break;
			}

			// Check if next line is indented code (4+ spaces, when not in a list context)
			const nextLeadingSpaces = getLeadingWhitespaceLength(nextLine);
			const nextIsIndentedCode = nextLeadingSpaces >= 4;

			if (nextIsIndentedCode) {
				break;
			}

			// Join this line with a space
			joinedLine = appendWithSpace(joinedLine, nextLine.trim());
			i++;
		}

		result.push(joinedLine);
	}

	return result.join('\n');
}

/**
 * Determines if a repository is a submodule by checking if its path
 * appears in any other repository's submodules list.
 */
export function isSubmodule(repo: Repository, git: GitApiImpl): boolean {
	const repoPath = repo.rootUri.fsPath;

	// Check all other repositories to see if this repo is listed as a submodule
	for (const otherRepo of git.repositories) {
		if (otherRepo.rootUri.toString() === repo.rootUri.toString()) {
			continue; // Skip self
		}

		// Check if this repo's path appears in the other repo's submodules
		for (const submodule of otherRepo.state.submodules) {
			// The submodule path is relative to the parent repo, so we need to resolve it
			const submodulePath = vscode.Uri.joinPath(otherRepo.rootUri, submodule.path).fsPath;
			if (submodulePath === repoPath) {
				return true;
			}
		}
	}

	return false;
}