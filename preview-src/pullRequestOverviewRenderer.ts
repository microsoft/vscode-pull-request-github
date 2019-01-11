/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dateFromNow } from '../src/common/utils';
import { TimelineEvent, CommitEvent, ReviewEvent, CommentEvent, isCommentEvent, isReviewEvent, isCommitEvent } from '../src/common/timelineEvent';
import { PullRequestStateEnum } from '../src/github/interface';
import md from './mdRenderer';
import { MessageHandler } from './message';
import { getState, updateState, PullRequest } from './cache';
import { Comment } from '../src/common/comment';

const commitIconSvg = require('../resources/icons/commit_icon.svg');
const editIcon = require('../resources/icons/edit.svg');
const deleteIcon = require('../resources/icons/delete.svg');
const checkIcon = require('../resources/icons/check.svg');
const dotIcon = require('../resources/icons/dot.svg');

const emoji = require('node-emoji');

export enum DiffChangeType {
	Context,
	Add,
	Delete,
	Control
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

function groupBy<T>(arr: T[], fn: (el: T) => string): { [key: string]: T[] } {
	return arr.reduce((result, el) => {
		const key = fn(el);
		result[key] = [...(result[key] || []), el];
		return result;
	}, Object.create(null));
}

function getSummaryLabel(statuses: any[]) {
	const statusTypes = groupBy(statuses, (status: any) => status.state);
	let statusPhrases = [];
	for (let statusType of Object.keys(statusTypes)) {
		const numOfType = statusTypes[statusType].length;
		let statusAdjective = '';

		switch (statusType) {
			case 'success':
				statusAdjective = 'successful';
				break;
			case 'failure':
				statusAdjective = 'failed';
				break;
			default:
				statusAdjective = 'pending';
		}

		const status = numOfType > 1
			? `${numOfType} ${statusAdjective} checks`
			: `${numOfType} ${statusAdjective} check`;

		statusPhrases.push(status);
	}

	return statusPhrases.join(' and ');
}

function getStateIcon(state: string) {
	if (state === 'success') {
		return checkIcon;
	} else if (state === 'failure') {
		return deleteIcon;
	} else {
		return dotIcon;
	}
}

export function renderStatusChecks(pr: PullRequest) {
	const statusContainer = document.getElementById('status-checks') as HTMLDivElement;
	statusContainer.innerHTML = '';

	const { status, mergeable } = pr;

	const statusCheckInformationContainer = document.createElement('div');

	const statusSummary = document.createElement('div');
	statusSummary.classList.add('status-item');
	const statusSummaryIcon = document.createElement('div');
	const statusSummaryText = document.createElement('div');
	statusSummaryIcon.innerHTML = getStateIcon(status.state);
	statusSummary.appendChild(statusSummaryIcon);
	statusSummaryText.textContent = getSummaryLabel(status.statuses);
	statusSummary.appendChild(statusSummaryText);
	statusCheckInformationContainer.appendChild(statusSummary);

	const statusesToggle = document.createElement('a');
	statusesToggle.setAttribute('aria-role', 'button');
	statusesToggle.textContent = status.state === 'success' ? 'Show' : 'Hide';
	statusesToggle.addEventListener('click', () => {
		if (statusList.classList.contains('hidden')) {
			statusList.classList.remove('hidden');
			statusesToggle.textContent = 'Hide';
		} else {
			statusList.classList.add('hidden');
			statusesToggle.textContent = 'Show';
		}
	});

	statusSummary.appendChild(statusesToggle);

	if (!status.statuses.length) {
		statusCheckInformationContainer.classList.add('hidden');
	}

	const statusList = document.createElement('div');
	if (status.state === 'success') {
		statusList.classList.add('hidden');
	}
	statusCheckInformationContainer.appendChild(statusList);
	statusContainer.appendChild(statusCheckInformationContainer);

	status.statuses.forEach(s => {
		const statusElement: HTMLDivElement = document.createElement('div');
		statusElement.className = 'status-check';

		const state: HTMLSpanElement = document.createElement('span');
		state.innerHTML = getStateIcon(s.state);

		statusElement.appendChild(state);

		const statusIcon = renderUserIcon(s.url, s.avatar_url);
		statusElement.appendChild(statusIcon);

		const statusDescription = document.createElement('span');
		statusDescription.textContent = `${s.context} - ${s.description}`;
		statusElement.appendChild(statusDescription);

		statusList.appendChild(statusElement);
	});

	const mergeableSummary = document.createElement('div');
	mergeableSummary.classList.add('status-item');
	const mergeableSummaryIcon = document.createElement('div');
	const mergeableSummaryText = document.createElement('div');
	mergeableSummaryIcon.innerHTML = mergeable ? checkIcon : deleteIcon;
	mergeableSummary.appendChild(mergeableSummaryIcon);
	mergeableSummaryText.textContent = mergeable ? 'This branch has no conflicts with the base branch' : 'This branch has conflicts that must be resolved';
	mergeableSummary.appendChild(mergeableSummaryText);
	statusContainer.appendChild(mergeableSummary);
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

export interface ActionData {
	body: string;
	id: string;
}

export class ActionsBar {
	private _actionsBar: HTMLDivElement | undefined;
	private _editingContainer: HTMLDivElement | undefined;
	private _editingArea: HTMLTextAreaElement | undefined;
	private _updateStateTimer: number = -1;

	constructor(private _container: HTMLElement,
		private _data: ActionData | Comment,
		private _renderedComment: HTMLElement,
		private _messageHandler: MessageHandler,
		private _updateHandler: (value: any) => void,
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

	startEdit(text?: string): void {
		this._actionsBar!.classList.add('hidden');
		this._editingContainer = document.createElement('div');
		this._editingContainer.className = 'editing-form';
		this._editingArea = document.createElement('textarea');
		this._editingArea.value = text || this._data.body;

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
					comment: this._data
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

		this._editingArea.addEventListener('input', (e) => {
			const inputText = (<HTMLInputElement>e.target).value;

			if (this._updateStateTimer) {
				clearTimeout(this._updateStateTimer);
			}

			this._updateStateTimer = window.setTimeout(() => {
				let pullRequest = getState();
				const pendingCommentDrafts = pullRequest.pendingCommentDrafts || Object.create(null);
				pendingCommentDrafts[this._data.id] = inputText;
				updateState({ pendingCommentDrafts: pendingCommentDrafts });
			}, 500);
		});
	}

	private finishEdit(text?: string): void {
		this._editingContainer!.remove();
		this._editingContainer = undefined;
		this._editingArea = undefined;

		this._renderedComment.classList.remove('hidden');
		this._actionsBar!.classList.remove('hidden');

		if (text !== undefined) {
			this._data.body = text;
			this._renderedComment.innerHTML = md.render(emoji.emojify(text));
			this._updateHandler(text);
		}

		clearTimeout(this._updateStateTimer);

		let pullRequest = getState();
		const pendingCommentDrafts = pullRequest.pendingCommentDrafts;
		if (pendingCommentDrafts) {
			delete pendingCommentDrafts[this._data.id];
			updateState({ pendingCommentDrafts: pendingCommentDrafts });
		}
	}

	private delete(): void {
		this._messageHandler.postMessage({
			command: this._deleteCommand,
			args: this._data
		}).then(_ => {
			this._container.remove();
			if (this._review) {
				this._review.deleteCommentFromReview(this._data as Comment);
			}

			const pullRequest = getState();
			const index = pullRequest.events.findIndex(event => isCommentEvent(event) && event.id.toString() === this._data.id.toString());
			pullRequest.events.splice(index, 1);
			updateState({ events: pullRequest.events });
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

		const userIcon = renderUserIcon(this._comment.user.url, this._comment.user.avatarUrl);
		const reviewCommentContainer: HTMLDivElement = document.createElement('div');
		reviewCommentContainer.className = 'review-comment-container';

		this._commentContainer.appendChild(reviewCommentContainer);

		const commentHeader: HTMLDivElement = document.createElement('div');
		commentHeader.className = 'review-comment-header';
		const authorLink: HTMLAnchorElement = document.createElement('a');
		authorLink.className = 'author';
		authorLink.href = this._comment.user.url;
		authorLink.textContent = this._comment.user.login;

		commentHeader.appendChild(userIcon);
		commentHeader.appendChild(authorLink);

		const isPending = this._review && this._review.isPending();
		if (isPending) {
			const pendingTag = document.createElement('a');
			pendingTag.className = 'pending';
			pendingTag.href = this._comment.htmlUrl;
			pendingTag.textContent = 'Pending';

			commentHeader.appendChild(pendingTag);
		} else {
			const timestamp: HTMLAnchorElement = document.createElement('a');
			timestamp.className = 'timestamp';
			timestamp.href = this._comment.htmlUrl;
			timestamp.textContent = dateFromNow(this._comment.createdAt);

			const commentState = document.createElement('span');
			commentState.textContent = 'commented';

			commentHeader.appendChild(commentState);
			commentHeader.appendChild(timestamp);
		}

		this._commentBody.className = 'comment-body';

		this._commentBody.innerHTML  = this._comment.bodyHTML ? this._comment.bodyHTML :  md.render(emoji.emojify(this._comment.body));

		if (this._comment.canEdit || this._comment.canDelete) {
			this._actionsBar = new ActionsBar(this._commentContainer, this._comment as Comment, this._commentBody, this._messageHandler, (e) => { }, 'pr.edit-comment', 'pr.delete-comment', this._review);
			const actionBarElement = this._actionsBar.render();
			this._actionsBar.registerActionBarListeners();
			commentHeader.appendChild(actionBarElement);
		}

		reviewCommentContainer.appendChild(commentHeader);
		reviewCommentContainer.appendChild(this._commentBody);

		if (this._comment.body && this._comment.body.indexOf('```diff') > -1) {
			const replyButton = document.createElement('button');
			replyButton.textContent = 'Apply Patch';
			replyButton.onclick = _ => {
				this._messageHandler.postMessage({
					command: 'pr.apply-patch',
					args: {
						comment: this._comment
					}
				});
			};

			this._commentBody.appendChild(replyButton);
		}

		return this._commentContainer;
	}

	startEdit(text?: string): void {
		if (this._actionsBar) {
			this._actionsBar.startEdit(text);
		}
	}
}

export function renderComment(comment: Comment | CommentEvent, messageHandler: MessageHandler, review?: ReviewNode): HTMLElement {
	const node = new CommentNode(comment, messageHandler, review);
	const { pendingCommentDrafts } = getState();
	const rendered = node.render();

	if (pendingCommentDrafts) {
		let text = pendingCommentDrafts[comment.id];
		if (pendingCommentDrafts[comment.id]) {
			node.startEdit(text);
		}
	}

	return rendered;
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
	if (timelineEvent.author && timelineEvent.author.url && timelineEvent.author.avatarUrl) {
		const userIcon = renderUserIcon(timelineEvent.author.url, timelineEvent.author.avatarUrl);
		commitMessage.appendChild(userIcon);

		const login: HTMLAnchorElement = document.createElement('a');
		login.className = 'author';
		login.href = timelineEvent.author.url;
		login.textContent = timelineEvent.author.login!;
		commitMessage.appendChild(login);
		message.textContent = timelineEvent.message;
	} else {
		message.textContent = `${timelineEvent.author.login} ${timelineEvent.message}`;
	}

	commitMessage.appendChild(message);

	const sha: HTMLAnchorElement = document.createElement('a');
	sha.className = 'sha';
	sha.href = timelineEvent.htmlUrl;
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

	isPending(): boolean {
		return this._review.state === 'pending';
	}

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

		const commentsOnSameThread = this._review.comments.filter(c => c.path === comment.path && c.position === comment.position && c.originalPosition === comment.originalPosition);
		if (!commentsOnSameThread.length) {
			const path = comment.path + ':' + (comment.position !== null ? `pos:${comment.position}` : `ori:${comment.originalPosition}`);
			const threadContainer = document.getElementById(path);
			if (threadContainer) {
				threadContainer.remove();
			}
		}

	}

	render(): HTMLElement | undefined {
		// Ignore pending or empty reviews
		const isEmpty = !this._review.body && !(this._review.comments && this._review.comments.length);

		this._commentContainer = document.createElement('div');
		this._commentContainer.classList.add('comment-container', 'comment');
		const userIcon = renderUserIcon(this._review.user.url, this._review.user.avatarUrl);

		const commentHeader: HTMLDivElement = document.createElement('div');
		commentHeader.className = 'review-comment-header';

		const userLogin: HTMLAnchorElement = document.createElement('a');
		userLogin.href = this._review.user.url;
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
		timestamp.href = this._review.htmlUrl;
		const isPending = this.isPending();
		timestamp.textContent = isPending ? 'Pending' : dateFromNow(this._review.submittedAt);

		if (isPending) {
			timestamp.classList.add('pending');
		}

		commentHeader.appendChild(userIcon);
		commentHeader.appendChild(userLogin);
		commentHeader.appendChild(reviewState);
		commentHeader.appendChild(timestamp);

		const reviewCommentContainer = document.createElement('div');
		reviewCommentContainer.className = 'review-comment-container';
		this._commentContainer.appendChild(reviewCommentContainer);
		reviewCommentContainer.appendChild(commentHeader);

		if (isEmpty) {
			return this._commentContainer;
		}

		const reviewBody: HTMLDivElement = document.createElement('div');
		reviewBody.className = 'review-body';
		if (this._review.body) {
			reviewBody.innerHTML = md.render(emoji.emojify(this._review.body));
			reviewCommentContainer.appendChild(reviewBody);
		}

		if (this._review.comments) {
			const commentBody: HTMLDivElement = document.createElement('div');
			commentBody.classList.add('comment-body', 'review-comment-body');
			let groups = groupBy(this._review.comments, comment => comment.path + ':' + (comment.position !== null ? `pos:${comment.position}` : `ori:${comment.originalPosition}`));

			for (let path in groups) {
				let comments = groups[path];
				const threadContainer: HTMLDivElement = document.createElement('div');
				threadContainer.id = path;
				threadContainer.className = 'diff-container';

				if (comments && comments.length) {
					let diffLines: HTMLElement[] = [];

					for (let i = 0; i < comments[0].diffHunks.length; i++) {
						diffLines = comments[0].diffHunks[i].diffLines.slice(-4).map(diffLine => {
							const diffLineElement = document.createElement('div');
							diffLineElement.classList.add('diffLine',  getDiffChangeClass(diffLine.type));

							const oldLineNumber = document.createElement('span');
							oldLineNumber.textContent = diffLine.oldLineNumber > 0 ? diffLine.oldLineNumber.toString() : ' ';
							oldLineNumber.classList.add('lineNumber');

							const newLineNumber = document.createElement('span');
							newLineNumber.textContent = diffLine.newLineNumber > 0 ? diffLine.newLineNumber.toString() : ' ';
							newLineNumber.classList.add('lineNumber');

							const lineContent = document.createElement('span');
							lineContent.textContent = (diffLine as any)._raw; // the getter function has been stripped, directly access property
							lineContent.classList.add('lineContent');

							diffLineElement.appendChild(oldLineNumber);
							diffLineElement.appendChild(newLineNumber);
							diffLineElement.appendChild(lineContent);

							return diffLineElement;
						});
					}

					let outdated = comments[0].position === null;

					const diffView: HTMLDivElement = document.createElement('div');
					diffView.className = 'diff';
					const diffHeader: HTMLDivElement = document.createElement('div');
					diffHeader.className = 'diffHeader';
					const diffPath: HTMLSpanElement = document.createElement('span');
					diffPath.className =  outdated ? 'diffPath outdated' : 'diffPath';
					diffPath.textContent = comments[0].path;
					diffHeader.appendChild(diffPath);

					if (outdated) {
						const outdatedLabel: HTMLSpanElement = document.createElement('span');
						outdatedLabel.className = 'outdatedLabel';
						outdatedLabel.textContent = 'Outdated';
						diffHeader.appendChild(outdatedLabel);
					} else {
						diffPath.addEventListener('click', () => this.openDiff(comments[0]));
					}

					diffView.appendChild(diffHeader);
					diffLines.forEach(line => diffView.appendChild(line));

					threadContainer.appendChild(diffView);
				}

				comments.map(comment => threadContainer.appendChild(renderComment(comment, this._messageHandler, this)));
				commentBody.appendChild(threadContainer);
			}

			reviewCommentContainer.appendChild(commentBody);
		}

		return this._commentContainer;
	}

	openDiff(comment: Comment) {
		this._messageHandler.postMessage({
			command: 'pr.open-diff',
			args: {
				comment: comment
			}
		});
	}
}

export function renderTimelineEvent(timelineEvent: TimelineEvent, messageHandler: MessageHandler): HTMLElement | undefined {
	if (isReviewEvent(timelineEvent)) {
		return renderReview(timelineEvent, messageHandler);
	}

	if (isCommitEvent(timelineEvent)) {
		return renderCommit(timelineEvent);
	}

	if (isCommentEvent(timelineEvent)) {
		return renderComment(timelineEvent, messageHandler);
	}

	return undefined;
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
