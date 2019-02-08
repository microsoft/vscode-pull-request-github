/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DiffHunk } from './diffHunk';
import { IAccount } from '../github/interface';
import { Comment as VSCodeComment, MarkdownString, Command, Range } from 'vscode';
import { getZeroBased } from './diffPositionMapping';

export function convertToVSCodeComment(comment: Comment, command?: Command): VSCodeComment {
	return {
		commentId: comment.id.toString(),
		body: new MarkdownString(comment.body),
		command: command,
		userName: comment.user!.login,
		gravatar: comment.user!.avatarUrl,
		canEdit: comment.canEdit,
		canDelete: comment.canDelete,
		isDraft: !!comment.isDraft
	};
}

export function getCommentingRanges(diffHunks: DiffHunk[], isBase: boolean): Range[] {
	const ranges: Range[] = [];

	for (let i = 0; i < diffHunks.length; i++) {
		let diffHunk = diffHunks[i];
		let startingLine: number;
		let length: number;
		if (isBase) {
			startingLine = getZeroBased(diffHunk.oldLineNumber);
			length = getZeroBased(diffHunk.oldLength);

		} else {
			startingLine = getZeroBased(diffHunk.newLineNumber);
			length = getZeroBased(diffHunk.newLength);
		}

		ranges.push(new Range(startingLine, 0, startingLine + length, 0));
	}

	return ranges;
}

export interface Comment {
	absolutePosition?: number;
	bodyHTML?: string;
	diffHunks?: DiffHunk[];
	canEdit?: boolean;
	canDelete?: boolean;
	url: string;
	id: number;
	pullRequestReviewId?: number;
	diffHunk: string;
	path?: string;
	position?: number;
	commitId?: string;
	originalPosition?: number;
	originalCommitId?: string;
	user?: IAccount;
	body: string;
	createdAt: string;
	htmlUrl: string;
	isDraft?: boolean;
	inReplyToId?: number;
	graphNodeId: string;
}
