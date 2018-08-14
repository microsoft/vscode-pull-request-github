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
	CheckoutDefaultBranch: 'checkout-default-branch',
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

	addEventListeners(pullRequest);
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
						<button id="${ElementIds.Checkout}" aria-live="polite"></button>
						<button id="${ElementIds.CheckoutDefaultBranch}" aria-live="polite">Exit Review Mode</button>
					</div>
				</div>
				<div class="subtitle">
					<div id="${ElementIds.Status}">${getStatus(pr.state)}</div>
					<img class="avatar" src="${pr.author.avatarUrl}" alt="">
					<span class="author"><a href="${pr.author.htmlUrl}">${pr.author.login}</a> wants to merge changes from <code>${pr.head}</code> to <code>${pr.base}</code>.</span>
				</div>
				<div class="comment-body">${md.render(pr.body)}</div>
			</div>
		`;
}

function addEventListeners(pr: any) {
	document.getElementById(ElementIds.Checkout)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Checkout)).disabled = true;
		(<HTMLButtonElement>document.getElementById(ElementIds.Checkout)).innerHTML = 'Checking Out...';
		vscode.postMessage({
			command: 'pr.checkout'
		});
	});

	// Enable 'Comment' button only when the user has entered text
	document.getElementById(ElementIds.CommentTextArea)!.addEventListener('input', (e) => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Reply)).disabled = !(<any>e.target).value;
	})

	document.getElementById(ElementIds.Reply)!.addEventListener('click', () => {
		submitComment();
	});

	document.getElementById(ElementIds.Close)!.addEventListener('click', () => {
		(<HTMLButtonElement>document.getElementById(ElementIds.Close)).disabled = true;
		vscode.postMessage({
			command: 'pr.close'
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

function submitComment() {
	(<HTMLButtonElement>document.getElementById(ElementIds.Reply)).disabled = true;
	vscode.postMessage({
		command: 'pr.comment',
		text: (<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).value
	});
	(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).value = '';
}

function appendComment(comment: any) {
	let newComment = renderComment(comment);
	document.getElementById(ElementIds.TimelineEvents)!.insertAdjacentHTML('beforeend', newComment);
}

function updateCheckoutButton(isCheckedOut: boolean) {
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
			<button class="reply-button" id="${ElementIds.Reply}" disabled="true"></button>
			<button class="close-button" id="${ElementIds.Close}"></button>
		</div>`;

	(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).placeholder = 'Leave a comment';
	(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).addEventListener('keydown', e => {
		if (e.keyCode === 65 && e.metaKey) {
			(<HTMLTextAreaElement>document.getElementById(ElementIds.CommentTextArea)!).select();
			return;
		}

		if (e.keyCode === 13 && e.ctrlKey) {
			submitComment();
			return;
		}
	});
	(<HTMLButtonElement>document.getElementById(ElementIds.Reply)!).textContent = 'Comment';
	(<HTMLButtonElement>document.getElementById(ElementIds.Close)!).textContent = 'Close Pull Request';
}