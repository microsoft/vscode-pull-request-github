/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as moment from 'moment';
import md from './mdRenderer';
const emoji = require('node-emoji');

export enum DiffChangeType {
	Context,
	Add,
	Delete,
	Control
}

export class DiffLine {
	public get raw(): string {
		return this._raw;
	}

	public get text(): string {
		return this._raw.substr(1);
	}

	public endwithLineBreak: boolean = true;

	constructor(
		public type: DiffChangeType,
		public oldLineNumber: number, /* 1 based */
		public newLineNumber: number, /* 1 based */
		public positionInHunk: number,
		private _raw: string
	) { }
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

export function renderComment(comment: CommentEvent | Comment): string {
	return `<div class="comment-container" data-type="comment">

	<div class="review-comment" role="treeitem">
		<div class="review-comment-contents comment">
			<div class="avatar-container">
				<a class="avatar-link" href="${comment.user.html_url}"><img class="avatar" src="${comment.user.avatar_url}"></a>
			</div>
			<div class="review-comment-container">
				<div class="review-comment-header">
					<a class="author" href="${comment.user.html_url}">${comment.user.login}</a>
					<div class="timestamp">${moment(comment.created_at).fromNow()}</div>
				</div>
				<div class="comment-body">
					${md.render(emoji.emojify(comment.body))}
				</div>
			</div>
		</div>
	</div>
</div>`;
}

export function renderCommit(timelineEvent: CommitEvent): string {

	const shaShort = timelineEvent.sha.substring(0, 7);
	const avatar = timelineEvent.author.avatar_url
		? `<div class="avatar-container"><a class="avatar-link" href="${timelineEvent.author.html_url}"><img class="avatar" src="${timelineEvent.author.avatar_url}"></a></div>`
		: '';
	const login = timelineEvent.author.login
		? `<a class="author" href="${timelineEvent.author.html_url}">${timelineEvent.author.login}</a>`
		: timelineEvent.author.name;

	return `<div class="comment-container"  data-type="commit">

	<div class="review-comment" role="treeitem">
		<div class="review-comment-contents commit">
			<div class="commit">
				<div class="commit-message">
					<svg class="octicon octicon-git-commit" width="14" height="16" viewBox="0 0 14 16" fill="none" xmlns="http://www.w3.org/2000/svg">
						<path fill-rule="evenodd" clip-rule="evenodd" d="M10.86 3C10.41 1.28 8.86 0 7 0C5.14 0 3.59 1.28 3.14 3H0V5H3.14C3.59 6.72 5.14 8 7 8C8.86 8 10.41 6.72 10.86 5H14V3H10.86V3ZM7 6.2C5.78 6.2 4.8 5.22 4.8 4C4.8 2.78 5.78 1.8 7 1.8C8.22 1.8 9.2 2.78 9.2 4C9.2 5.22 8.22 6.2 7 6.2V6.2Z" transform="translate(0 4)"/>
					</svg>
					${avatar}
					<div class="message">
						${login} ${timelineEvent.message}
					</div>
				</div>
				<a class="sha" href="${timelineEvent.html_url}">${shaShort}</a>
			</div>
		</div>
	</div>
</div>`;
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

export function renderReview(timelineEvent: ReviewEvent): string {
	if (timelineEvent.state === 'pending') {
		return '';
	}

	let reviewState = '';
	switch (timelineEvent.state.toLowerCase()) {
		case 'approved':
			reviewState = `<span><a href="${timelineEvent.user.html_url}">${timelineEvent.user.login}</a> approved these changes</span>`;
			break;
		case 'commented':
			reviewState = `<span><a href="${timelineEvent.user.html_url}">${timelineEvent.user.login}</a> reviewed</span>`;
			break;
		case 'changes_requested':
			reviewState = `<span><a href="${timelineEvent.user.html_url}">${timelineEvent.user.login}</a> requested changes</span>`;
			break;
		default:
			break;
	}

	let reviewBody = timelineEvent.body ? `${md.render(emoji.emojify(timelineEvent.body))}` : '';

	let body = '';
	if (timelineEvent.comments) {
		let groups = groupBy(timelineEvent.comments, comment => comment.path + ':' + (comment.position !== null ? `pos:${comment.position}` : `ori:${comment.original_position}`));

		for (let path in groups) {
			let comments = groups[path];
			let diffView = '';
			let diffLines: string[] = [];
			if (comments && comments.length) {
				for (let i = 0; i < comments[0].diff_hunks.length; i++) {
					diffLines = comments[0].diff_hunks[i].diffLines.slice(-4).map(diffLine => {
						const diffLineElement = document.createElement('div');
						diffLineElement.classList.add(...['diffLine',  getDiffChangeClass(diffLine.type)]);

						const oldLineNumber = document.createElement('span');
						oldLineNumber.textContent = diffLine.oldLineNumber > 0 ? diffLine.oldLineNumber.toString() : ' ';
						oldLineNumber.classList.add('lineNumber');

						const newLineNumber = document.createElement('span');
						newLineNumber.textContent = diffLine.newLineNumber > 0 ? diffLine.newLineNumber.toString() : ' ';
						newLineNumber.classList.add('lineNumber');

						const lineContent = document.createElement('span');
						lineContent.textContent = (diffLine as any)._raw;
						lineContent.classList.add('lineContent');

						diffLineElement.appendChild(oldLineNumber);
						diffLineElement.appendChild(newLineNumber);
						diffLineElement.appendChild(lineContent);

						return diffLineElement.outerHTML;
					});
				}

				diffView = `<div class="diff">
					<div class="diffHeader">${comments[0].path}</div>
					${diffLines.join('')}
				</div>`;
			}

			body += `
				${diffView}
				<div data-type="review-comment">${ comments && comments.length ? comments.map(comment => renderComment(comment)).join('') : ''}</div>
			`;
		}
	}

	return `<div class="comment-container"  data-type="review">

	<div class="review-comment" role="treeitem">

		<div class="review-comment-contents review">
			<div class="avatar-container">
				<a class="avatar-link" href="${timelineEvent.user.html_url}"><img class="avatar" src="${timelineEvent.user.avatar_url}"></a>
			</div>
			<div class="review-comment-container">
				<div class="review-comment-header">
					${reviewState}
					<div class="timestamp">${moment(timelineEvent.submitted_at).fromNow()}</div>
				</div>
				<div class="review-body">
					${reviewBody}
				</div>
				<div class="comment-body">
					${body}
				</div>
			</div>
		</div>

	</div>
</div>`;
}

export function renderTimelineEvent(timelineEvent: TimelineEvent): string {
	switch (timelineEvent.event) {
		case EventType.Committed:
			return renderCommit((<CommitEvent>timelineEvent));
		case EventType.Commented:
			return renderComment((<CommentEvent>timelineEvent));
		case EventType.Reviewed:
			return renderReview((<ReviewEvent>timelineEvent));
	}
	return '';
}

export function getStatusBGCoor(state: PullRequestStateEnum) {
	if (state === PullRequestStateEnum.Merged) {
		return '#6f42c1';
	} else if (state === PullRequestStateEnum.Open) {
		return '#2cbe4e';
	} else {
		return '#cb2431';
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