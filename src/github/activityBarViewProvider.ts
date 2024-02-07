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
import { GithubItemStateEnum, IAccount, isTeam, reviewerId, ReviewEvent, ReviewState } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { getDefaultMergeMethod } from './pullRequestOverview';
import { PullRequestView } from './pullRequestOverviewCommon';
import { isInCodespaces, parseReviewers } from './utils';
import { MergeArguments, PullRequest, ReviewType } from './views';

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

		this._disposables.push(vscode.commands.registerCommand('review.approve', (e: { body: string }) => this.approvePullRequestCommand(e)));
		this._disposables.push(vscode.commands.registerCommand('review.comment', (e: { body: string }) => this.submitReviewCommand(e)));
		this._disposables.push(vscode.commands.registerCommand('review.requestChanges', (e: { body: string }) => this.requestChangesCommand(e)));
		this._disposables.push(vscode.commands.registerCommand('review.approveOnDotCom', () => {
			return openPullRequestOnGitHub(this._item, (this._item as any)._telemetry);
		}));
		this._disposables.push(vscode.commands.registerCommand('review.requestChangesOnDotCom', () => {
			return openPullRequestOnGitHub(this._item, (this._item as any)._telemetry);
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
				return this.approvePullRequestMessage(message);
			case 'pr.request-changes':
				return this.requestChangesMessage(message);
			case 'pr.submit':
				return this.submitReviewMessage(message);
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
		let targetReviewer: ReviewState | undefined;
		const userReviewers: string[] = [];
		const teamReviewers: string[] = [];

		for (const reviewer of this._existingReviewers) {
			let id: string | undefined;
			let reviewerArray: string[] | undefined;
			if (reviewer && isTeam(reviewer.reviewer)) {
				id = reviewer.reviewer.id;
				reviewerArray = teamReviewers;
			} else if (reviewer && !isTeam(reviewer.reviewer)) {
				id = reviewer.reviewer.id;
				reviewerArray = userReviewers;
			}
			if (reviewerArray && id && ((reviewer.state === 'REQUESTED') || (id === message.args))) {
				reviewerArray.push(id);
				if (id === message.args) {
					targetReviewer = reviewer;
				}
			}
		}
		this._item.requestReview(userReviewers, teamReviewers).then(() => {
			if (targetReviewer) {
				targetReviewer.state = 'REQUESTED';
			}
			this._replyMessage(message, {
				reviewers: this._existingReviewers,
			});
		});
	}

	public async refresh(): Promise<void> {
		await this.updatePullRequest(this._item);
	}

	private getCurrentUserReviewState(reviewers: ReviewState[], currentUser: IAccount): string | undefined {
		const review = reviewers.find(r => reviewerId(r.reviewer) === currentUser.login);
		// There will always be a review. If not then the PR shouldn't have been or fetched/shown for the current user
		return review?.state;
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

	private _updatePendingVisibility: vscode.Disposable | undefined = undefined;
	public async updatePullRequest(pullRequestModel: PullRequestModel): Promise<void> {
		if (this._view && !this._view.visible) {
			this._updatePendingVisibility?.dispose();
			this._updatePendingVisibility = this._view.onDidChangeVisibility(async () => {
				this.updatePullRequest(pullRequestModel);
				this._updatePendingVisibility?.dispose();
			});
		}

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

				try {
					this._view.title = `${pullRequest.title} #${pullRequestModel.number.toString()}`;
				} catch (e) {
					// If we ry to set the title of the webview too early it will throw an error.
				}

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
				const reviewState = this.getCurrentUserReviewState(this._existingReviewers, currentUser);

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
					isEnterprise: pullRequest.githubRepository.remote.isEnterprise,
					hasReviewDraft,
					currentUserReviewState: reviewState
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

	private async doReviewCommand(context: { body: string }, reviewType: ReviewType, action: (body: string) => Promise<CommonReviewEvent>) {
		const submittingMessage = {
			command: 'pr.submitting-review',
			lastReviewType: reviewType
		};
		this._postMessage(submittingMessage);
		try {
			const review = await action(context.body);
			this.updateReviewers(review);
			const reviewMessage = {
				command: 'pr.append-review',
				review,
				reviewers: this._existingReviewers
			};
			await this._postMessage(reviewMessage);
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Submitting review failed. {0}', formatError(e)));
			this._throwError(undefined, `${formatError(e)}`);
			this._postMessage({ command: 'pr.append-review' });
		}
	}

	private async doReviewMessage(message: IRequestMessage<string>, action: (body) => Promise<CommonReviewEvent>) {
		try {
			const review = await action(message.args);
			this.updateReviewers(review);
			this._replyMessage(message, {
				review: review,
				reviewers: this._existingReviewers,
			});
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Submitting review failed. {0}', formatError(e)));
			this._throwError(message, `${formatError(e)}`);
		}
	}

	private approvePullRequest(body: string): Promise<CommonReviewEvent> {
		return this._item.approve(this._folderRepositoryManager.repository, body);
	}

	private approvePullRequestMessage(message: IRequestMessage<string>): Promise<void> {
		return this.doReviewMessage(message, (body) => this.approvePullRequest(body));
	}

	private approvePullRequestCommand(context: { body: string }): Promise<void> {
		return this.doReviewCommand(context, ReviewType.Approve, (body) => this.approvePullRequest(body));
	}

	private requestChanges(body: string): Promise<CommonReviewEvent> {
		return this._item.requestChanges(body);
	}

	private requestChangesCommand(context: { body: string }): Promise<void> {
		return this.doReviewCommand(context, ReviewType.RequestChanges, (body) => this.requestChanges(body));
	}

	private requestChangesMessage(message: IRequestMessage<string>): Promise<void> {
		return this.doReviewMessage(message, (body) => this.requestChanges(body));
	}

	private submitReview(body: string): Promise<CommonReviewEvent> {
		return this._item.submitReview(ReviewEvent.Comment, body);
	}

	private submitReviewCommand(context: { body: string }) {
		return this.doReviewCommand(context, ReviewType.Comment, (body) => this.submitReview(body));
	}

	private submitReviewMessage(message: IRequestMessage<string>) {
		return this.doReviewMessage(message, (body) => this.submitReview(body));
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
			.then(result => {
				vscode.commands.executeCommand('pr.refreshList');

				this._replyMessage(message, result);
			})
			.catch(e => {
				vscode.window.showErrorMessage(vscode.l10n.t('Unable to set PR ready for review. {0}', formatError(e)));
				this._throwError(message, {});
			});
	}

	private async mergePullRequest(
		message: IRequestMessage<MergeArguments>,
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
					vscode.window.showErrorMessage(vscode.l10n.t('Merging PR failed: {0}', result?.message ?? ''));
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
