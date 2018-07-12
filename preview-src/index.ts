/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import './index.css';
import { renderTimelineEvent, getStatus, renderComment, PullRequestStateEnum } from './pullRequestOverviewRenderer';
import md from './mdRenderer';

declare var acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

const ElementIds = {
	Checkout: 'checkout',
	Close: 'close',
	Reply: 'reply',
	Status: 'status',
	CommentTextArea: 'comment-textarea',
	TimelineEvents:'timeline-events' // If updating this value, change id in pullRequestOverview.ts as well.
}

function handleMessage(event: any) {
	const message = event.data; // The json data that the extension sent
	switch (message.command) {
		case 'pr.initialize':
			renderPullRequest(message.pullrequest);
			break;
		case 'update-state':
			updatePullRequestState(message.state);
			break;
		case 'checked-out':
			updateCheckoutButton(true);
			break;
		case 'append-comment':
			appendComment(message.value);
		default:
			break;
	}
}

window.addEventListener('message', handleMessage);

function renderPullRequest(pullRequest: any) {
	document.getElementById(ElementIds.TimelineEvents)!.innerHTML = pullRequest.events.map(renderTimelineEvent).join('');
	setTitleHTML(pullRequest);
	setTextArea();
	updateCheckoutButton(pullRequest.isCurrentlyCheckedOut);

	addEventListeners();
}

function updatePullRequestState(state: PullRequestStateEnum) {
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

function setTitleHTML(pr: any) {
	document.getElementById('title')!.innerHTML = `
			<div class="details">
				<div class="overview-title">
					<h2>${pr.title} (<a href=${pr.url}>#${pr.number}</a>) </h2> <button id="${ElementIds.Checkout}" aria-live="polite"><svg class="octicon octicon-desktop-download" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M4 6h3V0h2v6h3l-4 4-4-4zm11-4h-4v1h4v8H1V3h4V2H1c-.55 0-1 .45-1 1v9c0 .55.45 1 1 1h5.34c-.25.61-.86 1.39-2.34 2h8c-1.48-.61-2.09-1.39-2.34-2H15c.55 0 1-.45 1-1V3c0-.55-.45-1-1-1z"></path></svg>Checkout Pull Request</button>
				</div>
				<div class="subtitle">
					<div id="${ElementIds.Status}">${getStatus(pr.state)}</div>
					<img class="avatar" src="${pr.author.avatarUrl}" alt="">
					<span class="author"><a href="${pr.author.htmlUrl}">${pr.author.login}</a> wants to merge changes from <code>${pr.head}</code> to <code>${pr.base}</code>.</span>
				</div>
				<div class="comment-body">
					${md.render(pr.body)}
				</div>
			</div>
		`;
}

function addEventListeners() {
	document.getElementById(ElementIds.Checkout)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Checkout)).disabled = true;
		vscode.postMessage({
			command: 'pr.checkout'
		});
	});

	// Enable 'Comment' button only when the user has entered text
	document.getElementById(ElementIds.CommentTextArea)!.addEventListener('input', (e) => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Reply)).disabled = !(<any>e.target).value;
	})

	document.getElementById(ElementIds.Reply)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Reply)).disabled = true;
		vscode.postMessage({
			command: 'pr.comment',
			text: (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).value
		});
		(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).value = '';
	});

	document.getElementById(ElementIds.Close)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Close)).disabled = true;
		vscode.postMessage({
			command: 'pr.close'
		});
	});
}

function appendComment(comment: any) {
	let newComment = renderComment(comment);
	document.getElementById(ElementIds.TimelineEvents)!.insertAdjacentHTML('beforeend', newComment);
}

function updateCheckoutButton(isCheckedOut: boolean) {
	const checkoutButton = (<HTMLButtonElement>document.getElementById(ElementIds.Checkout));
	checkoutButton.disabled = isCheckedOut;
	const checkoutIcon = '<svg class="octicon octicon-desktop-download" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M4 6h3V0h2v6h3l-4 4-4-4zm11-4h-4v1h4v8H1V3h4V2H1c-.55 0-1 .45-1 1v9c0 .55.45 1 1 1h5.34c-.25.61-.86 1.39-2.34 2h8c-1.48-.61-2.09-1.39-2.34-2H15c.55 0 1-.45 1-1V3c0-.55-.45-1-1-1z"></path></svg>';
	const activeIcon = '<svg class="octicon octicon-check" viewBox="0 0 12 16" version="1.1" width="12" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M12 5l-8 8-4-4 1.5-1.5L4 10l6.5-6.5L12 5z"></path></svg>';
	checkoutButton.innerHTML = isCheckedOut ? `${activeIcon} Currently Active` : `${checkoutIcon} Checkout Pull Request`;
}

function setTextArea() {
	document.getElementById('comment-form')!.innerHTML = `<textarea id="${ElementIds.CommentTextArea}"></textarea>
		<div class="form-actions">
			<button class="close-button" id="${ElementIds.Close}"></button>
			<button class="reply-button" id="${ElementIds.Reply}" disabled="true"></button>
		</div>`;

	(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).placeholder = 'Leave a comment';
	(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).addEventListener('keydown', e => {
		if (e.keyCode === 65 && e.metaKey) {
			(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).select();
		}
	});
	(<HTMLButtonElement>document.getElementById(ElementIds.Reply)!).textContent = 'Comment';
	(<HTMLButtonElement>document.getElementById(ElementIds.Close)!).textContent = 'Close Pull Request';
}