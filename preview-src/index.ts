/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import './index.css';
import { renderTimelineEvent, getStatus, renderComment, PullRequestStateEnum, renderReview, TimelineEvent, EventType } from './pullRequestOverviewRenderer';
import md from './mdRenderer';
import * as moment from 'moment';

declare var acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

const ElementIds = {
	Checkout: 'checkout',
	CheckoutDefaultBranch: 'checkout-default-branch',
	Close: 'close',
	Reply: 'reply',
	Approve: 'approve',
	RequestChanges: 'request-changes',
	Status: 'status',
	CommentTextArea: 'comment-textarea',
	TimelineEvents:'timeline-events' // If updating this value, change id in pullRequestOverview.ts as well.
}

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
	commitsCount: number;
	repositoryDefaultBranch: any;
}

let pullRequest: PullRequest;

window.onload = () => {
	pullRequest = vscode.getState();
	if (pullRequest) {
		renderPullRequest(pullRequest);
	}
}

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
		default:
			break;
	}
}

window.addEventListener('message', handleMessage);

function renderPullRequest(pullRequest: PullRequest): void {
	document.getElementById(ElementIds.TimelineEvents)!.innerHTML = pullRequest.events.map(renderTimelineEvent).join('');
	setTitleHTML(pullRequest);
	setTextArea();
	updateCheckoutButton(pullRequest.isCurrentlyCheckedOut);

	addEventListeners(pullRequest);
}

function updatePullRequestState(state: PullRequestStateEnum): void {
	pullRequest.state = state;
	vscode.setState(pullRequest);

	const close = (<HTMLButtonElement>document.getElementById(ElementIds.Close));
	if (close) {
		close.disabled = state !== PullRequestStateEnum.Open;
	}

	const checkout = (<HTMLButtonElement>document.getElementById(ElementIds.Checkout));
	if (checkout) {
		checkout.disabled = checkout.disabled || state !== PullRequestStateEnum.Open;
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
				<div class="comment-body">${md.render(pr.body)}</div>
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
	document.getElementById(ElementIds.CommentTextArea)!.addEventListener('input', (e) => {
		const hasNoText = !(<any>e.target).value;
		(<HTMLButtonElement>document.getElementById(ElementIds.Reply)).disabled = hasNoText;
		(<HTMLButtonElement>document.getElementById(ElementIds.RequestChanges)).disabled = hasNoText;

	});

	document.getElementById(ElementIds.Reply)!.addEventListener('click', () => {
		submitComment();
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
}

function clearTextArea() {
	(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).value = '';
	(<HTMLButtonElement>document.getElementById(ElementIds.Reply)).disabled = true;
	(<HTMLButtonElement>document.getElementById(ElementIds.RequestChanges)).disabled = true;
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
	checkoutButton.innerHTML = isCheckedOut ? `${activeIcon} Checked Out` : `Check out`;

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
			<button id="${ElementIds.Close}">Close Pull Request</button>
			<button id="${ElementIds.RequestChanges}" disabled="true">Request Changes</button>
			<button id="${ElementIds.Approve}">Approve</button>
			<button class="reply-button" id="${ElementIds.Reply}" disabled="true">Comment</button>
		</div>`;

	(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).placeholder = 'Leave a comment';
	(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).addEventListener('keydown', e => {
		if (e.keyCode === 65 && e.metaKey) {
			(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).select();
			return;
		}

		if (e.keyCode === 13 && (e.metaKey || e.ctrlKey)) {
			submitComment();
			return;
		}
	});
}