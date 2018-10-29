/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as moment from 'moment';
import md from './mdRenderer';
import { MessageHandler } from './message';

const commitIconSvg = require('../resources/icons/commit_icon.svg');
const editIcon = require('../resources/icons/edit.svg');
const deleteIcon = require('../resources/icons/delete.svg');

const emoji = require('node-emoji');

export enum DiffChangeType {
	Context,
	Add,
	Delete,
	Control
}

interface DiffLine {
	_raw: string;
	type: DiffChangeType;
	oldLineNumber: number;
	newLineNumber: number;
	positionInHunk: number;
}

export function getDiffChangeType(text: string) {
	let c = text[0];
	switch (c) {
		case ' ': return DiffChangeType.Context;
		case '+': return DiffChangeType.Add;
		case '-': return DiffChangeType.Delete;
		default: return DiffChangeType.Control;
	}
}

export class DiffHunk {
	public diffLines: DiffLine[] = [];

	constructor(
		public oldLineNumber: number,
		public oldLength: number,
		public newLineNumber: number,
		public newLength: number,
		public positionInHunk: number
	) { }
}
interface Comment {
	url: string;
	id: string;
	path: string;
	pull_request_review_id: string;
	diff_hunk: string;
	diff_hunks: DiffHunk[];
	position: number;
	original_position: number;
	commit_id: string;
	original_commit_id: string;
	user: User;
	body: string;
	created_at: string;
	updated_at: string;
	html_url: string;
	absolutePosition?: number;
	canEdit: boolean;
	canDelete: boolean;
}

export enum EventType {
	Committed,
	Mentioned,
	Subscribed,
	Commented,
	Reviewed,
	Other
}

export interface Author {
	name: string;
	email: string;
	date: Date;
	login?: string;
	avatar_url?: string;
	html_url?: string;
}

export interface Committer {
	name: string;
	email: string;
	date: Date;
}

export interface Tree {
	sha: string;
	url: string;
}

export interface Parent {
	sha: string;
	url: string;
	html_url: string;
}

export interface Verification {
	verified: boolean;
	reason: string;
	signature?: any;
	payload?: any;
}

export interface User {
	login: string;
	id: number;
	avatar_url: string;
	gravatar_id: string;
	url: string;
	html_url: string;
	followers_url: string;
	following_url: string;
	gists_url: string;
	starred_url: string;
	subscriptions_url: string;
	organizations_url: string;
	repos_url: string;
	events_url: string;
	received_events_url: string;
	type: string;
	site_admin: boolean;
}

export interface Html {
	href: string;
}

export interface PullRequest {
	href: string;
}

export interface Links {
	html: Html;
	pull_request: PullRequest;
}

export interface MentionEvent {
	id: number;
	url: string;
	actor: User;
	event: EventType;
	commit_id: string;
	commit_url: string;
	created_at: Date;
}

export interface SubscribeEvent {
	id: number;
	url: string;
	actor: User;
	event: EventType;
	commit_id: string;
	commit_url: string;
	created_at: Date;
}

export interface CommentEvent {
	url: string;
	html_url: string;
	author: Author;
	user: User;
	created_at: Date;
	updated_at: Date;
	id: number;
	event: EventType;
	actor: User;
	author_association: string;
	body: string;
	canDelete: boolean;
	canEdit: boolean;
}

export interface ReviewEvent {
	id: number;
	user: User;
	body: string;
	commit_id: string;
	submitted_at: Date;
	state: string;
	html_url: string;
	pull_request_url: string;
	author_association: string;
	_links: Links;
	event: EventType;
	comments: Comment[];
}

export interface CommitEvent {
	sha: string;
	url: string;
	html_url: string;
	author: Author;
	committer: Committer;
	tree: Tree;
	message: string;
	parents: Parent[];
	verification: Verification;
	event: EventType;
}

export enum PullRequestStateEnum {
	Open,
	Merged,
	Closed,
}

