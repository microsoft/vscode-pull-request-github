/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { CommentHandler } from './github/utils';

let commentHandlers = new Set<CommentHandler>();

export function registerCommentHandler(commentHandler: CommentHandler) {
	commentHandlers.add(commentHandler);
}

export function resolveCommentHandler(commentThread: vscode.CommentThread): CommentHandler | undefined {
	for (let [key] of commentHandlers.entries()) {
		if (key.hasCommentThread(commentThread)) {
			return key;
		}
	}

	return;
}