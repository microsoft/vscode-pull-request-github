/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from './azdo/prComment';
import Logger from './common/logger';

export interface CommentHandler {
	commentController?: vscode.CommentController;
	hasCommentThread(thread: GHPRCommentThread): boolean;

	createOrReplyComment(thread: GHPRCommentThread, input: string): Promise<void>;
	editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void>;

	changeThreadStatus(thread: GHPRCommentThread): Promise<void>;
}

export interface CommentReply {
	thread: GHPRCommentThread;
	text: string;
}

const commentHandlers = new Map<string, CommentHandler>();

export function registerCommentHandler(key: string, commentHandler: CommentHandler) {
	commentHandlers.set(key, commentHandler);
}

export function unregisterCommentHandler(key: string) {
	commentHandlers.delete(key);
}

export function resolveCommentHandler(commentThread: GHPRCommentThread): CommentHandler | undefined {
	for (const commentHandler of commentHandlers.values()) {
		if (commentHandler.hasCommentThread(commentThread)) {
			return commentHandler;
		}
	}

	Logger.appendLine(`Unable to find handler for comment thread ${commentThread.threadId}`);

	return;
}