export type TimelineEvent = CommitEvent | ReviewEvent | SubscribeEvent | CommentEvent | MentionEvent;

function groupBy<T>(arr: T[], fn: (el: T) => string): { [key: string]: T[] } {
	return arr.reduce((result, el) => {
		const key = fn(el);
		result[key] = [...(result[key] || []), el];
		return result;
	}, Object.create(null));
}

function renderUserIcon(iconLink: string, iconSrc: string): HTMLElement {
	const iconContainer: HTMLDivElement = document.createElement('div');
	iconContainer.className = 'avatar-container';

	const avatarLink: HTMLAnchorElement = document.createElement('a');
	avatarLink.className = 'avatar-link';
	avatarLink.href = iconLink;

	const avatar: HTMLImageElement = document.createElement('img');
	avatar.className = 'avatar';
	avatar.src = iconSrc;

	iconContainer.appendChild(avatarLink).appendChild(avatar);

	return iconContainer;
}

export class ActionsBar {
	private _actionsBar: HTMLDivElement | undefined;
	private _editingContainer: HTMLDivElement | undefined;
	private _editingArea: HTMLTextAreaElement | undefined;

	constructor(private _container: HTMLElement,
		private _comment: Comment,
		private _renderedComment: HTMLElement,
		private _messageHandler: MessageHandler,
		private _editCommand?: string,
		private _deleteCommand?: string,
		private _review?: ReviewNode) {

	}

	render(): HTMLElement {
		this._actionsBar = document.createElement('div');
		this._actionsBar.classList.add('comment-actions', 'hidden');

		if (this._editCommand) {
			const editButton = document.createElement('button');
			editButton.innerHTML = editIcon;
			editButton.addEventListener('click', () => this.startEdit());
			this._actionsBar.appendChild(editButton);
		}

		if (this._deleteCommand) {
			const deleteButton = document.createElement('button');
			deleteButton.innerHTML = deleteIcon;
			deleteButton.addEventListener('click', () => this.delete());
			this._actionsBar.appendChild(deleteButton);
		}

		return this._actionsBar;
	}

	registerActionBarListeners(): void {
		this._container.addEventListener('mouseenter', () => {
			if (!this._editingContainer) {
				this._actionsBar!.classList.remove('hidden');
			}
		});

		this._container.addEventListener('focusin', () => {
			if (!this._editingContainer) {
				this._actionsBar!.classList.remove('hidden');
			}
		});

		this._container.addEventListener('mouseleave', () => {
			if (!this._container.contains(document.activeElement)) {
				this._actionsBar!.classList.add('hidden');
			}
		});

		this._container.addEventListener('focusout', (e) => {
			if (!this._container.contains((<any>e).target)) {
				this._actionsBar!.classList.add('hidden');
			}
		});
	}

	private startEdit(): void {
		this._actionsBar!.classList.add('hidden');
		this._editingContainer = document.createElement('div');
		this._editingContainer.className = 'editing-form';
		this._editingArea = document.createElement('textarea');
		this._editingArea.value = this._comment.body;

		this._renderedComment.classList.add('hidden');

		const cancelButton = document.createElement('button');
		cancelButton.textContent = 'Cancel';
		cancelButton.onclick = () => { this.finishEdit(); };

		const updateButton = document.createElement('button');
		updateButton.textContent = 'Update';
		updateButton.onclick = () => {
			this._messageHandler.postMessage({
				command: this._editCommand,
				args: {
					text: this._editingArea!.value,
					comment: this._comment
				}
			}).then(result => {
				this.finishEdit(result.text);
			}).catch(e => {
				this.finishEdit();
			});

			updateButton.textContent = 'Updating...';
			this._editingArea!.disabled = true;
			updateButton.disabled = true;
		};

		const buttons = document.createElement('div');
		buttons.className = 'form-actions';
		buttons.appendChild(cancelButton);
		buttons.appendChild(updateButton);

		this._editingContainer.appendChild(this._editingArea);
		this._editingContainer.appendChild(buttons);

		this._renderedComment.parentElement!.appendChild(this._editingContainer);
		this._editingArea.focus();
	}

