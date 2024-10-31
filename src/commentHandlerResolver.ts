/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { Repository } from './api/api';
import Logger from './common/logger';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from './github/prComment';

export interface CommentHandler {
	commentController: vscode.CommentController;
	hasCommentThread(thread: GHPRCommentThread): boolean;

	createOrReplyComment(thread: GHPRCommentThread, input: string, isSingleComment: boolean): Promise<void>;
	editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void>;
	deleteComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void>;

	startReview(thread: GHPRCommentThread, input: string): Promise<void>;
	openReview(thread: GHPRCommentThread): Promise<void>;

	resolveReviewThread(thread: GHPRCommentThread, input?: string): Promise<void>;
	unresolveReviewThread(thread: GHPRCommentThread, input?: string): Promise<void>;
}

export interface CommentReply {
	thread: GHPRCommentThread;
	text: string;
}

export namespace CommentReply {
	export function is(commentReply: any): commentReply is CommentReply {
		return commentReply && commentReply.thread && (commentReply.text !== undefined);
	}
}

const commentHandlers = new Map<string, { handler: CommentHandler, repoRootUri: string }>();

export function registerCommentHandler(key: string, commentHandler: CommentHandler, repository: Repository) {
	commentHandlers.set(key, { handler: commentHandler, repoRootUri: repository.rootUri.toString() });
}

export function unregisterCommentHandler(key: string) {
	commentHandlers.delete(key);
}

export function resolveCommentHandler(commentThread: GHPRCommentThread): CommentHandler | undefined {
	const possibleHandlers: { handler: CommentHandler, repoRootUri: string }[] = [];
	for (const commentHandler of commentHandlers.values()) {
		if (commentHandler.handler.hasCommentThread(commentThread)) {
			possibleHandlers.push(commentHandler);
		}
	}
	if (possibleHandlers.length > 0) {
		possibleHandlers.sort((a, b) => {
			return b.repoRootUri.length - a.repoRootUri.length;
		});
		return possibleHandlers[0].handler;
	}
	Logger.warn(`Unable to find handler for comment thread ${commentThread.gitHubThreadId}`);

	return;
}

export function findActiveHandler() {
	for (const commentHandler of commentHandlers.values()) {
		if (commentHandler.handler.commentController.activeCommentThread) {
			return commentHandler.handler;
		}
	}
}
