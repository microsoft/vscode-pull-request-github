/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { formatError } from '../common/utils';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { ReviewEvent, GithubItemStateEnum, ReviewState, MergeMethod } from './interface';
import { PullRequestModel } from './pullRequestModel';
import * as OctokitTypes from '@octokit/types';
import { getDefaultMergeMethod } from './pullRequestOverview';
import webviewContent from '../../media/activityBar-webviewIndex.js';
import { ReviewEvent as CommonReviewEvent } from '../common/timelineEvent';
import { getNonce, IRequestMessage, WebviewViewBase } from '../common/webview';
import { parseReviewers } from './utils';

export class PullRequestViewProvider extends WebviewViewBase implements vscode.WebviewViewProvider {
	public readonly viewType = 'github:activePullRequest';

	private _existingReviewers: ReviewState[];

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private _item: PullRequestModel
	) {
		super();
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;
		this._webview = webviewView.webview;
		super.initialize();

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview();

		this.updatePullRequest(this._item);
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}

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
	}

	public async refresh(): Promise<void> {
		await this.updatePullRequest(this._item);
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

			if (!this._view) {
				// If the there is no PR webview, then there is nothing else to update.
				return;
			}

			this._item = pullRequest;
			this._view.title = `${pullRequest.title} #${pullRequestModel.number.toString()}`;

			const isCurrentlyCheckedOut = pullRequestModel.equals(this._folderRepositoryManager.activePullRequest);
			const hasWritePermission = repositoryAccess!.hasWritePermission;
			const mergeMethodsAvailability = repositoryAccess!.mergeMethodsAvailability;
			const canEdit = hasWritePermission || this._item.canEdit();
			const preferredMergeMethod = vscode.workspace.getConfiguration('githubPullRequests').get<MergeMethod>('defaultMergeMethod');
			const defaultMergeMethod = getDefaultMergeMethod(mergeMethodsAvailability, preferredMergeMethod);
			const currentUser = this._folderRepositoryManager.getCurrentUser(this._item);
			this._existingReviewers = parseReviewers(requestedReviewers ?? [], timelineEvents ?? [], pullRequest.author);

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
					base: pullRequest.base?.label ?? 'UNKNOWN',
					head: pullRequest.head?.label ?? 'UNKNOWN',
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
					reviewers: this._existingReviewers
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

			const defaultBranch = await this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(this._item);
			const isDefaultBranch = defaultBranch === this._item.head.ref;
			if (!isDefaultBranch) {
				actions.push({
					label: `Delete remote branch ${this._item.remote.remoteName}/${branchHeadRef}`,
					description: `${this._item.remote.normalizedHost}/${this._item.remote.owner}/${this._item.remote.repositoryName}`,
					type: 'upstream',
					picked: true
				});
			}
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
		const confirmation = await vscode.window.showInformationMessage('Merge this pull request?', { modal: true }, 'Yes');
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

	private _getHtmlForWebview() {
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