	private finishEdit(text?: string): void {
		this._editingContainer!.remove();
		this._editingContainer = undefined;
		this._editingArea = undefined;

		this._renderedComment.classList.remove('hidden');
		this._actionsBar!.classList.remove('hidden');

		if (text) {
			this._comment.body = text;
			this._renderedComment.innerHTML = md.render(emoji.emojify(text));
		}
	}

	private delete(): void {
		this._messageHandler.postMessage({
			command: this._deleteCommand,
			args: this._comment
		}).then(_ => {
			this._container.remove();
			if (this._review) {
				this._review.deleteCommentFromReview(this._comment as Comment);
			}
		});
	}
}

class CommentNode {
	private _commentContainer: HTMLDivElement = document.createElement('div');
	private _commentBody: HTMLDivElement = document.createElement('div');
	private _actionsBar: ActionsBar | undefined;

	constructor(private _comment: Comment | CommentEvent,
		private _messageHandler: MessageHandler,
		private _review?: ReviewNode) { }

	render(): HTMLElement {
		this._commentContainer.classList.add('comment-container', 'comment');

		if (this._review) {
			this._commentContainer.classList.add('review-comment');
		}

		const userIcon = renderUserIcon(this._comment.user.html_url, this._comment.user.avatar_url);
		const reviewCommentContainer: HTMLDivElement = document.createElement('div');
		reviewCommentContainer.className = 'review-comment-container';
		this._commentContainer.appendChild(userIcon);
		this._commentContainer.appendChild(reviewCommentContainer);

		const commentHeader: HTMLDivElement = document.createElement('div');
		commentHeader.className = 'review-comment-header';
		const authorLink: HTMLAnchorElement = document.createElement('a');
		authorLink.className = 'author';
		authorLink.href = this._comment.user.html_url;
		authorLink.textContent = this._comment.user.login;

		const timestamp: HTMLAnchorElement = document.createElement('a');
		timestamp.className = 'timestamp';
		timestamp.href = this._comment.html_url;
		timestamp.textContent = moment(this._comment.created_at).fromNow();

		const commentState = document.createElement('span');
		commentState.textContent = 'commented';

		this._commentBody.className = 'comment-body';
		this._commentBody.innerHTML  = md.render(emoji.emojify(this._comment.body));

		commentHeader.appendChild(authorLink);
		commentHeader.appendChild(commentState);
		commentHeader.appendChild(timestamp);

		if (this._comment.canEdit || this._comment.canDelete) {
			this._actionsBar = new ActionsBar(this._commentContainer, this._comment as Comment, this._commentBody, this._messageHandler, 'pr.edit-comment', 'pr.delete-comment', this._review);
			const actionBarElement = this._actionsBar.render();
			this._actionsBar.registerActionBarListeners();
			commentHeader.appendChild(actionBarElement);
		}

		reviewCommentContainer.appendChild(commentHeader);
		reviewCommentContainer.appendChild(this._commentBody);

		return this._commentContainer;
	}
}

export function renderComment(comment: Comment | CommentEvent, messageHandler: MessageHandler, review?: ReviewNode): HTMLElement {
	const node = new CommentNode(comment, messageHandler, review);
	return node.render();
}

