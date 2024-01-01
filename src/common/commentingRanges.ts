/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DiffChangeType, DiffHunk } from './diffHunk';
import { getZeroBased } from './diffPositionMapping';
import Logger from './logger';

/**
 * For the base file, the only commentable areas are deleted lines. For the modified file,
 * comments can be added on any part of the diff hunk.
 * @param diffHunks The diff hunks of the file
 * @param isBase Whether the commenting ranges are calculated for the base or modified file
 */
export function getCommentingRanges(diffHunks: DiffHunk[], isBase: boolean, logId: string = 'GetCommentingRanges'): vscode.Range[] {
	if (diffHunks.length === 0) {
		Logger.debug('No commenting ranges: File contains no diffs.', logId);
	}

	const ranges: vscode.Range[] = [];

	for (let i = 0; i < diffHunks.length; i++) {
		const diffHunk = diffHunks[i];
		let startingLine: number | undefined;
		let length: number;
		if (isBase) {
			let endingLine: number | undefined;
			for (let j = 0; j < diffHunk.diffLines.length; j++) {
				const diffLine = diffHunk.diffLines[j];
				if (diffLine.type === DiffChangeType.Delete) {
					if (startingLine !== undefined) {
						endingLine = getZeroBased(diffLine.oldLineNumber);
					} else {
						startingLine = getZeroBased(diffLine.oldLineNumber);
						endingLine = getZeroBased(diffLine.oldLineNumber);
					}
				} else {
					if (startingLine !== undefined && endingLine !== undefined) {
						ranges.push(new vscode.Range(startingLine, 0, endingLine, 0));
						startingLine = undefined;
						endingLine = undefined;
					}
				}
			}

			if (startingLine !== undefined && endingLine !== undefined) {
				ranges.push(new vscode.Range(startingLine, 0, endingLine, 0));
				startingLine = undefined;
				endingLine = undefined;
			} else if (ranges.length === 0) {
				Logger.debug('No commenting ranges: Diff is in base and none of the diff hunks could be added.', logId);
			}
		} else {
			if (diffHunk.newLineNumber) {
				startingLine = getZeroBased(diffHunk.newLineNumber);
				length = getZeroBased(diffHunk.newLength);
				ranges.push(new vscode.Range(startingLine, 0, startingLine + length, 0));
			} else {
				Logger.debug('No commenting ranges: Diff is not base and newLineNumber is undefined.', logId);
			}
		}
	}

	Logger.debug(`Found ${ranges.length} commenting ranges.`, logId);
	return ranges;
}
