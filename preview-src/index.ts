/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import './index.css';
import * as debounce from 'debounce';
import { dateFromNow } from '../src/common/utils';
import { EventType, isReviewEvent } from '../src/common/timelineEvent';
import { PullRequestStateEnum, ReviewState, ILabel } from '../src/github/interface';
import { renderTimelineEvent, getStatus, renderComment, renderReview, ActionsBar, renderStatusChecks, updatePullRequestState, ElementIds, renderUserIcon } from './pullRequestOverviewRenderer';

import { getMessageHandler } from './message';
import { getState, setState, PullRequest, updateState } from './cache';

const plusIcon = require('../resources/icons/plus.svg');
const deleteIcon = require('../resources/icons/delete.svg');

const pendingIcon = require('../resources/icons/dot.svg');
const checkIcon = require('../resources/icons/check.svg');
const commentIcon = require('../resources/icons/comment.svg');
const diffIcon = require('../resources/icons/diff.svg');

window.onload = () => {
	const pullRequest = getState();
	if (pullRequest && Object.keys(pullRequest).length) {
		renderPullRequest(pullRequest);
	}
};

const messageHandler = getMessageHandler(message => {
	switch (message.command) {
		case 'pr.initialize':
			const pullRequest = message.pullrequest;
			setState(pullRequest);
			renderPullRequest(pullRequest);
			break;
		case 'update-state':
			updatePullRequestState(message.state);
			break;
		case 'pr.update-checkout-status':
			updateCheckoutButton(message.isCurrentlyCheckedOut);
			break;
		case 'pr.enable-exit':
			(<HTMLButtonElement>document.getElementById(ElementIds.CheckoutDefaultBranch)).disabled = false;
			break;
		case 'set-scroll':
			window.scrollTo(message.scrollPosition.x, message.scrollPosition.y);
		default:
			break;
	}
});

function renderPullRequest(pr: PullRequest): void {
	renderTimelineEvents(pr);
	setTitleHTML(pr);
	setTextArea();
	renderStatusChecks(pr, messageHandler);
	renderReviewers(pr);
	renderLabels(pr);
	updateCheckoutButton(pr.isCurrentlyCheckedOut);
	updatePullRequestState(pr.state);

	addEventListeners(pr);
}

function renderTimelineEvents(pr: PullRequest): void {
	const timelineElement = document.getElementById(ElementIds.TimelineEvents)!;
	timelineElement.innerHTML = '';
	pr.events
		.map(event => renderTimelineEvent(event, messageHandler, pr))
		.filter(event => event !== undefined)
		.forEach(renderedEvent => timelineElement.appendChild(renderedEvent as HTMLElement));
}

function renderSection(containerId: string, label: string, addCommand: string, renderItems: (newItems?: any[]) => HTMLElement[]): void {
	const container = document.getElementById(containerId);
	container.innerHTML = '';

	const sectionLabel = document.createElement('div');
	sectionLabel.className = 'section-header';

	const sectionText = document.createElement('div');
	sectionText.textContent = label;
	sectionLabel.appendChild(sectionText);

	const addButton = document.createElement('button');
	addButton.innerHTML = plusIcon;
	addButton.title = `Add ${label}`;
	addButton.addEventListener('click', () => {
		messageHandler.postMessage({
			command: addCommand
		}).then(message => {
			const updatedItems = renderItems(message.added);
			sectionContent.innerHTML = '';
			updatedItems.forEach(item => sectionContent.appendChild(item));
		});
	});
	sectionLabel.appendChild(addButton);

	const sectionContent = document.createElement('div');
	sectionContent.className = 'section-content';

	container.appendChild(sectionLabel);
	container.appendChild(sectionContent);

	const items = renderItems();
	items.forEach(item => sectionContent.appendChild(item));
}

function getReviewStateElement(state: string): HTMLElement {
	const reviewState = document.createElement('div');

	switch (state) {
		case 'REQUESTED':
			reviewState.innerHTML = pendingIcon;
			reviewState.title = 'Awaiting requested review';
			break;
		case 'COMMENTED':
			reviewState.innerHTML = commentIcon;
			reviewState.title = 'Left review comments';
			break;
		case 'APPROVED':
			reviewState.innerHTML = checkIcon;
			reviewState.title = 'Approved these changes';
			break;
		case 'CHANGES_REQUESTED':
			reviewState.innerHTML = diffIcon;
			reviewState.title = 'Requested changes';
			break;
	}
	return reviewState;
}

