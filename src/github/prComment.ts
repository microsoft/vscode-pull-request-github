/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
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

export namespace GHPRCommentThread {
	export function is(value: any): value is GHPRCommentThread {
		return (value && (typeof (value as GHPRCommentThread).gitHubThreadId) === 'string');
	}
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
	public abstract get body(): string | vscode.MarkdownString;
	public abstract set body(body: string | vscode.MarkdownString);

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

	public abstract commentEditId(): number | string;

	startEdit() {
		this.parent.comments = this.parent.comments.map(cmt => {
			if (cmt instanceof CommentBase && cmt.commentEditId() === this.commentEditId()) {
				cmt.mode = vscode.CommentMode.Editing;
			}

			return cmt;
		});
	}

	protected abstract getCancelEditBody(): string | vscode.MarkdownString;

	cancelEdit() {
		this.parent.comments = this.parent.comments.map(cmt => {
			if (cmt instanceof CommentBase && cmt.commentEditId() === this.commentEditId()) {
				cmt.mode = vscode.CommentMode.Preview;
				cmt.body = this.getCancelEditBody();
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
		private input: string,
		isDraft: boolean,
		currentUser: IAccount,
		originalComment?: GHPRComment,
	) {
		super(parent);
		this.mode = vscode.CommentMode.Preview;
		this.author = {
			name: currentUser.login,
			iconPath: currentUser.avatarUrl ? vscode.Uri.parse(`${currentUser.avatarUrl}&s=64`) : undefined,
		};
		this.label = isDraft ? vscode.l10n.t('Pending') : undefined;
		this.contextValue = 'canEdit,canDelete';
		this.originalBody = originalComment ? originalComment.rawComment.body : undefined;
		this.reactions = originalComment ? originalComment.reactions : undefined;
		this.id = TemporaryComment.idPool++;
	}

	set body(input: string | vscode.MarkdownString) {
		if (typeof input === 'string') {
			this.input = input;
		}
	}

	get body(): string | vscode.MarkdownString {
		return new vscode.MarkdownString(this.input);
	}

	commentEditId() {
		return this.id;
	}

	protected getCancelEditBody() {
		return this.originalBody || this.body;
	}
}

const SUGGESTION_EXPRESSION = /```suggestion(\n|\r\n)([\s\S]*)(\n|\r\n)```/;

export class GHPRComment extends CommentBase {
	public commentId: string;
	public timestamp: Date;

	/**
	 * The complete comment data returned from GitHub
	 */
	public readonly rawComment: IComment;

	private _rawBody: string | vscode.MarkdownString;

	constructor(comment: IComment, parent: GHPRCommentThread) {
		super(parent);
		this.rawComment = comment;
		this._rawBody = comment.body;
		this.commentId = comment.id.toString();
		this.author = {
			name: comment.user!.login,
			iconPath: comment.user && comment.user.avatarUrl ? vscode.Uri.parse(comment.user.avatarUrl) : undefined,
		};
		updateCommentReactions(this, comment.reactions);

		this.label = comment.isDraft ? vscode.l10n.t('Pending') : undefined;

		const contextValues: string[] = [];
		if (comment.canEdit) {
			contextValues.push('canEdit');
		}

		if (comment.canDelete) {
			contextValues.push('canDelete');
		}

		if (this.suggestion) {
			contextValues.push('hasSuggestion');
		}

		this.contextValue = contextValues.join(',');
		this.timestamp = new Date(comment.createdAt);
	}

	get suggestion(): string | undefined {
		const suggestionBody = this.rawComment.body.match(SUGGESTION_EXPRESSION);
		if (suggestionBody?.length === 4) {
			return suggestionBody[2];
		}
	}

	public commentEditId() {
		return this.commentId;
	}

	private replaceSuggestion(body: string) {
		return body.replace(SUGGESTION_EXPRESSION, (_substring: string, ...args: any[]) => {
			return `***
Suggested change:
\`\`\`
${args[1]}
\`\`\`
***`;
		});
	}

	set body(body: string | vscode.MarkdownString) {
		this._rawBody = body;
	}

	get body(): string | vscode.MarkdownString {
		if (this.mode === vscode.CommentMode.Editing) {
			return this._rawBody;
		}
		if (this._rawBody instanceof vscode.MarkdownString) {
			return new vscode.MarkdownString(this.replaceSuggestion(this._rawBody.value));
		}
		const linkified = this._rawBody.replace(/([^\[]|^)\@([^\s]+)/, (substring) => {
			const username = substring.substring(substring.startsWith('@') ? 1 : 2);
			return `${substring.startsWith('@') ? '' : substring.charAt(0)}[@${username}](${path.dirname(this.rawComment.user!.url)}/${username})`;
		});

		return new vscode.MarkdownString(this.replaceSuggestion(linkified));
	}

	protected getCancelEditBody() {
		return new vscode.MarkdownString(this.rawComment.body);
	}
}
