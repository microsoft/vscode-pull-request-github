/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { openPullRequestOnGitHub } from '../commands';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GithubItemStateEnum, IAccount, MergeMethod, ReviewEventEnum, ReviewState } from './interface';
import { isCopilotOnMyBehalf, PullRequestModel } from './pullRequestModel';
import { getDefaultMergeMethod } from './pullRequestOverview';
import { PullRequestReviewCommon, ReviewContext } from './pullRequestReviewCommon';
import { isInCodespaces, parseReviewers } from './utils';
import { MergeArguments, PullRequest, ReviewType } from './views';
import { IComment } from '../common/comment';
import { emojify, ensureEmojis } from '../common/emoji';
import { disposeAll } from '../common/lifecycle';
import { ReviewEvent } from '../common/timelineEvent';
import { formatError } from '../common/utils';
import { generateUuid } from '../common/uuid';
import { IRequestMessage, WebviewViewBase } from '../common/webview';
import { ReviewManager } from '../view/reviewManager';

export class PullRequestViewProvider extends WebviewViewBase implements vscode.WebviewViewProvider {
	public override readonly viewType = 'github:activePullRequest';
	private _existingReviewers: ReviewState[] = [];
	private _isUpdating: boolean = false;

	constructor(
		extensionUri: vscode.Uri,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private readonly _reviewManager: ReviewManager,
		private _item: PullRequestModel,
	) {
		super(extensionUri);

		this._register(vscode.commands.registerCommand('pr.readyForReview', async () => {
			return this.readyForReviewCommand();
		}));
		this._register(vscode.commands.registerCommand('pr.readyForReviewAndMerge', async (context: { mergeMethod: MergeMethod }) => {
			return this.readyForReviewAndMergeCommand(context);
		}));
		this._register(vscode.commands.registerCommand('review.approve', (e: { body: string }) => this.approvePullRequestCommand(e)));
		this._register(vscode.commands.registerCommand('review.comment', (e: { body: string }) => this.submitReviewCommand(e)));
		this._register(vscode.commands.registerCommand('review.requestChanges', (e: { body: string }) => this.requestChangesCommand(e)));
		this._register(vscode.commands.registerCommand('review.approveOnDotCom', () => {
			return openPullRequestOnGitHub(this._item, this._folderRepositoryManager.telemetry);
		}));
		this._register(vscode.commands.registerCommand('review.requestChangesOnDotCom', () => {
			return openPullRequestOnGitHub(this._item, this._folderRepositoryManager.telemetry);
		}));
	}

	public override resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		super.resolveWebviewView(webviewView, _context, _token);
		webviewView.webview.html = this._getHtmlForWebview();