export function renderCommit(timelineEvent: CommitEvent): HTMLElement {
	const shaShort = timelineEvent.sha.substring(0, 7);

	const commentContainer: HTMLDivElement = document.createElement('div');
	commentContainer.classList.add('comment-container', 'commit');
	const commitMessage: HTMLDivElement = document.createElement('div');
	commitMessage.className = 'commit-message';

	commitMessage.insertAdjacentHTML('beforeend', commitIconSvg);

	const message: HTMLDivElement = document.createElement('div');
	message.className = 'message';
	if (timelineEvent.author.html_url && timelineEvent.author.avatar_url) {
		const userIcon = renderUserIcon(timelineEvent.author.html_url, timelineEvent.author.avatar_url);
		commitMessage.appendChild(userIcon);

		const login: HTMLAnchorElement = document.createElement('a');
		login.className = 'author';
		login.href = timelineEvent.author.html_url;
		login.textContent = timelineEvent.author.login!;
		commitMessage.appendChild(login);
		message.textContent = timelineEvent.message;
	} else {
		message.textContent = `${timelineEvent.author.name} ${timelineEvent.message}`;
	}

	commitMessage.appendChild(message);

	const sha: HTMLAnchorElement = document.createElement('a');
	sha.className = 'sha';
	sha.href = timelineEvent.html_url;
	sha.textContent = shaShort;

	commentContainer.appendChild(commitMessage);
	commentContainer.appendChild(sha);

	return commentContainer;
}

function getDiffChangeClass(type: DiffChangeType) {
	switch (type) {
		case DiffChangeType.Add:
			return 'add';
		case DiffChangeType.Delete:
			return 'delete';
		case DiffChangeType.Context:
			return 'context';
		case DiffChangeType.Context:
			return 'context';
		default:
			return 'control';
	}
}

export function renderReview(review: ReviewEvent, messageHandler: MessageHandler): HTMLElement | undefined {
	const reviewNode = new ReviewNode(review, messageHandler);
	return reviewNode.render();
}

class ReviewNode {
	private _commentContainer: HTMLDivElement | undefined;

	constructor(private _review: ReviewEvent, private _messageHandler: MessageHandler) { }

	deleteCommentFromReview(comment: Comment): void {
		const deletedCommentIndex = this._review.comments.findIndex(c => c.id.toString() === comment.id.toString());
		this._review.comments.splice(deletedCommentIndex, 1);

		if (!this._review.comments.length && !this._review.body) {
			if (this._commentContainer) {
				this._commentContainer.remove();
				this._commentContainer = undefined;
			}
			return;
		}

		const commentsOnSameThread = this._review.comments.filter(c => c.path === comment.path && c.position === comment.position && c.original_position === comment.original_position);
		if (!commentsOnSameThread.length) {
			const path = comment.path + ':' + (comment.position !== null ? `pos:${comment.position}` : `ori:${comment.original_position}`);
			const threadContainer = document.getElementById(path);
			if (threadContainer) {
				threadContainer.remove();
			}
		}

	}

