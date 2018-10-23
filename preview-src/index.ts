/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import './index.css';
import { renderTimelineEvent, getStatus, renderComment, PullRequestStateEnum, renderReview, TimelineEvent, EventType } from './pullRequestOverviewRenderer';
import md from './mdRenderer';
import * as debounce from 'debounce';
import * as moment from 'moment';
const emoji = require('node-emoji');

declare var acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

const ElementIds = {
	Checkout: 'checkout',
	CheckoutDefaultBranch: 'checkout-default-branch',
	Merge: 'merge',
	Close: 'close',
	Reply: 'reply',
	Approve: 'approve',
	RequestChanges: 'request-changes',
	Status: 'status',
	CommentTextArea: 'comment-textarea',
	TimelineEvents:'timeline-events' // If updating this value, change id in pullRequestOverview.ts as well.
};

interface PullRequest {
	number: number;
	title: string;
	url: string;
	createdAt: Date;
	body: string;
	author: any;
	state: PullRequestStateEnum;
	events: TimelineEvent[];
	isCurrentlyCheckedOut: boolean;
	base: string;
	head: string;
	labels: string[];
	commitsCount: number;
	repositoryDefaultBranch: any;
	pendingCommentText?: string;
}

let pullRequest: PullRequest;

window.onload = () => {
	pullRequest = vscode.getState();
	if (pullRequest) {
		renderPullRequest(pullRequest);
	}
};

function handleMessage(event: any) {
	const message = event.data; // The json data that the extension sent
	switch (message.command) {
		case 'pr.initialize':
			pullRequest = message.pullrequest;
			renderPullRequest(pullRequest);
			vscode.setState(pullRequest);
			break;
		case 'update-state':
			updatePullRequestState(message.state);
			break;
		case 'pr.update-checkout-status':
			updateCheckoutButton(message.isCurrentlyCheckedOut);
			break;
		case 'pr.append-comment':
			appendComment(message.value);
			break;
		case 'pr.append-review':
			appendReview(message.value);
			break;
		case 'pr.enable-approve':
			(<HTMLButtonElement>document.getElementById(ElementIds.Approve)).disabled = false;
			break;
		case 'pr.enable-request-changes':
			(<HTMLButtonElement>document.getElementById(ElementIds.RequestChanges)).disabled = false;
			break;
		case 'pr.enable-exit':
			(<HTMLButtonElement>document.getElementById(ElementIds.CheckoutDefaultBranch)).disabled = false;
			break;
		case 'set-scroll':
			window.scrollTo(message.scrollPosition.x, message.scrollPosition.y);
			break;
		default:
			break;
	}
}

window.addEventListener('message', handleMessage);

function renderPullRequest(pr: PullRequest): void {
	document.getElementById(ElementIds.TimelineEvents)!.innerHTML = pr.events.map(renderTimelineEvent).join('');
	setTitleHTML(pr);
	setTextArea();
	updateCheckoutButton(pr.isCurrentlyCheckedOut);
	updatePullRequestState(pr.state);

	addEventListeners(pr);
}