		this.updatePullRequest(this._item);
	}

	private async updateBranch(message: IRequestMessage<string>): Promise<void> {
		return PullRequestReviewCommon.updateBranch(
			this.getReviewContext(),
			message,
			() => this.refresh()
		);
	}

	protected override async _onDidReceiveMessage(message: IRequestMessage<any>) {
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
				return openPullRequestOnGitHub(this._item, this._folderRepositoryManager.telemetry);
			case 'pr.checkout-default-branch':
				return this.checkoutDefaultBranch(message);
			case 'pr.update-branch':
				return this.updateBranch(message);
			case 'pr.re-request-review':
				return this.reRequestReview(message);
		}
	}

	private async checkoutDefaultBranch(message: IRequestMessage<string>): Promise<void> {
		return PullRequestReviewCommon.checkoutDefaultBranch(this.getReviewContext(), message);
	}

	private reRequestReview(message: IRequestMessage<string>): void {
		return PullRequestReviewCommon.reRequestReview(this.getReviewContext(), message);
	}

	public async refresh(): Promise<void> {
		return vscode.window.withProgress({ location: { viewId: 'github:activePullRequest' } }, async () => {
			await this._item.initializeReviewThreadCache();
			await this.updatePullRequest(this._item);
		});
	}

	private getCurrentUserReviewState(reviewers: ReviewState[], currentUser: IAccount): string | undefined {
		return PullRequestReviewCommon.getCurrentUserReviewState(reviewers, currentUser);
	}

	/**
	 * Get the review context for helper functions
	 */
	private getReviewContext(): ReviewContext {
		return {
			item: this._item,
			folderRepositoryManager: this._folderRepositoryManager,
			existingReviewers: this._existingReviewers,
			postMessage: (message: any) => this._postMessage(message),
			replyMessage: (message: IRequestMessage<any>, response: any) => this._replyMessage(message, response),
			throwError: (message: IRequestMessage<any> | undefined, error: string) => this._throwError(message, error),
			getTimeline: () => this._item.getTimelineEvents()
		};
	}

	private _prDisposables: vscode.Disposable[] | undefined = undefined;
	private registerPrSpecificListeners(pullRequestModel: PullRequestModel) {
		if (this._prDisposables !== undefined) {
			disposeAll(this._prDisposables);
		}
		this._prDisposables = [];
		this._prDisposables.push(pullRequestModel.onDidChange(e => {
			if ((e.state || e.comments || e.reviewers) && !this._isUpdating) {
				this.updatePullRequest(pullRequestModel);
			}
		}));
		this._prDisposables.push(pullRequestModel.onDidChangePendingReviewState(() => this.updatePullRequest(pullRequestModel)));
	}

	private _updatePendingVisibility: vscode.Disposable | undefined = undefined;
	public async updatePullRequest(pullRequestModel: PullRequestModel): Promise<void> {
		if (this._isUpdating) {
			throw new Error('Already updating pull request view');
		}
		this._isUpdating = true;

		try {
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
			const [pullRequest, repositoryAccess, timelineEvents, requestedReviewers, branchInfo, defaultBranch, currentUser, viewerCanEdit, hasReviewDraft, coAuthors] = await Promise.all([
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
				pullRequestModel.validateDraftMode(),
				pullRequestModel.getCoAuthors(),
				ensureEmojis(this._folderRepositoryManager.context)
			]);

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
				this._view.title = `${vscode.l10n.t('Review Pull Request')} #${pullRequestModel.number.toString()}`;
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
				labels: pullRequest.item.labels.map(label => ({ ...label, displayName: emojify(label.name) })),
				author: {
					login: pullRequest.author.login,
					name: pullRequest.author.name,
					avatarUrl: pullRequest.userAvatar,
					url: pullRequest.author.url,
					email: pullRequest.author.email,
					id: pullRequest.author.id,
					accountType: pullRequest.author.accountType,
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
				canUpdateBranch: pullRequest.item.viewerCanUpdate,
				events: timelineEvents,
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
				currentUserReviewState: reviewState,
				isCopilotOnMyBehalf: await isCopilotOnMyBehalf(pullRequest, currentUser, coAuthors)
			};

			this._postMessage({
				command: 'pr.initialize',
				pullrequest: context,
			});

		} catch (e) {
			vscode.window.showErrorMessage(`Error updating active pull request view: ${formatError(e)}`);
		} finally {
			this._isUpdating = false;
		}
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


	private async doReviewCommand(context: { body: string }, reviewType: ReviewType, action: (body: string) => Promise<ReviewEvent>) {
		return PullRequestReviewCommon.doReviewCommand(
			this.getReviewContext(),
			context,
			reviewType,
			false,
			action
		);
	}

	private async doReviewMessage(message: IRequestMessage<string>, action: (body) => Promise<ReviewEvent>) {
		return PullRequestReviewCommon.doReviewMessage(
			this.getReviewContext(),
			message,
			false,
			action
		);
	}

	private approvePullRequest(body: string): Promise<ReviewEvent> {
		return this._item.approve(this._folderRepositoryManager.repository, body);
	}

	private async approvePullRequestMessage(message: IRequestMessage<string>): Promise<void> {
		await this.doReviewMessage(message, (body) => this.approvePullRequest(body));
	}

	private async approvePullRequestCommand(context: { body: string }): Promise<void> {
		await this.doReviewCommand(context, ReviewType.Approve, (body) => this.approvePullRequest(body));
	}

	private requestChanges(body: string): Promise<ReviewEvent> {
		return this._item.requestChanges(body);
	}

	private async requestChangesCommand(context: { body: string }): Promise<void> {
		await this.doReviewCommand(context, ReviewType.RequestChanges, (body) => this.requestChanges(body));
	}

	private async requestChangesMessage(message: IRequestMessage<string>): Promise<void> {
		await this.doReviewMessage(message, (body) => this.requestChanges(body));
	}

	private submitReview(body: string): Promise<ReviewEvent> {
		return this._item.submitReview(ReviewEventEnum.Comment, body);
	}

	private submitReviewCommand(context: { body: string }) {
		return this.doReviewCommand(context, ReviewType.Comment, (body) => this.submitReview(body));
	}

	private submitReviewMessage(message: IRequestMessage<string>) {
		return this.doReviewMessage(message, (body) => this.submitReview(body));
	}

	private async deleteBranch(message: IRequestMessage<any>) {
		const result = await PullRequestReviewCommon.deleteBranch(this._folderRepositoryManager, this._item);
		if (result.isReply) {
			this._replyMessage(message, result.message);
		} else {
			this._postMessage(result.message);
		}
	}

	private async setReadyForReview(message: IRequestMessage<Record<string, unknown>>): Promise<void> {
		return PullRequestReviewCommon.setReadyForReview(this.getReviewContext(), message);
	}

	private async readyForReviewCommand(): Promise<void> {
		return PullRequestReviewCommon.readyForReviewCommand(this.getReviewContext());
	}

	private async readyForReviewAndMergeCommand(context: { mergeMethod: MergeMethod }): Promise<void> {
		return PullRequestReviewCommon.readyForReviewAndMergeCommand(this.getReviewContext(), context);
	}

	private async mergePullRequest(
		message: IRequestMessage<MergeArguments>,
	): Promise<void> {
		const { title, description, method } = message.args;
		const email = await this._folderRepositoryManager.getPreferredEmail(this._item);
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
		try {
			const result = await this._item.merge(this._folderRepositoryManager.repository, title, description, method, email);

			if (!result.merged) {
				vscode.window.showErrorMessage(vscode.l10n.t('Merging pull request failed: {0}', result?.message ?? ''));
			}

			this._replyMessage(message, {
				state: result.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Open,
			});

		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Unable to merge pull request. {0}', formatError(e)));
			this._throwError(message, '');
		}
	}

	private _getHtmlForWebview() {
		const nonce = generateUuid();

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
