/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { onDidUpdatePR, openPullRequestOnGitHub } from '../commands';
import { IComment } from '../common/comment';
import { ReviewEvent as CommonReviewEvent } from '../common/timelineEvent';
import { dispose, formatError } from '../common/utils';
import { getNonce, IRequestMessage, WebviewViewBase } from '../common/webview';
import { ReviewManager } from '../view/reviewManager';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GithubItemStateEnum, isTeam, reviewerId, ReviewEvent, ReviewState } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { getDefaultMergeMethod } from './pullRequestOverview';
import { PullRequestView } from './pullRequestOverviewCommon';
import { isInCodespaces, parseReviewers } from './utils';
import { PullRequest } from './views';

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
			case 'pr.re-request-review':
				return this.reRequestReview(message);
		}
	}

	private async checkoutDefaultBranch(message: IRequestMessage<string>): Promise<void> {
		try {
			const defaultBranch = await this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(this._item);
			const prBranch = this._folderRepositoryManager.repository.state.HEAD?.name;
			await this._folderRepositoryManager.checkoutDefaultBranch(defaultBranch);
			if (prBranch) {
				await this._folderRepositoryManager.cleanupAfterPullRequest(prBranch, this._item);
			}
		} finally {
			// Complete webview promise so that button becomes enabled again
			this._replyMessage(message, {});
		}
	}

	private reRequestReview(message: IRequestMessage<string>): void {
		const reviewer = this._existingReviewers.find(reviewer => reviewer.reviewer.id === message.args);
		const userReviewers: string[] = [];
		const teamReviewers: string[] = [];
		if (reviewer && isTeam(reviewer.reviewer)) {
			teamReviewers.push(reviewer.reviewer.id);
		} else if (reviewer && !isTeam(reviewer.reviewer)) {
			userReviewers.push(reviewer.reviewer.id);
		}
		this._item.requestReview(userReviewers, teamReviewers).then(() => {
			if (reviewer) {
				reviewer.state = 'REQUESTED';
			}
			this._replyMessage(message, {
				reviewers: this._existingReviewers,
			});
		});
	}

	public async refresh(): Promise<void> {
		await this.updatePullRequest(this._item);
	}

	private _prDisposables: vscode.Disposable[] | undefined = undefined;
	private registerPrSpecificListeners(pullRequestModel: PullRequestModel) {
		if (this._prDisposables !== undefined) {
			dispose(this._prDisposables);
		}
		this._prDisposables = [];
		this._prDisposables.push(pullRequestModel.onDidInvalidate(() => this.updatePullRequest(pullRequestModel)));
		this._prDisposables.push(pullRequestModel.onDidChangePendingReviewState(() => this.updatePullRequest(pullRequestModel)));
	}

	public async updatePullRequest(pullRequestModel: PullRequestModel): Promise<void> {
		if ((this._prDisposables === undefined) || (pullRequestModel.number !== this._item.number)) {
			this.registerPrSpecificListeners(pullRequestModel);
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
			this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(pullRequestModel),
			this._folderRepositoryManager.getCurrentUser(pullRequestModel.githubRepository),
			pullRequestModel.canEdit(),
			pullRequestModel.validateDraftMode()
		])
			.then(result => {
				const [pullRequest, repositoryAccess, timelineEvents, requestedReviewers, branchInfo, defaultBranch, currentUser, viewerCanEdit, hasReviewDraft] = result;
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
				const canEdit = hasWritePermission || viewerCanEdit;
				const defaultMergeMethod = getDefaultMergeMethod(mergeMethodsAvailability);
				this._existingReviewers = parseReviewers(
					requestedReviewers ?? [],
					timelineEvents ?? [],
					pullRequest.author,
				);

				const isCrossRepository =
					pullRequest.base &&
					pullRequest.head &&
					!pullRequest.base.repositoryCloneUrl.equals(pullRequest.head.repositoryCloneUrl);

				const continueOnGitHub = !!(isCrossRepository && isInCodespaces());

				const context: Partial<PullRequest> = {
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
						email: pullRequest.author.email,
						id: pullRequest.author.id
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
					status: null,
					reviewRequirement: null,
					events: [],
					mergeMethodsAvailability,
					defaultMergeMethod,
					repositoryDefaultBranch: defaultBranch,
					isIssue: false,
					isAuthor: currentUser.login === pullRequest.author.login,
					reviewers: this._existingReviewers,
					continueOnGitHub,
					isDarkTheme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
					hasReviewDraft
				};

				this._postMessage({
					command: 'pr.initialize',
					pullrequest: context,
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
				reviewer => review.user.login === reviewerId(reviewer.reviewer),
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
		this._item.approve(this._folderRepositoryManager.repository, message.args).then(
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
				vscode.window.showErrorMessage(vscode.l10n.t('Approving pull request failed. {0}', formatError(e)));

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
				vscode.window.showErrorMessage(vscode.l10n.t('Requesting changes failed. {0}', formatError(e)));
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
				vscode.window.showErrorMessage(vscode.l10n.t('Submitting review failed. {0}', formatError(e)));
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
				vscode.window.showErrorMessage(vscode.l10n.t('Unable to set PR ready for review. {0}', formatError(e)));
				this._throwError(message, {});
			});
	}

	private async mergePullRequest(
		message: IRequestMessage<{ title: string; description: string; method: 'merge' | 'squash' | 'rebase' }>,
	): Promise<void> {
		const { title, description, method } = message.args;
		const yes = vscode.l10n.t('Yes');
		const confirmation = await vscode.window.showInformationMessage(
			vscode.l10n.t('Merge this pull request?'),
			{ modal: true },
			yes,
		);
		if (confirmation !== yes) {
			this._replyMessage(message, { state: GithubItemStateEnum.Open });
			return;
		}

		this._folderRepositoryManager
			.mergePullRequest(this._item, title, description, method)
			.then(result => {
				vscode.commands.executeCommand('pr.refreshList');

				if (!result.merged) {
					vscode.window.showErrorMessage(vscode.l10n.t('Merging PR failed: {0}', result.message));
				}

				this._replyMessage(message, {
					state: result.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Open,
				});
			})
			.catch(e => {
				vscode.window.showErrorMessage(vscode.l10n.t('Unable to merge pull request. {0}', formatError(e)));
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