function renderDeleteButton(label: string, command: string, args: any, update: () => void): HTMLElement {
	const deleteButton = document.createElement('button');
	deleteButton.innerHTML = deleteIcon;
	deleteButton.className = 'hidden';
	deleteButton.title = `Remove ${label}`;
	deleteButton.addEventListener('click', () => {
		messageHandler.postMessage({ command, args }).then(_ => update());
	});

	return deleteButton;
}

function renderReviewers(pr: PullRequest): void {
	renderSection('reviewers', 'Reviewers',
		'pr.add-reviewers',
		(newItems?: ReviewState[]): HTMLElement[] => {
			if (newItems) {
				pr.reviewers = pr.reviewers.concat(newItems);
				updateState({ reviewers: pr.reviewers });
			}

			return pr.reviewers.map((reviewer, i) => {
				const reviewerElement = document.createElement('div');
				reviewerElement.classList.add('section-item', 'reviewer');

				const userIcon = renderUserIcon(reviewer.reviewer.url, reviewer.reviewer.avatarUrl);
				reviewerElement.appendChild(userIcon);

				const userName = document.createElement('div');
				userName.className = 'login';
				reviewerElement.appendChild(userName);
				userName.textContent = reviewer.reviewer.login;

				const reviewState = getReviewStateElement(reviewer.state);
				reviewerElement.appendChild(reviewState);

				if (reviewer.state === 'REQUESTED') {
					const deleteButton = renderDeleteButton('reviewer', 'pr.remove-reviewer', reviewer.reviewer.login, () => {
						pr.reviewers.splice(i, 1);
						updateState({ reviewers: pr.reviewers });
						reviewerElement.remove();
					});
					reviewerElement.appendChild(deleteButton);

					reviewerElement.addEventListener('mouseover', () => {
						deleteButton.classList.remove('hidden');
						placeholder.classList.add('hidden');
					});

					reviewerElement.addEventListener('mouseout', () => {
						deleteButton.classList.add('hidden');
						placeholder.classList.remove('hidden');
					});
				}

				const placeholder = document.createElement('div');
				placeholder.classList.add('placeholder');
				reviewerElement.appendChild(placeholder);

				return reviewerElement;
			});
	});
}

function renderLabels(pr: PullRequest): void {
	renderSection('labels', 'Labels',
		'pr.add-labels',
		(newItems?: ILabel[]): HTMLElement[] => {
			if (newItems) {
				pr.labels = pr.labels.concat(newItems);
				updateState({ labels: pr.labels });
			}

			return pr.labels.map((label, i) => {
				const labelElement = document.createElement('div');
				labelElement.textContent = label.name;
				labelElement.classList.add('label', 'section-item');

				const deleteButton = renderDeleteButton('label', 'pr.remove-label', label.name, () => {
					pr.labels.splice(i, 1);
					updateState({ labels: pr.labels });
					labelElement.remove();
				});
				labelElement.appendChild(deleteButton);
				labelElement.addEventListener('mouseover', () => {
					deleteButton.classList.remove('hidden');
				});

				labelElement.addEventListener('mouseout', () => {
					deleteButton.classList.add('hidden');
				});

				return labelElement;
			});
		});
}

function setTitleHTML(pr: PullRequest): void {
	document.getElementById('title')!.innerHTML = `
			<div id="details" class="details">
				<div id="overview-title" class="overview-title">
					<div class="button-group">
						<button id="${ElementIds.Checkout}" aria-live="polite"></button>
						<button id="${ElementIds.CheckoutDefaultBranch}" aria-live="polite">Exit Review Mode</button>
						<button id="${ElementIds.Refresh}">Refresh</button>
					</div>
				</div>
				<div class="subtitle">
					<div id="${ElementIds.Status}">${getStatus(pr.state)}</div>
					<img class="avatar" src="${pr.author.avatarUrl}" alt="">
					<span class="author"><a href="${pr.author.url}">${pr.author.login}</a> wants to merge changes from <code>${pr.head}</code> to <code>${pr.base}</code>.</span>
					<span class="created-at">Created <a href=${pr.url} class="timestamp">${dateFromNow(pr.createdAt)}</a></span>
				</div>
			</div>
		`;

	const title = renderTitle(pr);
	(document.getElementById('overview-title')! as any).prepend(title);

	renderDescription(pr);
}

