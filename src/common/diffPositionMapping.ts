/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DiffChangeType, DiffHunk, DiffLine, parseDiffHunk } from './diffHunk';

/**
 * Line position in a git diff is 1 based, except for the case when the original or changed file have
 * no content, in which case it is 0. Normalize the position to be zero based.
 * @param line The line in a file from the diff header
 */
export function getZeroBased(line: number): number {
	if (line === undefined || line === 0) {
		return 0;
	}

	return line - 1;
}

export function getDiffLineByPosition(diffHunks: DiffHunk[], diffLineNumber: number): DiffLine | undefined {
	for (let i = 0; i < diffHunks.length; i++) {
		const diffHunk = diffHunks[i];
		for (let j = 0; j < diffHunk.diffLines.length; j++) {
			if (diffHunk.diffLines[j].positionInHunk === diffLineNumber) {
				return diffHunk.diffLines[j];
			}
		}
	}

	return undefined;
}

export function mapOldPositionToNew(patch: string, line: number): number {
	const diffReader = parseDiffHunk(patch);
	let diffIter = diffReader.next();

	let delta = 0;
	while (!diffIter.done) {
		const diffHunk: DiffHunk = diffIter.value;

		if (diffHunk.oldLineNumber > line) {
			// No-op
		} else if (diffHunk.oldLineNumber + diffHunk.oldLength - 1 < line) {
			delta += diffHunk.newLength - diffHunk.oldLength;
		} else {
			// Part of the hunk is before line, part is after.
			for (const diffLine of diffHunk.diffLines) {
				if (diffLine.oldLineNumber > line) {
					return line + delta;
				}
				if (diffLine.type === DiffChangeType.Add) {
					delta++;
				} else if (diffLine.type === DiffChangeType.Delete) {
					delta--;
				}
			}
			return line + delta;
		}

		diffIter = diffReader.next();
	}

	return line + delta;
}

export function mapNewPositionToOld(patch: string, line: number): number {
	const diffReader = parseDiffHunk(patch);
	let diffIter = diffReader.next();

	let delta = 0;
	while (!diffIter.done) {
		const diffHunk: DiffHunk = diffIter.value;

		if (diffHunk.newLineNumber > line) {
			// No-op
		} else if (diffHunk.newLineNumber + diffHunk.newLength - 1 < line) {
			delta += diffHunk.oldLength - diffHunk.newLength;
		} else {
			// Part of the hunk is before line, part is after.
			for (const diffLine of diffHunk.diffLines) {
				if (diffLine.newLineNumber > line) {
					return line + delta;
				}
				if (diffLine.type === DiffChangeType.Add) {
					delta--;
				} else if (diffLine.type === DiffChangeType.Delete) {
					delta++;
				}
			}
			return line + delta;
		}

		diffIter = diffReader.next();
	}

	return line + delta;
}