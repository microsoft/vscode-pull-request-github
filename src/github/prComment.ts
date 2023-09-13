/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { IComment } from '../common/comment';
import { DataUri } from '../common/uri';
import { JSDOC_NON_USERS, PHPDOC_NON_USERS } from '../common/user';
import { stringReplaceAsync } from '../common/utils';
import { GitHubRepository } from './githubRepository';
import { IAccount } from './interface';
import { updateCommentReactions } from './utils';

export interface GHPRCommentThread extends vscode.CommentThread2 {
	gitHubThreadId: string;

	/**
	 * The uri of the document the thread has been created on.
	 */
	uri: vscode.Uri;

	/**
	 * The range the comment thread is located within the document. The thread icon will be shown
	 * at the first line of the range.
	 */
	range: vscode.Range | undefined;

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
		this.contextValue = 'temporary,canEdit,canDelete';
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

const SUGGESTION_EXPRESSION = /```suggestion(\r\n|\n)((?<suggestion>[\s\S]*?)(\r\n|\n))?```/;

export class GHPRComment extends CommentBase {
	public commentId: string;
	public timestamp: Date;

	/**
	 * The complete comment data returned from GitHub
	 */
	public rawComment: IComment;

	private _rawBody: string | vscode.MarkdownString;
	private replacedBody: string;

	constructor(comment: IComment, parent: GHPRCommentThread, private readonly githubRepository?: GitHubRepository) {
		super(parent);
		this.rawComment = comment;
		this.body = comment.body;
		this.commentId = comment.id.toString();
		this.author = {
			name: comment.user!.login,
			iconPath: comment.user && comment.user.avatarUrl ? vscode.Uri.parse(comment.user.avatarUrl) : undefined,
		};
		if (comment.user) {
			DataUri.avatarCircleAsImageDataUri(comment.user, 28, 28).then(avatarUri => {
				this.author.iconPath = avatarUri;
				this.refresh();
			});
		}

		updateCommentReactions(this, comment.reactions);

		this.label = comment.isDraft ? vscode.l10n.t('Pending') : undefined;

		const contextValues: string[] = [];
		if (comment.canEdit) {
			contextValues.push('canEdit');
		}

		if (comment.canDelete) {
			contextValues.push('canDelete');
		}

		if (this.suggestion !== undefined) {
			contextValues.push('hasSuggestion');
		}

		this.contextValue = contextValues.join(',');
		this.timestamp = new Date(comment.createdAt);
	}

	update(comment: IComment) {
		const oldRawComment = this.rawComment;
		this.rawComment = comment;
		let refresh: boolean = false;

		if (updateCommentReactions(this, comment.reactions)) {
			refresh = true;
		}

		const oldLabel = this.label;
		this.label = comment.isDraft ? vscode.l10n.t('Pending') : undefined;
		if (this.label !== oldLabel) {
			refresh = true;
		}

		const contextValues: string[] = [];
		if (comment.canEdit) {
			contextValues.push('canEdit');
		}

		if (comment.canDelete) {
			contextValues.push('canDelete');
		}

		if (this.suggestion !== undefined) {
			contextValues.push('hasSuggestion');
		}

		const oldContextValue = this.contextValue;
		this.contextValue = contextValues.join(',');
		if (oldContextValue !== this.contextValue) {
			refresh = true;
		}

		// Set the comment body last as it will trigger an update if set.
		if (oldRawComment.body !== comment.body) {
			this.body = comment.body;
			refresh = false;
		}

		if (refresh) {
			this.refresh();
		}
	}

	private refresh() {
		// Self assign the comments to trigger an update of the comments in VS Code now that we have replaced the body.
		// eslint-disable-next-line no-self-assign
		this.parent.comments = this.parent.comments;
	}

	get suggestion(): string | undefined {
		const match = this.rawComment.body.match(SUGGESTION_EXPRESSION);
		const suggestionBody = match?.groups?.suggestion;
		if (match?.length === 5) {
			return suggestionBody ? `${suggestionBody}\n` : '';
		}
	}

	public commentEditId() {
		return this.commentId;
	}

	private replaceSuggestion(body: string) {
		return body.replace(new RegExp(SUGGESTION_EXPRESSION, 'g'), (_substring: string, ...args: any[]) => {
			return `***
Suggested change:
\`\`\`
${args[2] ?? ''}
\`\`\`
***`;
		});
	}

	private async replacePermalink(body: string): Promise<string> {
		if (!this.githubRepository) {
			return body;
		}

		const expression = new RegExp(`https://github.com/${this.githubRepository.remote.owner}/${this.githubRepository.remote.repositoryName}/blob/([0-9a-f]{40})/(.*)#L([0-9]+)(-L([0-9]+))?`, 'g');
		return stringReplaceAsync(body, expression, async (match: string, sha: string, file: string, start: string, _endGroup?: string, end?: string, index?: number) => {
			if (index && (index > 0) && (body.charAt(index - 1) === '(')) {
				return match;
			}
			const startLine = parseInt(start);
			const endLine = end ? parseInt(end) : startLine + 1;
			const lineContents = await this.githubRepository!.getLines(sha, file, startLine, endLine);
			if (!lineContents) {
				return match;
			}
			const lineMessage = end ? `Lines ${startLine} to ${endLine} in \`${sha.substring(0, 7)}\`` : `Line ${startLine} in \`${sha.substring(0, 7)}\``;
			return `
***
[${file}](${match})

${lineMessage}
\`\`\`
${lineContents}
\`\`\`
***`;
		});
	}

	private async replaceBody(body: string | vscode.MarkdownString): Promise<string> {
		if (body instanceof vscode.MarkdownString) {
			const permalinkReplaced = await this.replacePermalink(body.value);
			return this.replaceSuggestion(permalinkReplaced);
		}
		const documentLanguage = (await vscode.workspace.openTextDocument(this.parent.uri)).languageId;
		// Replace user
		const linkified = body.replace(/([^\[`]|^)\@([^\s`]+)/g, (substring, _1, _2, offset) => {
			// Do not try to replace user if there's a code block.
			if ((body.substring(0, offset).match(/```/g)?.length ?? 0) % 2 === 1) {
				return substring;
			}
			const username = substring.substring(substring.startsWith('@') ? 1 : 2);
			if ((((documentLanguage === 'javascript') || (documentLanguage === 'typescript')) && JSDOC_NON_USERS.includes(username))
				|| ((documentLanguage === 'php') && PHPDOC_NON_USERS.includes(username))) {
				return substring;
			}
			return `${substring.startsWith('@') ? '' : substring.charAt(0)}[@${username}](${path.dirname(this.rawComment.user!.url)}/${username})`;
		});

		const permalinkReplaced = await this.replacePermalink(linkified);
		return this.replaceSuggestion(permalinkReplaced);
	}

	set body(body: string | vscode.MarkdownString) {
		this._rawBody = body;
		this.replaceBody(body).then(replacedBody => {
			if (replacedBody !== this.replacedBody) {
				this.replacedBody = replacedBody;
				this.refresh();
			}
		});
	}

	get body(): string | vscode.MarkdownString {
		if (this.mode === vscode.CommentMode.Editing) {
			return this._rawBody;
		}
		return new vscode.MarkdownString(this.replacedBody);
	}

	protected getCancelEditBody() {
		return new vscode.MarkdownString(this.rawComment.body);
	}
}