function renderTitle(pr: PullRequest): HTMLElement {
	const titleContainer = document.createElement('h2');
	titleContainer.classList.add('title-container');

	const titleHeader = document.createElement('div');
	titleHeader.classList.add('description-header');

	const title = document.createElement('span');
	title.classList.add('title-text');
	title.textContent = pr.title;

	const prNumber = document.createElement('span');
	prNumber.innerHTML = `(<a href=${pr.url}>#${pr.number}</a>)`;

	if (pr.canEdit) {
		function updateTitle(text: string) {
			pr.title = text;
			updateState({ title: text });
			title.textContent = text;
		}

		const actionsBar = new ActionsBar(
			titleContainer,
			{
				body: pr.title,
				id: pr.number.toString()
			},
			title,
			messageHandler,
			updateTitle,
			'pr.edit-title',
			undefined,
			undefined,
			[prNumber]
			);

		const renderedActionsBar = actionsBar.render();
		actionsBar.registerActionBarListeners();
		titleHeader.appendChild(renderedActionsBar);

		if (pr.pendingCommentDrafts && pr.pendingCommentDrafts[pr.number]) {
			actionsBar.startEdit(pr.pendingCommentDrafts[pr.number]);
		}

		title.addEventListener('click', () => {
			actionsBar.startEdit();
		});
	}

	titleContainer.appendChild(titleHeader);
	titleContainer.appendChild(title);
	titleContainer.appendChild(prNumber);

	return titleContainer;
}

function renderDescription(pr: PullRequest): void {
	const descriptionNode = document.getElementById('description');
	descriptionNode.innerHTML = '';
	const bodyHTML = !pr.body ? '<i>No description provided</i>' : pr.bodyHTML;
	const descriptionElement = renderComment({
		htmlUrl: pr.url,
		body: pr.body,
		bodyHTML: bodyHTML,
		user: pr.author,
		event: EventType.Commented,
		canEdit: pr.canEdit,
		canDelete: false,
		id: pr.number,
		createdAt: pr.createdAt
	}, messageHandler, undefined, {
		handler: (text: string) => {
			pr.body = text;
			updateState({ body: text });
		},
		command: 'pr.edit-description' });

	descriptionNode.appendChild(descriptionElement);
}

function addEventListeners(pr: PullRequest): void {
	document.getElementById(ElementIds.Checkout)!.addEventListener('click', async () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Checkout)).disabled = true;
		(<HTMLButtonElement>document.getElementById(ElementIds.Checkout)).innerHTML = 'Checking Out...';
		let result = await messageHandler.postMessage({ command: 'pr.checkout' });
		updateCheckoutButton(result.isCurrentlyCheckedOut);
	});

	// Enable 'Comment' and 'RequestChanges' button only when the user has entered text
	let updateStateTimer: number;
	document.getElementById(ElementIds.CommentTextArea)!.addEventListener('input', (e) => {
		const inputText = (<HTMLInputElement>e.target).value;
		const { state } = getState();
		(<HTMLButtonElement>document.getElementById(ElementIds.Reply)).disabled = !inputText;
		(<HTMLButtonElement>document.getElementById(ElementIds.RequestChanges)).disabled = !inputText || state !== PullRequestStateEnum.Open;

		if (updateStateTimer) {
			clearTimeout(updateStateTimer);
		}

		updateStateTimer = window.setTimeout(() => {
			updateState({ pendingCommentText: inputText });
		}, 500);
	});

	document.getElementById(ElementIds.Refresh).addEventListener('click', () => {
		messageHandler.postMessage({
			command: 'pr.refresh'
		});
	});

	document.getElementById(ElementIds.Reply)!.addEventListener('click', () => {
		submitComment();
	});

	document.getElementById(ElementIds.Close)!.addEventListener('click', async () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Close)).disabled = true;
		const inputBox = (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea));
		let result = await messageHandler.postMessage({ command: 'pr.close', args: inputBox.value });
		appendComment(result.value);
	});

	const approveButton = document.getElementById(ElementIds.Approve);
	if (approveButton) {
		approveButton.addEventListener('click', async () => {
			(<HTMLButtonElement>document.getElementById(ElementIds.Approve)).disabled = true;
			const inputBox = (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea));
			messageHandler.postMessage({
				command: 'pr.approve',
				args: inputBox.value
			}).then(message => {
				// succeed
				appendReview(message.value);
			}, err => {
				// enable approve button
				(<HTMLButtonElement>document.getElementById(ElementIds.Approve)).disabled = false;
			});
		});
	}

	const requestChangesButton = document.getElementById(ElementIds.RequestChanges);
	if (requestChangesButton) {
		requestChangesButton.addEventListener('click', () => {
			(<HTMLButtonElement>document.getElementById(ElementIds.RequestChanges)).disabled = true;
			const inputBox = (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea));
			messageHandler.postMessage({
				command: 'pr.request-changes',
				args: inputBox.value
			}).then(message => {
				appendReview(message.value);
			}, err => {
				(<HTMLButtonElement>document.getElementById(ElementIds.RequestChanges)).disabled = false;
			});
		});
	}

	document.getElementById(ElementIds.CheckoutDefaultBranch)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.CheckoutDefaultBranch)).disabled = true;
		messageHandler.postMessage({
			command: 'pr.checkout-default-branch',
			args: pr.repositoryDefaultBranch
		});
	});

	window.onscroll = debounce(() => {
		messageHandler.postMessage({
			command: 'scroll',
			args: {
				x: window.scrollX,
				y: window.scrollY
			}
		});
	}, 200);
}

