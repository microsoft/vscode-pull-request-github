/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DiffLine, DiffHunk, parseDiffHunk, DiffChangeType } from './diffHunk';
import { IComment } from './comment';

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

/**
 * Returns the absolute position of a comment in a file. If the comment is outdated, returns -1.
 *
 * For the base file, only comments that are on deleted lines should be displayed. For the modified file,
 * all other comments should be shown. Check the line type to avoid duplicating comments across these files.
 * @param comment The comment
 * @param fileDiffHunks The diff hunks of the file
 * @param isBase Whether the file, if a diff, is the base or modified
 */
export function getAbsolutePosition(comment: IComment, fileDiffHunks: DiffHunk[], isBase: boolean): number {
	let commentAbsolutePosition = -1;
	// Ignore outdated comments
	if (comment.position !== null) {
		const diffLine = getDiffLineByPosition(fileDiffHunks, comment.position!);

		if (diffLine) {
			if (isBase && diffLine.type === DiffChangeType.Delete) {
				commentAbsolutePosition = diffLine.oldLineNumber;
			}

			if (!isBase && diffLine.type !== DiffChangeType.Delete) {
				commentAbsolutePosition = diffLine.newLineNumber;
			}
		}
	}

	return commentAbsolutePosition;
}

export function getLastDiffLine(prPatch: string): DiffLine | undefined {
	let lastDiffLine = undefined;
	const prDiffReader = parseDiffHunk(prPatch);
	let prDiffIter = prDiffReader.next();

	while (!prDiffIter.done) {
		const diffHunk = prDiffIter.value;
		lastDiffLine = diffHunk.diffLines[diffHunk.diffLines.length - 1];

		prDiffIter = prDiffReader.next();
	}

	return lastDiffLine;
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

export function mapHeadLineToDiffHunkPosition(diffHunks: DiffHunk[], localDiff: string, line: number, isBase: boolean = false): number {
	const localDiffReader = parseDiffHunk(localDiff);
	let localDiffIter = localDiffReader.next();
	let lineInPRDiff = line;

	while (!localDiffIter.done) {
		const diffHunk = localDiffIter.value;
		if (diffHunk.oldLineNumber > line) {
			break;
		} else {
			lineInPRDiff += diffHunk.oldLength - diffHunk.newLength;
		}

		localDiffIter = localDiffReader.next();
	}

	const positionInDiffHunk = -1;

	for (let i = 0; i < diffHunks.length; i++) {
		const diffHunk = diffHunks[i];

		for (let j = 0; j < diffHunk.diffLines.length; j++) {
			if (isBase) {
				if (diffHunk.diffLines[j].oldLineNumber === lineInPRDiff) {
					return diffHunk.diffLines[j].positionInHunk;
				}
			} else {
				if (diffHunk.diffLines[j].newLineNumber === lineInPRDiff) {
					return diffHunk.diffLines[j].positionInHunk;
				}
			}
		}
	}

	return positionInDiffHunk;
}

export function mapOldPositionToNew(patch: string, line: number): number {
	const diffReader = parseDiffHunk(patch);
	let diffIter = diffReader.next();

	let delta = 0;
	while (!diffIter.done) {
		const diffHunk = diffIter.value;

		if (diffHunk.oldLineNumber > line) {
			// No-op
		} else if (diffHunk.oldLineNumber + diffHunk.oldLength - 1 < line) {
			delta += diffHunk.newLength - diffHunk.oldLength;
		} else {
			delta += diffHunk.newLength - diffHunk.oldLength;
			return line + delta;
		}

		diffIter = diffReader.next();
	}

	return line + delta;
}

export function mapCommentsToHead(diffHunks: DiffHunk[], localDiff: string, comments: IComment[]) {
	for (let i = 0; i < comments.length; i++) {
		const comment = comments[i];

		// Ignore outdated comments
		if (comment.position === null || comment.position === undefined) {
			continue;
		}

		// Diff line is null when the original line the comment was on has been removed
		const diffLine = getDiffLineByPosition(diffHunks, comment.position);
		if (diffLine) {
			// Ignore comments which are on deletions
			if (diffLine.type === DiffChangeType.Delete) {
				continue;
			}

			const newPosition = mapOldPositionToNew(localDiff, diffLine.newLineNumber);
			comment.absolutePosition = newPosition;
		}
	}

	return comments;
}