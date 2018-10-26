/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as moment from 'moment';
import md from './mdRenderer';
const commitIconSvg = require('../resources/icons/commit_icon.svg');
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
export interface Comment {
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

export function renderComment(comment: CommentEvent | Comment, additionalClass?: string): HTMLElement {
	const commentContainer: HTMLDivElement = document.createElement('div');
	commentContainer.id = `comment${comment.id.toString()}`;
	commentContainer.classList.add('comment-container', 'comment');

	if (additionalClass) {
		commentContainer.classList.add(additionalClass);
	}

	const userIcon = renderUserIcon(comment.user.html_url, comment.user.avatar_url);
	const reviewCommentContainer: HTMLDivElement = document.createElement('div');
	reviewCommentContainer.className = 'review-comment-container';
	commentContainer.appendChild(userIcon);
	commentContainer.appendChild(reviewCommentContainer);

	const commentHeader: HTMLDivElement = document.createElement('div');
	commentHeader.className = 'review-comment-header';
	const authorLink: HTMLAnchorElement = document.createElement('a');
	authorLink.className = 'author';
	authorLink.href = comment.user.html_url;
	authorLink.textContent = comment.user.login;

	const timestamp: HTMLAnchorElement = document.createElement('a');
	timestamp.className = 'timestamp';
	timestamp.href = comment.html_url;
	timestamp.textContent = moment(comment.created_at).fromNow();

	const commentBody: HTMLDivElement = document.createElement('div');
	commentBody.className = 'comment-body';
	commentBody.innerHTML  = md.render(emoji.emojify(comment.body));

	commentHeader.appendChild(authorLink);
	commentHeader.appendChild(timestamp);

	reviewCommentContainer.appendChild(commentHeader);
	reviewCommentContainer.appendChild(commentBody);

	return commentContainer;
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

export function renderReview(timelineEvent: ReviewEvent): HTMLElement | undefined {
	if (timelineEvent.state === 'pending') {
		return undefined;
	}

	const commentContainer: HTMLDivElement = document.createElement('div');
	commentContainer.classList.add('comment-container', 'comment');
	const userIcon = renderUserIcon(timelineEvent.user.html_url, timelineEvent.user.avatar_url);
	const reviewCommentContainer: HTMLDivElement = document.createElement('div');
	reviewCommentContainer.className = 'review-comment-container';
	commentContainer.appendChild(userIcon);
	commentContainer.appendChild(reviewCommentContainer);

	const commentHeader: HTMLDivElement = document.createElement('div');
	commentHeader.className = 'review-comment-header';

	const userLogin: HTMLAnchorElement = document.createElement('a');
	userLogin.href = timelineEvent.user.html_url;
	userLogin.textContent = timelineEvent.user.login;

	const reviewState = document.createElement('span');
	switch (timelineEvent.state.toLowerCase()) {
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
	timestamp.textContent = moment(timelineEvent.submitted_at).fromNow();
	timestamp.href = timelineEvent.html_url;

	commentHeader.appendChild(userLogin);
	commentHeader.appendChild(reviewState);
	commentHeader.appendChild(timestamp);

	const reviewBody: HTMLDivElement = document.createElement('div');
	reviewBody.className = 'review-body';
	if (timelineEvent.body) {
		reviewBody.innerHTML = md.render(emoji.emojify(timelineEvent.body));
	}

	reviewCommentContainer.appendChild(commentHeader);
	reviewCommentContainer.appendChild(reviewBody);

	if (timelineEvent.comments) {
		const commentBody: HTMLDivElement = document.createElement('div');
		commentBody.className = 'comment-body';
		let groups = groupBy(timelineEvent.comments, comment => comment.path + ':' + (comment.position !== null ? `pos:${comment.position}` : `ori:${comment.original_position}`));

		for (let path in groups) {
			let comments = groups[path];

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

				commentBody.appendChild(diffView);
			}

			comments.map(comment => commentBody.appendChild(renderComment(comment, 'review-comment')));
		}

		reviewCommentContainer.appendChild(commentBody);
	}

	commentContainer.appendChild(userIcon);
	commentContainer.appendChild(reviewCommentContainer);

	return commentContainer;
}

export function renderTimelineEvent(timelineEvent: TimelineEvent): HTMLElement | undefined {
	switch (timelineEvent.event) {
		case EventType.Committed:
			return renderCommit((<CommitEvent>timelineEvent));
		case EventType.Commented:
			return renderComment((<CommentEvent>timelineEvent));
		case EventType.Reviewed:
			return renderReview((<ReviewEvent>timelineEvent));
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
