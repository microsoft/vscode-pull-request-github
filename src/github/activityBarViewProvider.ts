/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { onDidUpdatePR, openPullRequestOnGitHub } from '../commands';
import { IComment } from '../common/comment';
import { ReviewEvent as CommonReviewEvent } from '../common/timelineEvent';
import { formatError } from '../common/utils';
import { getNonce, IRequestMessage, WebviewViewBase } from '../common/webview';
import { ReviewManager } from '../view/reviewManager';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GithubItemStateEnum, ReviewEvent, ReviewState } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { getDefaultMergeMethod } from './pullRequestOverview';
import { PullRequestView } from './pullRequestOverviewCommon';
import { isInCodespaces, parseReviewers } from './utils';

export class PullRequestViewProvider extends WebviewViewBase implements vscode.WebviewViewProvider {
	public readonly viewType = 'github:activePullRequest';
	private _existingReviewers: ReviewState[] = [];
	private _prChangeListener: vscode.Disposable | undefined;

	constructor(
		extensionUri: vscode.Uri,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private readonly _reviewManager: ReviewManager,
		private _item: PullRequestModel,
	) {
		super(extensionUri);

		onDidUpdatePR(
			pr => {
				if (pr) {
					this._item.update(pr);
				}

				this._postMessage({
					command: 'update-state',
					state: this._item.state,
				});
			},
			null,
			this._disposables,
		);

		this._disposables.push(this._folderRepositoryManager.onDidMergePullRequest(_ => {
			this._postMessage({
				command: 'update-state',
				state: GithubItemStateEnum.Merged,
			});
		}));
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		super.resolveWebviewView(webviewView, _context, _token);
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
			case 'pr.open-create':
				return this.create();
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
			case 'pr.openOnGitHub':
				return openPullRequestOnGitHub(this._item, (this._item as any)._telemetry);
			case 'pr.checkout-default-branch':
				return this.checkoutDefaultBranch(message);
		}
	}

	private async checkoutDefaultBranch(message: IRequestMessage<string>): Promise<void> {
		try {
			const defaultBranch = await this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(this._item);
			await this._folderRepositoryManager.checkoutDefaultBranch(defaultBranch);
		} finally {
			// Complete webview promise so that button becomes enabled again
			this._replyMessage(message, {});
		}
	}

	public async refresh(): Promise<void> {
		await this.updatePullRequest(this._item);
	}

	public async updatePullRequest(pullRequestModel: PullRequestModel): Promise<void> {
		if (!this._prChangeListener || (pullRequestModel.number !== this._item.number)) {
			this._prChangeListener?.dispose();
			this._prChangeListener = pullRequestModel.onDidInvalidate(() => this.updatePullRequest(pullRequestModel));
		}
		this._item = pullRequestModel;
		return Promise.all([
			this._folderRepositoryManager.resolvePullRequest(
				pullRequestModel.remote.owner,
				pullRequestModel.remote.repositoryName,
				pullRequestModel.number,
			),
			this._folderRepositoryManager.getPullRequestRepositoryAccessAndMergeMethods(pullRequestModel),
			pullRequestModel.getTimelineEvents(),
			pullRequestModel.getReviewRequests(),
			this._folderRepositoryManager.getBranchNameForPullRequest(pullRequestModel),
			this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(pullRequestModel)
		])
			.then(result => {
				const [pullRequest, repositoryAccess, timelineEvents, requestedReviewers, branchInfo, defaultBranch] = result;
				if (!pullRequest) {
					throw new Error(
						`Fail to resolve Pull Request #${pullRequestModel.number} in ${pullRequestModel.remote.owner}/${pullRequestModel.remote.repositoryName}`,
					);
				}

				this._item = pullRequest;
				if (!this._view) {
					// If the there is no PR webview, then there is nothing else to update.
					return;
				}

				this._view.title = `${pullRequest.title} #${pullRequestModel.number.toString()}`;

				const isCurrentlyCheckedOut = pullRequestModel.equals(this._folderRepositoryManager.activePullRequest);
				const hasWritePermission = repositoryAccess!.hasWritePermission;
				const mergeMethodsAvailability = repositoryAccess!.mergeMethodsAvailability;
				const canEdit = hasWritePermission || this._item.canEdit();
				const defaultMergeMethod = getDefaultMergeMethod(mergeMethodsAvailability);
				const currentUser = this._folderRepositoryManager.getCurrentUser(this._item.githubRepository);
				this._existingReviewers = parseReviewers(
					requestedReviewers ?? [],
					timelineEvents ?? [],
					pullRequest.author,
				);

				const isCrossRepository =
					pullRequest.base &&
					pullRequest.head &&
					!pullRequest.base.repositoryCloneUrl.equals(pullRequest.head.repositoryCloneUrl);

				const continueOnGitHub = isCrossRepository && isInCodespaces();

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
							url: pullRequest.author.url,
						},
						state: pullRequest.state,
						isCurrentlyCheckedOut: isCurrentlyCheckedOut,
						isRemoteBaseDeleted: pullRequest.isRemoteBaseDeleted,
						base: pullRequest.base.label,
						isRemoteHeadDeleted: pullRequest.isRemoteHeadDeleted,
						isLocalHeadDeleted: !branchInfo,
						head: pullRequest.head?.label ?? '',
						canEdit: canEdit,
						hasWritePermission,
						mergeable: pullRequest.item.mergeable,
						isDraft: pullRequest.isDraft,
						status: { statuses: [] },
						events: [],
						mergeMethodsAvailability,
						defaultMergeMethod,
						repositoryDefaultBranch: defaultBranch,
						isIssue: false,
						isAuthor: currentUser.login === pullRequest.author.login,
						reviewers: this._existingReviewers,
						continueOnGitHub,
						isDarkTheme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
					},
				});
			})
			.catch(e => {
				vscode.window.showErrorMessage(formatError(e));
			});
	}

	private close(message: IRequestMessage<string>): void {
		vscode.commands.executeCommand<IComment>('pr.close', this._item, message.args).then(comment => {
			if (comment) {
				this._replyMessage(message, {
					value: comment,
				});
			}
		});
	}

	private create() {
		this._reviewManager.createPullRequest();
	}

	private createComment(message: IRequestMessage<string>) {
		this._item.createIssueComment(message.args).then(comment => {
			this._replyMessage(message, {
				value: comment,
			});
		});
	}

	private updateReviewers(review?: CommonReviewEvent): void {
		if (review) {
			const existingReviewer = this._existingReviewers.find(
				reviewer => review.user.login === reviewer.reviewer.login,
			);
			if (existingReviewer) {
				existingReviewer.state = review.state;
			} else {
				this._existingReviewers.push({
					reviewer: review.user,
					state: review.state,
				});
			}
		}
	}

	private approvePullRequest(message: IRequestMessage<string>): void {
		this._item.approve(message.args).then(
			review => {
				this.updateReviewers(review);
				this._replyMessage(message, {
					review: review,
					reviewers: this._existingReviewers,
				});
				//refresh the pr list as this one is approved
				vscode.commands.executeCommand('pr.refreshList');
			},
			e => {
				vscode.window.showErrorMessage(`Approving pull request failed. ${formatError(e)}`);

				this._throwError(message, `${formatError(e)}`);
			},
		);
	}

	private requestChanges(message: IRequestMessage<string>): void {
		this._item.requestChanges(message.args).then(
			review => {
				this.updateReviewers(review);
				this._replyMessage(message, {
					review: review,
					reviewers: this._existingReviewers,
				});
			},
			e => {
				vscode.window.showErrorMessage(`Requesting changes failed. ${formatError(e)}`);
				this._throwError(message, `${formatError(e)}`);
			},
		);
	}

	private submitReview(message: IRequestMessage<string>): void {
		this._item.submitReview(ReviewEvent.Comment, message.args).then(
			review => {
				this.updateReviewers(review);
				this._replyMessage(message, {
					review: review,
					reviewers: this._existingReviewers,
				});
			},
			e => {
				vscode.window.showErrorMessage(`Submitting review failed. ${formatError(e)}`);
				this._throwError(message, `${formatError(e)}`);
			},
		);
	}

	private async deleteBranch(message: IRequestMessage<any>) {
		const result = await PullRequestView.deleteBranch(this._folderRepositoryManager, this._item);
		if (result.isReply) {
			this._replyMessage(message, result.message);
		} else {
			this._postMessage(result.message);
		}
	}

	private setReadyForReview(message: IRequestMessage<Record<string, unknown>>): void {
		this._item
			.setReadyForReview()
			.then(isDraft => {
				vscode.commands.executeCommand('pr.refreshList');

				this._replyMessage(message, { isDraft });
			})
			.catch(e => {
				vscode.window.showErrorMessage(`Unable to set PR ready for review. ${formatError(e)}`);
				this._throwError(message, {});
			});
	}

	private async mergePullRequest(
		message: IRequestMessage<{ title: string; description: string; method: 'merge' | 'squash' | 'rebase' }>,
	): Promise<void> {
		const { title, description, method } = message.args;
		const confirmation = await vscode.window.showInformationMessage(
			'Merge this pull request?',
			{ modal: true },
			'Yes',
		);
		if (confirmation !== 'Yes') {
			this._replyMessage(message, { state: GithubItemStateEnum.Open });
			return;
		}

		this._folderRepositoryManager
			.mergePullRequest(this._item, title, description, method)
			.then(result => {
				vscode.commands.executeCommand('pr.refreshList');

				if (!result.merged) {
					vscode.window.showErrorMessage(`Merging PR failed: ${result.message}`);
				}

				this._replyMessage(message, {
					state: result.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Open,
				});
			})
			.catch(e => {
				vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
				this._throwError(message, {});
			});
	}

	private _getHtmlForWebview() {
		const nonce = getNonce();

		const uri = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-open-pr-view.js');

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
		<script nonce="${nonce}" src="${this._webview!.asWebviewUri(uri).toString()}"></script>
	</body>
</html>`;
	}
}
