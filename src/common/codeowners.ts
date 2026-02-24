/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Logger from './logger';

const CODEOWNERS_ID = 'CodeOwners';

export interface CodeownersEntry {
	readonly pattern: string;
	readonly owners: readonly string[];
}

/**
 * Parses CODEOWNERS file content into a list of entries.
 * Later entries take precedence over earlier ones (per GitHub spec).
 */
export function parseCodeownersFile(content: string): CodeownersEntry[] {
	const entries: CodeownersEntry[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const parts = line.split(/\s+/);
		if (parts.length < 2) {
			continue;
		}
		const [pattern, ...owners] = parts;
		entries.push({ pattern, owners });
	}
	return entries;
}

/**
 * Given a parsed CODEOWNERS file and a file path, returns the set of owners
 * for that path. Returns an empty array if no rule matches.
 *
 * Matching follows GitHub semantics: the last matching pattern wins.
 */
export function getOwnersForPath(entries: readonly CodeownersEntry[], filePath: string): readonly string[] {
	let matched: readonly string[] = [];
	for (const entry of entries) {
		if (matchesCodeownersPattern(entry.pattern, filePath)) {
			matched = entry.owners;
		}
	}
	return matched;
}

/**
 * Checks whether the given user login or any of the given team slugs
 * (in `@org/team` format) appear among the owners list.
 */
export function isOwnedByUser(
	owners: readonly string[],
	userLogin: string,
	teamSlugs: readonly string[],
): boolean {
	const normalizedLogin = `@${userLogin.toLowerCase()}`;
	const normalizedTeams = new Set(teamSlugs.map(t => t.toLowerCase()));

	return owners.some(owner => {
		const normalized = owner.toLowerCase();
		return normalized === normalizedLogin || normalizedTeams.has(normalized);
	});
}

function matchesCodeownersPattern(pattern: string, filePath: string): boolean {
	try {
		const regex = codeownersPatternToRegex(pattern);
		return regex.test(filePath);
	} catch (e) {
		Logger.error(`Error matching CODEOWNERS pattern "${pattern}": ${e}`, CODEOWNERS_ID);
		return false;
	}
}

/**
 * Converts a CODEOWNERS pattern to a RegExp.
 *
 * GitHub CODEOWNERS rules:
 * - A leading `/` anchors to the repo root; otherwise the pattern matches anywhere.
 * - A trailing `/` means "directory and everything inside".
 * - `*` matches within a single path segment; `**` matches across segments.
 * - Bare filenames (no `/`) match anywhere in the tree.
 * - `?` matches a single non-slash character.
 */
function codeownersPatternToRegex(pattern: string): RegExp {
	let p = pattern;
	const anchored = p.startsWith('/');
	if (anchored) {
		p = p.slice(1);
	}

	if (p.endsWith('/')) {
		p = p + '**';
	}

	const hasSlash = p.includes('/');

	let regexStr = '';
	let i = 0;
	while (i < p.length) {
		if (p[i] === '*') {
			if (p[i + 1] === '*') {
				if (p[i + 2] === '/') {
					// `**/` matches zero or more directories
					regexStr += '(?:.+/)?';
					i += 3;
				} else {
					// `**` at end or before non-slash: match everything
					regexStr += '.*';
					i += 2;
				}
			} else {
				// `*` matches anything except `/`
				regexStr += '[^/]*';
				i++;
			}
		} else if (p[i] === '?') {
			regexStr += '[^/]';
			i++;
		} else if (p[i] === '.') {
			regexStr += '\\.';
			i++;
		} else if (p[i] === '[') {
			const closeBracket = p.indexOf(']', i + 1);
			if (closeBracket !== -1) {
				regexStr += p.slice(i, closeBracket + 1);
				i = closeBracket + 1;
			} else {
				regexStr += '\\[';
				i++;
			}
		} else {
			regexStr += p[i];
			i++;
		}
	}

	// If the pattern has no slash (bare filename) and is not anchored,
	// it can match anywhere in the tree.
	const prefix = (!anchored && !hasSlash) ? '(?:^|.+/)' : '^';

	// GitHub treats patterns without glob characters as matching both the
	// exact path and everything inside it (implicit directory match).
	const hasGlob = /[*?\[]/.test(p);
	const suffix = hasGlob ? '$' : '(?:/.*)?$';

	return new RegExp(prefix + regexStr + suffix);
}

/** Standard CODEOWNERS file paths in order of precedence (first found wins). */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;
