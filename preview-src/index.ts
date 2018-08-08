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
	CheckoutMaster: 'checkout-master',
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
		case 'pr.update-checkout-status':
			updateCheckoutButton(message.isCurrentlyCheckedOut);
			break;
		case 'pr.append-comment':
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
					<h2>${pr.title} (<a href=${pr.url}>#${pr.number}</a>) </h2>
					<div class="button-group">
						<button id="${ElementIds.Checkout}" aria-live="polite">
						</button><button id="${ElementIds.CheckoutMaster}" aria-live="polite">Checkout Master</button>
					</div>
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

	document.getElementById(ElementIds.CheckoutMaster)!.addEventListener('click', () => {
		vscode.postMessage({
			command: 'pr.checkout-master'
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
	const checkoutIcon = '<svg class="octicon octicon-git-pull-request" width="12" height="16" viewBox="0 0 12 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M11 11.28C11 9.55 11 5 11 5C10.97 4.22 10.66 3.53 10.06 2.94C9.46 2.35 8.78 2.03 8 2C8 2 6.98 2 7 2V0L4 3L7 6V4H8C8.27 4.02 8.48 4.11 8.69 4.31C8.9 4.51 8.99 4.73 9 5V11.28C8.41 11.62 8 12.26 8 13C8 14.11 8.89 15 10 15C11.11 15 12 14.11 12 13C12 12.27 11.59 11.62 11 11.28ZM10 14.2C9.34 14.2 8.8 13.65 8.8 13C8.8 12.35 9.35 11.8 10 11.8C10.65 11.8 11.2 12.35 11.2 13C11.2 13.65 10.65 14.2 10 14.2ZM4 3C4 1.89 3.11 1 2 1C0.89 1 0 1.89 0 3C0 3.73 0.41 4.38 1 4.72C1 6.27 1 10.28 1 11.28C0.41 11.62 0 12.26 0 13C0 14.11 0.89 15 2 15C3.11 15 4 14.11 4 13C4 12.27 3.59 11.62 3 11.28V4.72C3.59 4.38 4 3.74 4 3ZM3.2 13C3.2 13.66 2.65 14.2 2 14.2C1.35 14.2 0.799999 13.65 0.799999 13C0.799999 12.35 1.35 11.8 2 11.8C2.65 11.8 3.2 12.35 3.2 13ZM2 4.2C1.34 4.2 0.799999 3.65 0.799999 3C0.799999 2.35 1.35 1.8 2 1.8C2.65 1.8 3.2 2.35 3.2 3C3.2 3.65 2.65 4.2 2 4.2Z"/></svg>';
	const activeIcon = '<svg class="octicon octicon-check" viewBox="0 0 12 16" version="1.1" width="12" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M12 5l-8 8-4-4 1.5-1.5L4 10l6.5-6.5L12 5z"></path></svg>';
	checkoutButton.innerHTML = isCheckedOut ? `${activeIcon} Checked Out` : `${checkoutIcon} Checkout Pull Request`;

	const backButton = (<HTMLButtonElement>document.getElementById(ElementIds.CheckoutMaster));
	if (isCheckedOut) {
		backButton.classList.remove('hidden');
	} else {
		backButton.classList.add('hidden');
	}
}

function setTextArea() {
	document.getElementById('comment-form')!.innerHTML = `<textarea id="${ElementIds.CommentTextArea}"></textarea>
		<div class="form-actions">
			<button class="reply-button" id="${ElementIds.Reply}" disabled="true"></button>
			<button class="close-button" id="${ElementIds.Close}"></button>
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