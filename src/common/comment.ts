/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAccount } from '../github/interface';
import { DiffHunk } from './diffHunk';

export interface Reaction {
	label: string;
	count: number;
	icon?: vscode.Uri;
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

export interface CommentInfo {
	/**
	 * All of the comment threads associated with the document.
	 */
	threads: vscode.CommentThread[];

	/**
	 * The ranges of the document which support commenting.
	 */
	commentingRanges?: vscode.Range[];
}

export interface CommentHandler {
	commentController?: vscode.CommentController;
	finishReview(thread: vscode.CommentThread): Promise<void>;
	deleteReview(): Promise<void>;
	editComment(thread: vscode.CommentThread, comment: vscode.Comment): Promise<void>;
	deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): Promise<void>;
	updateCommentThreadRoot(thread: vscode.CommentThread, text: string): Promise<void>;
}