function clearTextArea() {
	(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).value = '';
	(<HTMLButtonElement>document.getElementById(ElementIds.Reply)).disabled = true;
	(<HTMLButtonElement>document.getElementById(ElementIds.RequestChanges)).disabled = true;

	updateState({ pendingCommentText: undefined });
}

async function submitComment() {
	(<HTMLButtonElement>document.getElementById(ElementIds.Reply)).disabled = true;
	const result = await messageHandler.postMessage({
		command: 'pr.comment',
		args: (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).value
	});

	appendComment(result.value);
}

function appendReview(review: any): void {
	review.event = EventType.Reviewed;
	const pullRequest = getState();
	let events = pullRequest.events;
	events.push(review);
	updateState({ events: events });

	const newReview = renderReview(review, messageHandler, pullRequest.supportsGraphQl);
	if (newReview) {
		document.getElementById(ElementIds.TimelineEvents)!.appendChild(newReview);
	}
	clearTextArea();
}

function appendComment(comment: any) {
	comment.event = EventType.Commented;

	const pullRequest = getState();
	let events = pullRequest.events;
	events.push(comment);
	updateState({ events: events });

	const newComment = renderComment(comment, messageHandler);
	document.getElementById(ElementIds.TimelineEvents)!.appendChild(newComment);
	clearTextArea();
}

function updateCheckoutButton(isCheckedOut: boolean) {
	updateState({ isCurrentlyCheckedOut: isCheckedOut });

	const checkoutButton = (<HTMLButtonElement>document.getElementById(ElementIds.Checkout));
	const checkoutMasterButton = (<HTMLButtonElement>document.getElementById(ElementIds.CheckoutDefaultBranch));
	checkoutButton.disabled = isCheckedOut;
	checkoutMasterButton.disabled = false;
	const activeIcon = '<svg class="octicon octicon-check" viewBox="0 0 12 16" version="1.1" width="12" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M12 5l-8 8-4-4 1.5-1.5L4 10l6.5-6.5L12 5z"></path></svg>';
	checkoutButton.innerHTML = isCheckedOut ? `${activeIcon} Checked Out` : `Checkout`;

	const backButton = (<HTMLButtonElement>document.getElementById(ElementIds.CheckoutDefaultBranch));
	if (isCheckedOut) {
		backButton.classList.remove('hidden');
		checkoutButton.classList.add('checkedOut');
	} else {
		backButton.classList.add('hidden');
		checkoutButton.classList.remove('checkedOut');
	}
}

function setTextArea() {
	const { supportsGraphQl, events } = getState();
	const displaySubmitButtonsOnPendingReview = supportsGraphQl && events.some(e => isReviewEvent(e) && e.state.toLowerCase() === 'pending');

	document.getElementById('comment-form')!.innerHTML = `<textarea id="${ElementIds.CommentTextArea}"></textarea>
		<div class="form-actions">
			<button id="${ElementIds.Close}" class="secondary">Close Pull Request</button>
			${ displaySubmitButtonsOnPendingReview
				? ''
				: `<button id="${ElementIds.RequestChanges}" disabled="true" class="secondary">Request Changes</button>
					<button id="${ElementIds.Approve}" class="secondary">Approve</button>`
			}
			<button class="reply-button" id="${ElementIds.Reply}" disabled="true">Comment</button>
		</div>`;

	const textArea = (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!);
	textArea.placeholder = 'Leave a comment';
	textArea.addEventListener('keydown', e => {
		if (e.keyCode === 65 && e.metaKey) {
			(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).select();
			return;
		}

		if (e.keyCode === 13 && (e.metaKey || e.ctrlKey)) {
			submitComment();
			return;
		}
	});

	let pullRequestCache = getState();

	if (pullRequestCache.pendingCommentText) {
		textArea.value = pullRequestCache.pendingCommentText;

		const replyButton = <HTMLButtonElement>document.getElementById(ElementIds.Reply)!;
		replyButton.disabled = false;

		const requestChangesButton = <HTMLButtonElement>document.getElementById(ElementIds.RequestChanges)!;
		requestChangesButton.disabled = false;
	}
}
