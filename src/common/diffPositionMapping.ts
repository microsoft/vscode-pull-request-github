/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DiffLine, DiffHunk, parseDiffHunk, DiffChangeType } from './diffHunk';
import { Comment } from './comment';

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
 * For the base file, only the old line number of the comment should be considered. If it's -1, the comment
 * is on a line that is entirely new, so the comment should not be displayed on the base file. This means
 * that for the modified file, if the comment has a non-negative old line number, it has already been
 * displayed on the base and does not need to be shown again.
 * @param comment The comment
 * @param fileDiffHunks The diff hunks of the file
 * @param isBase Whether the file, if a diff, is the base or modified
 */
export function getAbsolutePosition(comment: Comment, fileDiffHunks: DiffHunk[], isBase: boolean): number {
	let commentAbsolutePosition = -1;
	// Ignore outdated comments
	if (comment.position !== null) {
		let diffLine = getDiffLineByPosition(fileDiffHunks, comment.position);

		if (diffLine) {
			if (isBase) {
				commentAbsolutePosition = diffLine.oldLineNumber;
			} else {
				commentAbsolutePosition = diffLine.oldLineNumber > 0 ? -1 : diffLine.newLineNumber;
			}
		}
	}

	return commentAbsolutePosition;
}

/**
 * Returns the position of the comment within the diff. This is simply the comment.position property,
 * but the method ensures that the comment will be shown on the correct side of the diff by
 * returning -1 when the comment's line is an addition and the document is the base and vice versa.
 * @param comment The comment
 * @param fileDiffHunks The diff hunks of the file
 * @param isBase Whether the file, if a diff, is the base or modified
 */
export function getPositionInDiff(comment: Comment, fileDiffHunks: DiffHunk[], isBase: boolean): number {
	let commentAbsolutePosition = -1;
	// Ignore outdated comments
	if (comment.position !== null) {
		let diffLine = getDiffLineByPosition(fileDiffHunks, comment.position);

		if (diffLine) {
			if ((diffLine.type === DiffChangeType.Add && !isBase) || (diffLine.type == DiffChangeType.Delete && isBase)) {
				commentAbsolutePosition = comment.position
			}
		}
	}

	return commentAbsolutePosition;
}


export function getLastDiffLine(prPatch: string): DiffLine {
	let lastDiffLine = null;
	let prDiffReader = parseDiffHunk(prPatch);
	let prDiffIter = prDiffReader.next();

	while (!prDiffIter.done) {
		let diffHunk = prDiffIter.value;
		lastDiffLine = diffHunk.diffLines[diffHunk.diffLines.length - 1];

		prDiffIter = prDiffReader.next();
	}

	return lastDiffLine;
}

export function getDiffLineByPosition(diffHunks: DiffHunk[], diffLineNumber: number): DiffLine {
	for (let i = 0; i < diffHunks.length; i++) {
		let diffHunk = diffHunks[i];
		for (let i = 0; i < diffHunk.diffLines.length; i++) {
			if (diffHunk.diffLines[i].positionInHunk === diffLineNumber) {
				return diffHunk.diffLines[i];
			}
		}
	}

	return null;
}

export function mapHeadLineToDiffHunkPosition(diffHunks: DiffHunk[], localDiff: string, line: number, isBase: boolean = false): number {
	let localDiffReader = parseDiffHunk(localDiff);
	let localDiffIter = localDiffReader.next();
	let lineInPRDiff = line;

	while (!localDiffIter.done) {
		let diffHunk = localDiffIter.value;
		if (diffHunk.oldLineNumber > line) {
			break;
		} else {
			lineInPRDiff += diffHunk.oldLength - diffHunk.newLength;
		}

		localDiffIter = localDiffReader.next();
	}

	let positionInDiffHunk = -1;

	for (let i = 0; i < diffHunks.length; i++) {
		let diffHunk = diffHunks[i];

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
	let diffReader = parseDiffHunk(patch);
	let diffIter = diffReader.next();

	let delta = 0;
	while (!diffIter.done) {
		let diffHunk = diffIter.value;

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

export function mapCommentsToHead(diffHunks: DiffHunk[], localDiff: string, comments: Comment[]) {
	for (let i = 0; i < comments.length; i++) {
		const comment = comments[i];

		// Diff line is null when the original line the comment was on has been removed
		const diffLine = getDiffLineByPosition(diffHunks, comment.position || comment.original_position);
		if (diffLine) {
			const positionInPr = diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber;
			const newPosition = mapOldPositionToNew(localDiff, positionInPr);
			comment.absolutePosition = newPosition;
		}
	}

	return comments;
}