function updatePullRequestState(state: PullRequestStateEnum): void {
	pullRequest.state = state;
	vscode.setState(pullRequest);

	const merge = (<HTMLButtonElement>document.getElementById(ElementIds.Merge));
	if (merge) {
		merge.disabled = state !== PullRequestStateEnum.Open;
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
			<div class="details">
				<div class="overview-title">
					<h2>${pr.title} (<a href=${pr.url}>#${pr.number}</a>) </h2>
					<div class="button-group">
						<button id="${ElementIds.Checkout}" aria-live="polite"></button>
						<button id="${ElementIds.CheckoutDefaultBranch}" aria-live="polite">Exit Review Mode</button>
					</div>
				</div>
				<div class="subtitle">
					<div id="${ElementIds.Status}">${getStatus(pr.state)}</div>
					<img class="avatar" src="${pr.author.avatarUrl}" alt="">
					<span class="author"><a href="${pr.author.htmlUrl}">${pr.author.login}</a> wants to merge changes from <code>${pr.head}</code> to <code>${pr.base}</code>.</span>
					<div class="created-at">${moment(pr.createdAt).fromNow()}</div>
				</div>
				<div class="comment-body">
					${
						pr.labels.length > 0
							? `<div class="line">
						<svg class="octicon octicon-tag" viewBox="0 0 14 16" version="1.1" width="14" height="16">
							<path fill-rule="evenodd" d="M7.685 1.72a2.49 2.49 0 0 0-1.76-.726H3.48A2.5 2.5 0 0 0 .994 3.48v2.456c0 .656.269 1.292.726 1.76l6.024 6.024a.99.99 0 0 0 1.402 0l4.563-4.563a.99.99 0 0 0 0-1.402L7.685 1.72zM2.366 7.048a1.54 1.54 0 0 1-.467-1.123V3.48c0-.874.716-1.58 1.58-1.58h2.456c.418 0 .825.159 1.123.467l6.104 6.094-4.702 4.702-6.094-6.114zm.626-4.066h1.989v1.989H2.982V2.982h.01z" />
						</svg>
						${pr.labels.map(label => `<span class="label">${label}</span>`).join('')}
						</div>`
							: ''
					}
					<div>${md.render(emoji.emojify(pr.body))}</div>
				</div>
			</div>
		`;
}

function addEventListeners(pr: PullRequest): void {
	document.getElementById(ElementIds.Checkout)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Checkout)).disabled = true;
		(<HTMLButtonElement>document.getElementById(ElementIds.Checkout)).innerHTML = 'Checking Out...';
		vscode.postMessage({
			command: 'pr.checkout'
		});
	});

	// Enable 'Comment' and 'RequestChanges' button only when the user has entered text
	let updateStateTimer: NodeJS.Timer;
	document.getElementById(ElementIds.CommentTextArea)!.addEventListener('input', (e) => {
		const inputText = (<HTMLInputElement>e.target).value;
		(<HTMLButtonElement>document.getElementById(ElementIds.Reply)).disabled = !inputText;
		(<HTMLButtonElement>document.getElementById(ElementIds.RequestChanges)).disabled = !inputText || pullRequest.state !== PullRequestStateEnum.Open;

		if (updateStateTimer) {
			clearTimeout(updateStateTimer);
		}

		updateStateTimer = setTimeout(() => {
			pullRequest.pendingCommentText = inputText;
			vscode.setState(pullRequest);
		}, 500);
	});

	document.getElementById(ElementIds.Reply)!.addEventListener('click', () => {
		submitComment();
	});

	document.getElementById(ElementIds.Merge)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Merge)).disabled = true;
		const inputBox = (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea));
		vscode.postMessage({
			command: 'pr.merge',
			text: inputBox.value
		});
	});

	document.getElementById(ElementIds.Close)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Close)).disabled = true;
		const inputBox = (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea));
		vscode.postMessage({
			command: 'pr.close',
			text: inputBox.value
		});
	});

	document.getElementById(ElementIds.Approve)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Approve)).disabled = true;
		const inputBox = (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea));
		vscode.postMessage({
			command: 'pr.approve',
			text: inputBox.value
		});
	});

	document.getElementById(ElementIds.RequestChanges)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.RequestChanges)).disabled = true;
		const inputBox = (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea));
		vscode.postMessage({
			command: 'pr.request-changes',
			text: inputBox.value
		});
	});

	document.getElementById(ElementIds.CheckoutDefaultBranch)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.CheckoutDefaultBranch)).disabled = true;
		vscode.postMessage({
			command: 'pr.checkout-default-branch',
			branch: pr.repositoryDefaultBranch
		});
	});

	window.onscroll = debounce(() => {
		vscode.postMessage({
			command: 'scroll',
			scrollPosition: {
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

	if (pullRequest) {
		pullRequest.pendingCommentText = undefined;
	}
}

function submitComment() {
	(<HTMLButtonElement>document.getElementById(ElementIds.Reply)).disabled = true;
	vscode.postMessage({
		command: 'pr.comment',
		text: (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).value
	});

}

function appendReview(review: any): void {
	review.event = EventType.Reviewed;
	pullRequest.events.push(review);
	vscode.setState(pullRequest);

	const newReview = renderReview(review);
	document.getElementById(ElementIds.TimelineEvents)!.insertAdjacentHTML('beforeend', newReview);
	clearTextArea();
}

function appendComment(comment: any) {
	comment.event = EventType.Commented;
	pullRequest.events.push(comment);
	vscode.setState(pullRequest);

	let newComment = renderComment(comment);
	document.getElementById(ElementIds.TimelineEvents)!.insertAdjacentHTML('beforeend', newComment);
	clearTextArea();
}

function updateCheckoutButton(isCheckedOut: boolean) {
	pullRequest.isCurrentlyCheckedOut = isCheckedOut;
	vscode.setState(pullRequest);

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
	document.getElementById('comment-form')!.innerHTML = `<textarea id="${ElementIds.CommentTextArea}"></textarea>
		<div class="form-actions">
			<button id="${ElementIds.Merge}" class="secondary">Merge Pull Request</button>
			<button id="${ElementIds.Close}" class="secondary">Close Pull Request</button>
			<button id="${ElementIds.RequestChanges}" disabled="true" class="secondary">Request Changes</button>
			<button id="${ElementIds.Approve}" class="secondary">Approve</button>
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

	if (pullRequest.pendingCommentText) {
		textArea.value = pullRequest.pendingCommentText;
	}
}
