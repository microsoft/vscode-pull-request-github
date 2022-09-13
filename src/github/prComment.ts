/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IComment } from '../common/comment';
import { IAccount } from './interface';
import { updateCommentReactions } from './utils';

export interface GHPRCommentThread extends vscode.CommentThread {
	gitHubThreadId: string;

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
	state: vscode.CommentThreadState;

	dispose: () => void;
}

abstract class CommentBase implements vscode.Comment {
	public abstract commentId: undefined | string;

	/**
	 * The comment thread the comment is from
	 */
	public parent: GHPRCommentThread;

	/**
	 * The text of the comment as from GitHub
	 */
	public rawBody: string;

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
	 * The context value, used to determine whether the command should be visible/enabled based on clauses in package.json
	 */
	public contextValue: string;

	constructor(
		parent: GHPRCommentThread,
	) {
		this.parent = parent;
	}

	get body(): vscode.MarkdownString | string {
		// VS Code's markdown rendering is more correct and will not render single line breaks as
		// line breaks in markdown. To make the comment look more like github.com, we replace single line breaks with double.
		return (this.mode === vscode.CommentMode.Editing) ? this.rawBody : new vscode.MarkdownString(this.rawBody.replace(/[^\s]\n[^\s]/g, '\n\n'));
	}

	set body(body: vscode.MarkdownString | string) {
		this.rawBody = (body instanceof vscode.MarkdownString) ? body.value : body;
	}

	public abstract commentEditId(): number | string;

	startEdit() {
		this.parent.comments = this.parent.comments.map(cmt => {
			if (cmt instanceof CommentBase && cmt.commentEditId() === this.commentEditId()) {
				cmt.mode = vscode.CommentMode.Editing;
			}

			return cmt;
		});
	}

	protected abstract getCancelEditBody(): string;

	cancelEdit() {
		this.parent.comments = this.parent.comments.map(cmt => {
			if (cmt instanceof CommentBase && cmt.commentEditId() === this.commentEditId()) {
				cmt.mode = vscode.CommentMode.Preview;
				cmt.rawBody = this.getCancelEditBody();
			}

			return cmt;
		});
	}
}

/**
 * Used to optimistically render updates to comment threads. Temporary comments are immediately
 * set when a command is run, and then replaced with real data when the operation finishes.
 */
export class TemporaryComment extends CommentBase {
	public commentId: undefined;

	/**
	 * The id of the comment
	 */
	public id: number;

	/**
	 * If the temporary comment is in place for an edit, the original text value of the comment
	 */
	public originalBody?: string;

	static idPool = 0;

	constructor(
		parent: GHPRCommentThread,
		input: string,
		isDraft: boolean,
		currentUser: IAccount,
		originalComment?: GHPRComment,
	) {
		super(parent);
		this.rawBody = input;
		this.mode = vscode.CommentMode.Preview;
		this.author = {
			name: currentUser.login,
			iconPath: currentUser.avatarUrl ? vscode.Uri.parse(`${currentUser.avatarUrl}&s=64`) : undefined,
		};
		this.label = isDraft ? 'Pending' : undefined;
		this.contextValue = 'canEdit,canDelete';
		this.originalBody = originalComment ? originalComment._rawComment.body : undefined;
		this.reactions = originalComment ? originalComment.reactions : undefined;
		this.id = TemporaryComment.idPool++;
	}

	commentEditId() {
		return this.id;
	}

	protected getCancelEditBody() {
		return this.originalBody || this.rawBody;
	}
}

export class GHPRComment extends CommentBase {
	public commentId: string;
	public timestamp: Date;

	/**
	 * The complete comment data returned from GitHub
	 */
	public _rawComment: IComment;

	constructor(comment: IComment, parent: GHPRCommentThread) {
		super(parent);
		this._rawComment = comment;
		this.commentId = comment.id.toString();
		this.rawBody = comment.body;
		this.author = {
			name: comment.user!.login,
			iconPath: comment.user && comment.user.avatarUrl ? vscode.Uri.parse(comment.user.avatarUrl) : undefined,
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
		this.timestamp = new Date(comment.createdAt);
	}

	public commentEditId() {
		return this.commentId;
	}

	protected getCancelEditBody() {
		return this._rawComment.body;
	}
}
