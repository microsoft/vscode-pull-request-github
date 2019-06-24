/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { GHPRCommentThread, GHPRComment, TemporaryComment } from './github/prComment';
import Logger from './common/logger';

export interface CommentHandler {
	commentController?: vscode.CommentController;
	hasCommentThread(thread: GHPRCommentThread): boolean;

	createOrReplyComment(thread: GHPRCommentThread, input: string): Promise<void>;
	editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void>;
	deleteComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void>;

	startReview(thread: GHPRCommentThread, input: string): Promise<void>;
	finishReview(thread: GHPRCommentThread, input: string): Promise<void>;
	deleteReview(): Promise<void>;
}

export interface CommentReply {
	thread: GHPRCommentThread;
	text: string;
}

const commentHandlers = new Set<CommentHandler>();

export function registerCommentHandler(commentHandler: CommentHandler) {
	commentHandlers.add(commentHandler);
}

export function resolveCommentHandler(commentThread: GHPRCommentThread): CommentHandler | undefined {
	for (let [key] of commentHandlers.entries()) {
		if (key.hasCommentThread(commentThread)) {
			return key;
		}
	}

	Logger.appendLine(`Unable to find handler for comment thread ${commentThread.threadId}`);

	return;
}