	render(): HTMLElement | undefined {
		// Ignore pending or empty reviews
		const isEmpty = !this._review.body && !(this._review.comments && this._review.comments.length);
		if (this._review.state === 'pending' || isEmpty) {
			return undefined;
		}

		this._commentContainer = document.createElement('div');
		this._commentContainer.classList.add('comment-container', 'comment');
		const userIcon = renderUserIcon(this._review.user.html_url, this._review.user.avatar_url);
		const reviewCommentContainer = document.createElement('div');
		reviewCommentContainer.className = 'review-comment-container';
		this._commentContainer.appendChild(userIcon);
		this._commentContainer.appendChild(reviewCommentContainer);

		const commentHeader: HTMLDivElement = document.createElement('div');
		commentHeader.className = 'review-comment-header';

		const userLogin: HTMLAnchorElement = document.createElement('a');
		userLogin.href = this._review.user.html_url;
		userLogin.textContent = this._review.user.login;

		const reviewState = document.createElement('span');
		switch (this._review.state.toLowerCase()) {
			case 'approved':
				reviewState.textContent = ` approved these changes`;
				break;
			case 'commented':
				reviewState.textContent = ` reviewed`;
				break;
			case 'changes_requested':
				reviewState.textContent = ` requested changes`;
				break;
			default:
				break;
		}

		const timestamp: HTMLAnchorElement = document.createElement('a');
		timestamp.className = 'timestamp';
		timestamp.href = this._review.html_url;
		timestamp.textContent = moment(this._review.submitted_at).fromNow();

		commentHeader.appendChild(userLogin);
		commentHeader.appendChild(reviewState);
		commentHeader.appendChild(timestamp);

		const reviewBody: HTMLDivElement = document.createElement('div');
		reviewBody.className = 'review-body';
		if (this._review.body) {
			reviewBody.innerHTML = md.render(emoji.emojify(this._review.body));
		}

		reviewCommentContainer.appendChild(commentHeader);
		reviewCommentContainer.appendChild(reviewBody);

		if (this._review.comments) {
			const commentBody: HTMLDivElement = document.createElement('div');
			commentBody.className = 'comment-body';
			let groups = groupBy(this._review.comments, comment => comment.path + ':' + (comment.position !== null ? `pos:${comment.position}` : `ori:${comment.original_position}`));

			for (let path in groups) {
				let comments = groups[path];
				const threadContainer: HTMLSpanElement = document.createElement('span');
				threadContainer.id = path;

				if (comments && comments.length) {
					let diffLines: HTMLElement[] = [];

					for (let i = 0; i < comments[0].diff_hunks.length; i++) {
						diffLines = comments[0].diff_hunks[i].diffLines.slice(-4).map(diffLine => {
							const diffLineElement = document.createElement('div');
							diffLineElement.classList.add('diffLine',  getDiffChangeClass(diffLine.type));

							const oldLineNumber = document.createElement('span');
							oldLineNumber.textContent = diffLine.oldLineNumber > 0 ? diffLine.oldLineNumber.toString() : ' ';
							oldLineNumber.classList.add('lineNumber');

							const newLineNumber = document.createElement('span');
							newLineNumber.textContent = diffLine.newLineNumber > 0 ? diffLine.newLineNumber.toString() : ' ';
							newLineNumber.classList.add('lineNumber');

							const lineContent = document.createElement('span');
							lineContent.textContent = diffLine._raw;
							lineContent.classList.add('lineContent');

							diffLineElement.appendChild(oldLineNumber);
							diffLineElement.appendChild(newLineNumber);
							diffLineElement.appendChild(lineContent);

							return diffLineElement;
						});
					}

					const diffView: HTMLDivElement = document.createElement('div');
					diffView.className = 'diff';
					const diffHeader: HTMLDivElement = document.createElement('div');
					diffHeader.className = 'diffHeader';
					diffHeader.textContent = comments[0].path;

					diffView.appendChild(diffHeader);
					diffLines.forEach(line => diffView.appendChild(line));

					threadContainer.appendChild(diffView);
				}

				comments.map(comment => threadContainer.appendChild(renderComment(comment, this._messageHandler, this)));
				commentBody.appendChild(threadContainer);
			}

			reviewCommentContainer.appendChild(commentBody);
		}

		this._commentContainer.appendChild(userIcon);
		this._commentContainer.appendChild(reviewCommentContainer);

		return this._commentContainer;
	}
}

export function renderTimelineEvent(timelineEvent: TimelineEvent, messageHandler: MessageHandler): HTMLElement | undefined {
	switch (timelineEvent.event) {
		case EventType.Committed:
			return renderCommit((<CommitEvent>timelineEvent));
		case EventType.Commented:
			return renderComment((<CommentEvent>timelineEvent), messageHandler);
		case EventType.Reviewed:
			return renderReview(<ReviewEvent>timelineEvent, messageHandler);
		default:
			return undefined;
	}
}

export function getStatus(state: PullRequestStateEnum) {
	if (state === PullRequestStateEnum.Merged) {
		return 'Merged';
	} else if (state === PullRequestStateEnum.Open) {
		return 'Open';
	} else {
		return 'Closed';
	}
}
