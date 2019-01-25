/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import './index.css';
import * as debounce from 'debounce';
import { dateFromNow } from '../src/common/utils';
import { EventType, isReviewEvent } from '../src/common/timelineEvent';
import { PullRequestStateEnum } from '../src/github/interface';
import { renderTimelineEvent, getStatus, renderComment, renderReview, ActionsBar, renderStatusChecks } from './pullRequestOverviewRenderer';
import md from './mdRenderer';
const emoji = require('node-emoji');
import { getMessageHandler } from './message';
import { getState, setState, PullRequest, updateState } from './cache';

const ElementIds = {
	Checkout: 'checkout',
	CheckoutDefaultBranch: 'checkout-default-branch',
	Merge: 'merge',
	Close: 'close',
	Refresh: 'refresh',
	Reply: 'reply',
	Approve: 'approve',
	RequestChanges: 'request-changes',
	Status: 'status',
	CommentTextArea: 'comment-textarea',
	TimelineEvents: 'timeline-events' // If updating this value, change id in pullRequestOverview.ts as well.
};

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
	renderStatusChecks(pr);
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

function updatePullRequestState(state: PullRequestStateEnum): void {
	updateState({ state: state });

	const merge = (<HTMLButtonElement>document.getElementById(ElementIds.Merge));
	if (merge) {
		const { mergeable } = getState();
		merge.disabled = !mergeable || state !== PullRequestStateEnum.Open;
	}

	const close = (<HTMLButtonElement>document.getElementById(ElementIds.Close));
	if (close) {
		close.disabled = state !== PullRequestStateEnum.Open;
	}

	const checkout = (<HTMLButtonElement>document.getElementById(ElementIds.Checkout));
	if (checkout) {
		checkout.disabled = checkout.disabled || state !== PullRequestStateEnum.Open;
	}

	const approve = (<HTMLButtonElement>document.getElementById(ElementIds.Approve));
	if (approve) {
		approve.disabled = state !== PullRequestStateEnum.Open;
	}

	const status = document.getElementById(ElementIds.Status);
	status!.innerHTML = getStatus(state);
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
					<span class="author"><a href="${pr.author.url}">${pr.author.login}</a> wants to merge changes from <code>${pr.head}</code> to <code>${pr.base}</code>.</span>
				</div>
			</div>
		`;

	const title = renderTitle(pr);
	(document.getElementById('overview-title')! as any).prepend(title);

	const description = renderDescription(pr);
	document.getElementById('details')!.appendChild(description);
}

function renderTitle(pr: PullRequest): HTMLElement {
	const titleContainer = document.createElement('h2');
	titleContainer.classList.add('title-container');

	const titleHeader = document.createElement('div');
	titleHeader.classList.add('description-header');

	const titleBody = document.createElement('div');
	titleBody.innerHTML = `${pr.title} <a href=${pr.url}>#${pr.number}</a>`;

	if (pr.canEdit) {
		function updateTitle(text: string) {
			pr.title = text;
			updateState({ title: text });
			titleBody.innerHTML = `${pr.title} <a href=${pr.url}>#${pr.number}</a>`;
		}

		const actionsBar = new ActionsBar(titleContainer, { body: pr.title, id: pr.number.toString() }, titleBody, messageHandler, updateTitle, 'pr.edit-title');
		const renderedActionsBar = actionsBar.render();
		actionsBar.registerActionBarListeners();
		titleHeader.appendChild(renderedActionsBar);

		if (pr.pendingCommentDrafts && pr.pendingCommentDrafts[pr.number]) {
			actionsBar.startEdit(pr.pendingCommentDrafts[pr.number]);
		}
	}

	titleContainer.appendChild(titleHeader);
	titleContainer.appendChild(titleBody);

	return titleContainer;
}

function renderDescription(pr: PullRequest): HTMLElement {
	const commentContainer = document.createElement('div');
	commentContainer.classList.add('comment-container')

	const commentHeader = document.createElement('div');
	commentHeader.classList.add('comment-header');
	commentHeader.innerHTML = `
				<div class="avatar-container"><img class="avatar" src="${pr.author.avatarUrl}" alt=""></div> <a href="${pr.author.url}">${pr.author.login}</a> commented on <a href=${pr.url} class="timestamp">${dateFromNow(pr.createdAt)}</a>
		`;

	const commentBody = document.createElement('div');
	commentBody.classList.add('description-content');
	commentBody.innerHTML = pr.bodyHTML ?
		pr.bodyHTML :
		pr.body
			? md.render(emoji.emojify(pr.body))
			: '<p><i>No description provided.</i></p>';

	commentContainer.appendChild(commentHeader);

	if (pr.labels.length) {
		const labels = document.createElement('div');
		labels.classList.add('labels');

		labels.innerHTML = `<svg class="octicon octicon-tag" viewBox="0 0 14 16" version="1.1" width="14" height="16">
			<path fill-rule="evenodd" d="M7.685 1.72a2.49 2.49 0 0 0-1.76-.726H3.48A2.5 2.5 0 0 0 .994 3.48v2.456c0 .656.269 1.292.726 1.76l6.024 6.024a.99.99 0 0 0 1.402 0l4.563-4.563a.99.99 0 0 0 0-1.402L7.685 1.72zM2.366 7.048a1.54 1.54 0 0 1-.467-1.123V3.48c0-.874.716-1.58 1.58-1.58h2.456c.418 0 .825.159 1.123.467l6.104 6.094-4.702 4.702-6.094-6.114zm.626-4.066h1.989v1.989H2.982V2.982h.01z" />
			</svg>
			${pr.labels.map(label => `<span class="label">${label}</span>`).join('')}`;

		commentContainer.appendChild(labels);
	}

	commentContainer.appendChild(commentBody);

	if (pr.canEdit) {
		function updateDescription(text: string) {
			pr.body = text;
			updateState({ body: text });

			if (!text) {
				commentBody.innerHTML = `<p><i>No description provided.</i></p>`;
			}
		}

		const actionsBar = new ActionsBar(commentContainer, { body: pr.body, id: pr.number.toString() }, commentBody, messageHandler, updateDescription, 'pr.edit-description');
		const renderedActionsBar = actionsBar.render();
		actionsBar.registerActionBarListeners();
		commentHeader.appendChild(renderedActionsBar);

		if (pr.pendingCommentDrafts && pr.pendingCommentDrafts[pr.number]) {
			actionsBar.startEdit(pr.pendingCommentDrafts[pr.number]);
		}
	}

	return commentContainer;
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

	document.getElementById(ElementIds.Merge)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Merge)).disabled = true;
		const inputBox = (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea));
		messageHandler.postMessage({
			command: 'pr.merge',
			args: inputBox.value
		});
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
			<button id="${ElementIds.Merge}" class="secondary">Merge Pull Request</button>
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
