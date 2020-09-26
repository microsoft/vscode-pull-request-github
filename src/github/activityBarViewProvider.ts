/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { formatError } from '../common/utils';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { ReviewEvent, GithubItemStateEnum, ReviewState, MergeMethod, IAccount } from './interface';
import { IRequestMessage, IReplyMessage } from './issueOverview';
import { PullRequestModel } from './pullRequestModel';
import * as OctokitTypes from '@octokit/types';
import { getDefaultMergeMethod } from './pullRequestOverview';
import webviewContent from '../../media/activityBar-webviewIndex.js';
import { isReviewEvent, TimelineEvent, ReviewEvent as CommonReviewEvent } from '../common/timelineEvent';

export class PullRequestViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'github:activePullRequest';

	private _view?: vscode.WebviewView;

	private _existingReviewers: ReviewState[];

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private _item: PullRequestModel
	) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(message => {
			switch (message.command) {
				case 'alert':
					vscode.window.showErrorMessage(message.args);
					return;
				case 'pr.close':
					return this.close(message);
				case 'pr.comment':
					return this.createComment(message);
				case 'pr.merge':
					return this.mergePullRequest(message);
				case 'pr.deleteBranch':
					return this.deleteBranch(message);
				case 'pr.readyForReview':
					return this.setReadyForReview(message);
				case 'pr.approve':
					return this.approvePullRequest(message);
				case 'pr.request-changes':
					return this.requestChanges(message);
				case 'pr.submit':
					return this.submitReview(message);
			}
		});

		this.updatePullRequest(this._item);
	}

	public async updatePullRequest(pullRequestModel: PullRequestModel): Promise<void> {
		return Promise.all([
			this._folderRepositoryManager.resolvePullRequest(
				pullRequestModel.remote.owner,
				pullRequestModel.remote.repositoryName,
				pullRequestModel.number
			),
			this._folderRepositoryManager.getPullRequestRepositoryAccessAndMergeMethods(pullRequestModel),
			pullRequestModel.getTimelineEvents(),
			pullRequestModel.getReviewRequests()
		]).then(result => {
			const [pullRequest, repositoryAccess, timelineEvents, requestedReviewers] = result;
			if (!pullRequest) {
				throw new Error(`Fail to resolve Pull Request #${pullRequestModel.number} in ${pullRequestModel.remote.owner}/${pullRequestModel.remote.repositoryName}`);
			}

			this._item = pullRequest;
			this._view!.title = `${pullRequest.title} #${pullRequestModel.number.toString()}`;

			const isCurrentlyCheckedOut = pullRequestModel.equals(this._folderRepositoryManager.activePullRequest);
			const hasWritePermission = repositoryAccess!.hasWritePermission;
			const mergeMethodsAvailability = repositoryAccess!.mergeMethodsAvailability;
			const canEdit = hasWritePermission || this._item.canEdit();
			const preferredMergeMethod = vscode.workspace.getConfiguration('githubPullRequests').get<MergeMethod>('defaultMergeMethod');
			const defaultMergeMethod = getDefaultMergeMethod(mergeMethodsAvailability, preferredMergeMethod);
			const currentUser = this._folderRepositoryManager.getCurrentUser(this._item);

			this._postMessage({
				command: 'pr.initialize',
				pullrequest: {
					number: pullRequest.number,
					title: pullRequest.title,
					url: pullRequest.html_url,
					createdAt: pullRequest.createdAt,
					body: pullRequest.body,
					bodyHTML: pullRequest.bodyHTML,
					labels: pullRequest.item.labels,
					author: {
						login: pullRequest.author.login,
						name: pullRequest.author.name,
						avatarUrl: pullRequest.userAvatar,
						url: pullRequest.author.url
					},
					state: pullRequest.state,
					isCurrentlyCheckedOut: isCurrentlyCheckedOut,
					base: pullRequest.base && pullRequest.base.label || 'UNKNOWN',
					head: pullRequest.head && pullRequest.head.label || 'UNKNOWN',
					canEdit: canEdit,
					hasWritePermission,
					mergeable: pullRequest.item.mergeable,
					isDraft: pullRequest.isDraft,
					status: { statuses: [] },
					events: [],
					mergeMethodsAvailability,
					defaultMergeMethod,
					isIssue: false,
					isAuthor: currentUser.login === pullRequest.author.login,
					reviewers: this.parseReviewers(requestedReviewers || [], timelineEvents || [], pullRequest.author)
				}
			});
		}).catch(e => {
			vscode.window.showErrorMessage(formatError(e));
		});
	}

	private close(message: IRequestMessage<string>): void {
		vscode.commands.executeCommand<OctokitTypes.PullsGetResponseData>('pr.close', this._item, message.args).then(comment => {
			if (comment) {
				this._replyMessage(message, {
					value: comment
				});
			}
		});
	}

	private createComment(message: IRequestMessage<string>) {
		this._item.createIssueComment(message.args).then(comment => {
			this._replyMessage(message, {
				value: comment
			});
		});
	}

	/**
	 * Create a list of reviewers composed of people who have already left reviews on the PR, and
	 * those that have had a review requested of them. If a reviewer has left multiple reviews, the
	 * state should be the state of their most recent review, or 'REQUESTED' if they have an outstanding
	 * review request.
	 * @param requestedReviewers The list of reviewers that are requested for this pull request
	 * @param timelineEvents All timeline events for the pull request
	 * @param author The author of the pull request
	 */
	private parseReviewers(requestedReviewers: IAccount[], timelineEvents: TimelineEvent[], author: IAccount): ReviewState[] {
		const reviewEvents = timelineEvents.filter(isReviewEvent).filter(event => event.state !== 'PENDING');
		let reviewers: ReviewState[] = [];
		const seen = new Map<string, boolean>();

		// Do not show the author in the reviewer list
		seen.set(author.login, true);

		for (let i = reviewEvents.length - 1; i >= 0; i--) {
			const reviewer = reviewEvents[i].user;
			if (!seen.get(reviewer.login)) {
				seen.set(reviewer.login, true);
				reviewers.push({
					reviewer: reviewer,
					state: reviewEvents[i].state
				});
			}
		}

		requestedReviewers.forEach(request => {
			if (!seen.get(request.login)) {
				reviewers.push({
					reviewer: request,
					state: 'REQUESTED'
				});
			} else {
				const reviewer = reviewers.find(r => r.reviewer.login === request.login);
				reviewer!.state = 'REQUESTED';
			}
		});

		// Put completed reviews before review requests and alphabetize each section
		reviewers = reviewers.sort((a, b) => {
			if (a.state === 'REQUESTED' && b.state !== 'REQUESTED') {
				return 1;
			}

			if (b.state === 'REQUESTED' && a.state !== 'REQUESTED') {
				return -1;
			}

			return a.reviewer.login.toLowerCase() < b.reviewer.login.toLowerCase() ? -1 : 1;
		});

		this._existingReviewers = reviewers;
		return reviewers;
	}


	private updateReviewers(review?: CommonReviewEvent): void {
		if (review) {
			const existingReviewer = this._existingReviewers.find(reviewer => review.user.login === reviewer.reviewer.login);
			if (existingReviewer) {
				existingReviewer.state = review.state;
			} else {
				this._existingReviewers.push({
					reviewer: review.user,
					state: review.state
				});
			}
		}
	}

	private approvePullRequest(message: IRequestMessage<string>): void {
		this._item.approve(message.args).then(review => {
			this.updateReviewers(review);
			this._replyMessage(message, {
				review: review,
				reviewers: this._existingReviewers
			});
			//refresh the pr list as this one is approved
			vscode.commands.executeCommand('pr.refreshList');
		}, (e) => {
			vscode.window.showErrorMessage(`Approving pull request failed. ${formatError(e)}`);

			this._throwError(message, `${formatError(e)}`);
		});
	}

	private requestChanges(message: IRequestMessage<string>): void {
		this._item.requestChanges(message.args).then(review => {
			this.updateReviewers(review);
			this._replyMessage(message, {
				review: review,
				reviewers: this._existingReviewers
			});
		}, (e) => {
			vscode.window.showErrorMessage(`Requesting changes failed. ${formatError(e)}`);
			this._throwError(message, `${formatError(e)}`);
		});
	}

	private submitReview(message: IRequestMessage<string>): void {
		this._item.submitReview(ReviewEvent.Comment, message.args).then(review => {
			this.updateReviewers(review);
			this._replyMessage(message, {
				review: review,
				reviewers: this._existingReviewers
			});
		}, (e) => {
			vscode.window.showErrorMessage(`Submitting review failed. ${formatError(e)}`);
			this._throwError(message, `${formatError(e)}`);
		});
	}

	private async deleteBranch(message: IRequestMessage<any>) {
		const branchInfo = await this._folderRepositoryManager.getBranchNameForPullRequest(this._item);
		const actions: (vscode.QuickPickItem & { type: 'upstream' | 'local' | 'remote' })[] = [];

		if (this._item.isResolved()) {
			const branchHeadRef = this._item.head.ref;

			actions.push({
				label: `Delete remote branch ${this._item.remote.remoteName}/${branchHeadRef}`,
				description: `${this._item.remote.normalizedHost}/${this._item.remote.owner}/${this._item.remote.repositoryName}`,
				type: 'upstream',
				picked: true
			});
		}

		if (branchInfo) {
			const preferredLocalBranchDeletionMethod = vscode.workspace.getConfiguration('githubPullRequests').get<boolean>('defaultDeletionMethod.selectLocalBranch');
			actions.push({
				label: `Delete local branch ${branchInfo.branch}`,
				type: 'local',
				picked: !!preferredLocalBranchDeletionMethod
			});

			const preferredRemoteDeletionMethod = vscode.workspace.getConfiguration('githubPullRequests').get<boolean>('defaultDeletionMethod.selectRemote');

			if (branchInfo.remote && branchInfo.createdForPullRequest && !branchInfo.remoteInUse) {
				actions.push({
					label: `Delete remote ${branchInfo.remote}, which is no longer used by any other branch`,
					type: 'remote',
					picked: !!preferredRemoteDeletionMethod
				});
			}
		}

		if (!actions.length) {
			vscode.window.showWarningMessage(`There is no longer an upstream or local branch for Pull Request #${this._item.number}`);
			this._replyMessage(message, {
				cancelled: true
			});

			return;
		}

		const selectedActions = await vscode.window.showQuickPick(actions, {
			canPickMany: true,
			ignoreFocusOut: true
		});

		if (selectedActions) {
			const isBranchActive = this._item.equals(this._folderRepositoryManager.activePullRequest);

			const promises = selectedActions.map(async (action) => {
				switch (action.type) {
					case 'upstream':
						return this._folderRepositoryManager.deleteBranch(this._item);
					case 'local':
						if (isBranchActive) {
							if (this._folderRepositoryManager.repository.state.workingTreeChanges.length) {
								const response = await vscode.window.showWarningMessage(`Your local changes will be lost, do you want to continue?`, { modal: true }, 'Yes');
								if (response === 'Yes') {
									await vscode.commands.executeCommand('git.cleanAll');
								} else {
									return;
								}
							}
							const defaultBranch = await this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(this._item);
							await this._folderRepositoryManager.repository.checkout(defaultBranch);
						}
						return await this._folderRepositoryManager.repository.deleteBranch(branchInfo!.branch, true);
					case 'remote':
						return this._folderRepositoryManager.repository.removeRemote(branchInfo!.remote!);
				}
			});

			await Promise.all(promises);

			vscode.commands.executeCommand('pr.refreshList');

			this._postMessage({
				command: 'pr.deleteBranch'
			});
		} else {
			this._replyMessage(message, {
				cancelled: true
			});
		}
	}

	private setReadyForReview(message: IRequestMessage<{}>): void {
		this._item.setReadyForReview().then(isDraft => {
			vscode.commands.executeCommand('pr.refreshList');

			this._replyMessage(message, { isDraft });
		}).catch(e => {
			vscode.window.showErrorMessage(`Unable to set PR ready for review. ${formatError(e)}`);
			this._throwError(message, {});
		});
	}

	private async mergePullRequest(message: IRequestMessage<{ title: string, description: string, method: 'merge' | 'squash' | 'rebase' }>): Promise<void> {
		const { title, description, method } = message.args;
		const confirmation = await vscode.window.showInformationMessage('Merge this pull request?',  { modal: true }, 'Yes');
		if (confirmation !== 'Yes') {
			this._replyMessage(message, { state: GithubItemStateEnum.Open });
			return;
		}

		this._folderRepositoryManager.mergePullRequest(this._item, title, description, method).then(result => {
			vscode.commands.executeCommand('pr.refreshList');

			if (!result.merged) {
				vscode.window.showErrorMessage(`Merging PR failed: ${result.message}`);
			}

			this._replyMessage(message, {
				state: result.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Open
			});
		}).catch(e => {
			vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
			this._throwError(message, {});
		});
	}

	private async _postMessage(message: any) {
		this._view?.webview.postMessage({
			res: message
		});
	}

	protected async _replyMessage(originalMessage: IRequestMessage<any>, message: any) {
		const reply: IReplyMessage = {
			seq: originalMessage.req,
			res: message
		};
		this._view!.webview.postMessage(reply);
	}

	protected async _throwError(originalMessage: IRequestMessage<any>, error: any) {
		const reply: IReplyMessage = {
			seq: originalMessage.req,
			err: error
		};
		this._view!.webview.postMessage(reply);
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		const nonce = getNonce();

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">

			<title>Active Pull Request</title>
		</head>
		<body>
			<div id="app"></div>
			<script nonce="${nonce}">${webviewContent}</script>
		</body>
		</html>`;
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}