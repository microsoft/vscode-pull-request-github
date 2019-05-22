/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IComment } from '../common/comment';

export interface GHPRCommentThread {
	threadId: string;

	/**
	 * The uri of the document the thread has been created on.
	 */
	resource: vscode.Uri;

	/**
	 * The range the comment thread is located within the document. The thread icon will be shown
	 * at the first line of the range.
	 */
	range: vscode.Range;

	/**
	 * The ordered comments of the thread.
	 */
	comments: GHPRComment[];

	/**
	 * Whether the thread should be collapsed or expanded when opening the document.
	 * Defaults to Collapsed.
	 */
	collapsibleState: vscode.CommentThreadCollapsibleState;

	/**
	 * The optional human-readable label describing the [Comment Thread](#CommentThread)
	 */
	label?: string;
}

export class GHPRComment implements vscode.Comment {
	body: string | vscode.MarkdownString;
	mode: vscode.CommentMode;
	author: vscode.CommentAuthorInformation;
	label?: string | undefined;
	commentReactions?: vscode.CommentReaction[] | undefined;
	commentId: string;
	_rawComment: IComment;
	parent: vscode.CommentThread | undefined;
	contextValue: string;

	constructor(comment: IComment, parent?: vscode.CommentThread) {
		this._rawComment = comment;
		this.commentId = comment.id.toString();
		this.body = new vscode.MarkdownString(comment.body);
		this.author = {
			name: comment.user!.login,
			iconPath: comment.user && comment.user.avatarUrl ? vscode.Uri.parse(comment.user.avatarUrl) : undefined
		};
		this.commentReactions = comment.reactions ? comment.reactions.map(reaction => {
			return { label: reaction.label, hasReacted: reaction.viewerHasReacted, count: reaction.count, iconPath: reaction.icon };
		}) : [];
		this.label = comment.isDraft ? 'Pending' : undefined;
		this.contextValue = comment.canEdit ? 'canEdit' : '';
		this.parent = parent;
	}
}
