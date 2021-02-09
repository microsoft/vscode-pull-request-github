/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IComment } from '../common/comment';
import { IAccount } from './interface';
import { updateCommentReactions } from './utils';

export interface GHPRCommentThread extends vscode.CommentThread {
	threadId: string;

	/**
	 * The uri of the document the thread has been created on.
	 */
	uri: vscode.Uri;

	/**
	 * The range the comment thread is located within the document. The thread icon will be shown
	 * at the first line of the range.
	 */
	range: vscode.Range;

	/**
	 * The ordered comments of the thread.
	 */
	comments: (GHPRComment | TemporaryComment)[];

	/**
	 * Whether the thread should be collapsed or expanded when opening the document.
	 * Defaults to Collapsed.
	 */
	collapsibleState: vscode.CommentThreadCollapsibleState;

	/**
	 * The optional human-readable label describing the [Comment Thread](#CommentThread)
	 */
	label?: string;

	/**
	 * Whether the thread has been marked as resolved.
	 */
	isResolved: boolean;

	dispose: () => void;
}

/**
 * Used to optimistically render updates to comment threads. Temporary comments are immediately
 * set when a command is run, and then replaced with real data when the operation finishes.
 */
export class TemporaryComment implements vscode.Comment {
	/**
	 * The id of the comment
	 */
	public id: number;

	/**
	 * The comment thread the comment is from
	 */
	public parent: GHPRCommentThread;

	/**
	 * The text of the comment
	 */
	public body: string | vscode.MarkdownString;

	/**
	 * If the temporary comment is in place for an edit, the original text value of the comment
	 */
	public originalBody?: string;

	/**
	 * Whether the comment is in edit mode or not
	 */
	public mode: vscode.CommentMode;

	/**
	 * The author of the comment
	 */
	public author: vscode.CommentAuthorInformation;

	/**
	 * The label to display on the comment, 'Pending' or nothing
	 */
	public label: string | undefined;

	/**
	 * The list of reactions to the comment
	 */
	public commentReactions?: vscode.CommentReaction[] | undefined;

	/**
	 * The context value, used to determine whether the command should be visible/enabled based on clauses in package.json
	 */
	public contextValue: string;

	static idPool = 0;

	constructor(parent: GHPRCommentThread, input: string, isDraft: boolean, currentUser: IAccount, originalComment?: GHPRComment) {
		this.parent = parent;
		this.body = new vscode.MarkdownString(input);
		this.mode = vscode.CommentMode.Preview;
		this.author = {
			name: currentUser.login,
			iconPath: currentUser.avatarUrl ? vscode.Uri.parse(`${currentUser.avatarUrl}&s=64`) : undefined
		};
		this.label = isDraft ? 'Pending' : undefined;
		this.contextValue = 'canEdit,canDelete';
		this.originalBody = originalComment ? originalComment._rawComment.body : undefined;
		this.commentReactions = originalComment ? originalComment.reactions : undefined;
		this.id = TemporaryComment.idPool++;
	}

	startEdit() {
		this.parent.comments = this.parent.comments.map(cmt => {
			if (cmt instanceof TemporaryComment && cmt.id === this.id) {
				cmt.mode = vscode.CommentMode.Editing;
			}

			return cmt;
		});
	}

	cancelEdit() {
		this.parent.comments = this.parent.comments.map(cmt => {
			if (cmt instanceof TemporaryComment && cmt.id === this.id) {
				cmt.mode = vscode.CommentMode.Preview;
				cmt.body = cmt.originalBody || cmt.body;
			}

			return cmt;
		});
	}
}

export class GHPRComment implements vscode.Comment {
	/**
	 * The database id of the comment
	 */
	public commentId: string;

	/**
	 * The comment thread the comment is from
	 */
	public parent: GHPRCommentThread;

	/**
	 * The text of the comment
	 */
	public body: string | vscode.MarkdownString;

	/**
	 * Whether the comment is in edit mode or not
	 */
	public mode: vscode.CommentMode;

	/**
	 * The author of the comment
	 */
	public author: vscode.CommentAuthorInformation;

	/**
	 * The label to display on the comment, 'Pending' or nothing
	 */
	public label: string | undefined;

	/**
	 * The list of reactions to the comment
	 */
	public reactions?: vscode.CommentReaction[] | undefined;

	/**
	 * The complete comment data returned from GitHub
	 */
	public _rawComment: IComment;

	/**
	 * The context value, used to determine whether the command should be visible/enabled based on clauses in package.json
	 */
	public contextValue: string;

	constructor(comment: IComment, parent: GHPRCommentThread) {
		this._rawComment = comment;
		this.commentId = comment.id.toString();
		this.body = new vscode.MarkdownString(comment.body);
		this.body.isTrusted = true;
		this.author = {
			name: comment.user!.login,
			iconPath: comment.user && comment.user.avatarUrl ? vscode.Uri.parse(comment.user.avatarUrl) : undefined
		};
		updateCommentReactions(this, comment.reactions);

		this.label = comment.isDraft ? 'Pending' : undefined;

		const contextValues: string[] = [];
		if (comment.canEdit) {
			contextValues.push('canEdit');
		}

		if (comment.canDelete) {
			contextValues.push('canDelete');
		}

		this.contextValue = contextValues.join(',');
		this.parent = parent;
	}

	startEdit() {
		this.parent.comments = this.parent.comments.map(cmt => {
			if (cmt instanceof GHPRComment && cmt.commentId === this.commentId) {
				cmt.mode = vscode.CommentMode.Editing;
			}

			return cmt;
		});
	}

	cancelEdit() {
		this.parent.comments = this.parent.comments.map(cmt => {
			if (cmt instanceof GHPRComment && cmt.commentId === this.commentId) {
				cmt.mode = vscode.CommentMode.Preview;
				cmt.body = cmt._rawComment.body;
			}

			return cmt;
		});
	}
}
