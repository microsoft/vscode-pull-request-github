/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { Repository } from '../git/api';
import { IAccount } from '../github/interface';
import { GitFileChangeNode } from '../view/treeNodes/fileChangeNode';
import { DiffHunk } from './diffHunk';
import { getZeroBased } from './diffPositionMapping';
import { GitChangeType } from './file';
import { groupBy } from './utils';

export function convertToVSCodeComment(comment: Comment, command?: vscode.Command): vscode.Comment {
	return {
		commentId: comment.id.toString(),
		body: new vscode.MarkdownString(comment.body),
		command: command,
		userName: comment.user!.login,
		gravatar: comment.user!.avatarUrl,
		canEdit: comment.canEdit,
		canDelete: comment.canDelete,
		isDraft: !!comment.isDraft,
		commentReactions: comment.reactions ? comment.reactions.map(reaction => {
			return { label: reaction.label, hasReacted: reaction.viewerHasReacted };
		}) : []
	};
}

export function getCommentingRanges(diffHunks: DiffHunk[], isBase: boolean): vscode.Range[] {
	const ranges: vscode.Range[] = [];

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

		ranges.push(new vscode.Range(startingLine, 0, startingLine + length, 0));
	}

	return ranges;
}

export function workspaceLocalCommentsToCommentThreads(repository: Repository, fileChange: GitFileChangeNode, fileComments: Comment[], collapsibleState: vscode.CommentThreadCollapsibleState): vscode.CommentThread[] {
	if (!fileChange) {
		return [];
	}

	if (!fileComments || !fileComments.length) {
		return [];
	}

	const ret: vscode.CommentThread[] = [];
	const sections = groupBy(fileComments, comment => String(comment.position));

	let command: vscode.Command | undefined = undefined;
	if (fileChange.status === GitChangeType.DELETE) {
		command = {
			title: 'View Changes',
			command: 'pr.viewChanges',
			arguments: [
				fileChange
			]
		};
	}

	for (let i in sections) {
		const comments = sections[i];

		const firstComment = comments[0];
		const pos = new vscode.Position(getZeroBased(firstComment.absolutePosition || 0), 0);
		const range = new vscode.Range(pos, pos);

		const newPath = path.join(repository.rootUri.path, firstComment.path!).replace(/\\/g, '/');
		const newUri = repository.rootUri.with({ path: newPath });
		ret.push({
			threadId: firstComment.id.toString(),
			resource: newUri,
			range,
			comments: comments.map(comment => convertToVSCodeComment(comment, command)),
			collapsibleState
		});
	}

	return ret;
}

export interface Reaction {
	label: string;
	viewerHasReacted: boolean;
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
	reactions?: Reaction[];
}
