/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { openPullRequestOnGitHub } from '../commands';
import { IComment } from '../common/comment';
import { commands, contexts } from '../common/executeCommands';
import { disposeAll } from '../common/lifecycle';
import Logger from '../common/logger';
import { DEFAULT_MERGE_METHOD, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { ReviewEvent } from '../common/timelineEvent';
import { asPromise, formatError } from '../common/utils';
import { IRequestMessage, PULL_REQUEST_OVERVIEW_VIEW_TYPE } from '../common/webview';
import { FolderRepositoryManager } from './folderRepositoryManager';
import {
	GithubItemStateEnum,
	IAccount,
	isTeam,
	ITeam,
	MergeMethod,
	MergeMethodsAvailability,
	PullRequestMergeability,
	reviewerId,
	ReviewEventEnum,
	ReviewState,
} from './interface';
import { IssueOverviewPanel } from './issueOverview';
import { PullRequestModel } from './pullRequestModel';
import { PullRequestView } from './pullRequestOverviewCommon';
import { pickEmail, reviewersQuickPick } from './quickPicks';
import { parseReviewers } from './utils';
import { MergeArguments, MergeResult, PullRequest, ReviewType, SubmitReviewReply } from './views';

export class PullRequestOverviewPanel extends IssueOverviewPanel<PullRequestModel> {
	public static override ID: string = 'PullRequestOverviewPanel';
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static override currentPanel?: PullRequestOverviewPanel;

	private _repositoryDefaultBranch: string;
	private _existingReviewers: ReviewState[] = [];
	private _teamsCount = 0;

	private _prListeners: vscode.Disposable[] = [];
	private _isUpdating: boolean = false;

	public static override async createOrShow(
		telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		folderRepositoryManager: FolderRepositoryManager,
		issue: PullRequestModel,
		toTheSide: boolean = false,
		preserveFocus: boolean = true
	) {
		const activeColumn = toTheSide
			? vscode.ViewColumn.Beside
			: vscode.window.activeTextEditor
				? vscode.window.activeTextEditor.viewColumn
				: vscode.ViewColumn.One;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.currentPanel._panel.reveal(activeColumn, preserveFocus);
		} else {
			const title = `Pull Request #${issue.number.toString()}`;
			PullRequestOverviewPanel.currentPanel = new PullRequestOverviewPanel(
				telemetry,
				extensionUri,
				activeColumn || vscode.ViewColumn.Active,
				title,
				folderRepositoryManager
			);
		}

		await PullRequestOverviewPanel.currentPanel!.update(folderRepositoryManager, issue);
	}

	protected override set _currentPanel(panel: PullRequestOverviewPanel | undefined) {
		PullRequestOverviewPanel.currentPanel = panel;
	}

	public static override refresh(): void {
		if (this.currentPanel) {
			this.currentPanel.refreshPanel();
		}
	}

	public static scrollToReview(): void {
		if (this.currentPanel) {
			this.currentPanel._postMessage({ command: 'pr.scrollToPendingReview' });
		}
	}

	protected constructor(
		telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		column: vscode.ViewColumn,
		title: string,
		folderRepositoryManager: FolderRepositoryManager,
	) {
		super(telemetry, extensionUri, column, title, folderRepositoryManager, PULL_REQUEST_OVERVIEW_VIEW_TYPE, {
			light: 'resources/icons/pr_webview.svg',
			dark: 'resources/icons/dark/pr_webview.svg'
		});

		this.registerPrListeners();

		this.setVisibilityContext();
		this._register(folderRepositoryManager.onDidMergePullRequest(_ => {
			this._postMessage({
				command: 'update-state',
				state: GithubItemStateEnum.Merged,
			});
		}));

		this._register(vscode.commands.registerCommand('review.approveDescription', (e) => this.approvePullRequestCommand(e)));
		this._register(vscode.commands.registerCommand('review.commentDescription', (e) => this.submitReviewCommand(e)));
		this._register(vscode.commands.registerCommand('review.requestChangesDescription', (e) => this.requestChangesCommand(e)));
		this._register(vscode.commands.registerCommand('review.approveOnDotComDescription', () => {
			return openPullRequestOnGitHub(this._item, (this._item as any)._telemetry);
		}));
		this._register(vscode.commands.registerCommand('review.requestChangesOnDotComDescription', () => {
			return openPullRequestOnGitHub(this._item, (this._item as any)._telemetry);
		}));
	}

	registerPrListeners() {
		disposeAll(this._prListeners);
		this._prListeners.push(this._folderRepositoryManager.onDidChangeActivePullRequest(_ => {
			if (this._folderRepositoryManager && this._item) {
				const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activePullRequest);
				this._postMessage({
					command: 'pr.update-checkout-status',
					isCurrentlyCheckedOut,
				});
			}
		}));

		if (this._item) {
			this._prListeners.push(this._item.onDidChangeComments(() => {
				if (!this._isUpdating) {
					this.refreshPanel();
				}
			}));
		}
	}

	protected override onDidChangeViewState(e: vscode.WebviewPanelOnDidChangeViewStateEvent): void {
		super.onDidChangeViewState(e);
		this.setVisibilityContext();
	}

	private setVisibilityContext() {
		return commands.setContext(contexts.PULL_REQUEST_DESCRIPTION_VISIBLE, this._panel.visible);
	}

	/**
	 * Find currently configured user's review status for the current PR
	 * @param reviewers All the reviewers who have been requested to review the current PR
	 * @param pullRequestModel Model of the PR
	 */
	private getCurrentUserReviewState(reviewers: ReviewState[], currentUser: IAccount): string | undefined {
		const review = reviewers.find(r => reviewerId(r.reviewer) === currentUser.login);
		// There will always be a review. If not then the PR shouldn't have been or fetched/shown for the current user
		return review?.state;
	}

	private isUpdateBranchWithGitHubEnabled(): boolean {
		return this._item.isActive || vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get('experimentalUpdateBranchWithGitHub', false);
	}

	protected override continueOnGitHub() {
		const isCrossRepository: boolean =
			!!this._item.base &&
			!!this._item.head &&
			!this._item.base.repositoryCloneUrl.equals(this._item.head.repositoryCloneUrl);
		return super.continueOnGitHub() && isCrossRepository;
	}

	protected override async updateItem(pullRequestModel: PullRequestModel): Promise<void> {
		try {
			const [
				pullRequest,
				timelineEvents,
				defaultBranch,
				status,
				requestedReviewers,
				repositoryAccess,
				branchInfo,
				currentUser,
				viewerCanEdit,
				orgTeamsCount,
				mergeQueueMethod,
				isBranchUpToDateWithBase,
				mergeability,
				emailForCommit,
				coAuthors
			] = await Promise.all([
				this._folderRepositoryManager.resolvePullRequest(
					pullRequestModel.remote.owner,
					pullRequestModel.remote.repositoryName,
					pullRequestModel.number,
				),
				pullRequestModel.getTimelineEvents(),
				this._folderRepositoryManager.getPullRequestRepositoryDefaultBranch(pullRequestModel),
				pullRequestModel.getStatusChecks(),
				pullRequestModel.getReviewRequests(),
				this._folderRepositoryManager.getPullRequestRepositoryAccessAndMergeMethods(pullRequestModel),
				this._folderRepositoryManager.getBranchNameForPullRequest(pullRequestModel),
				this._folderRepositoryManager.getCurrentUser(pullRequestModel.githubRepository),
				pullRequestModel.canEdit(),
				this._folderRepositoryManager.getOrgTeamsCount(pullRequestModel.githubRepository),
				this._folderRepositoryManager.mergeQueueMethodForBranch(pullRequestModel.base.ref, pullRequestModel.remote.owner, pullRequestModel.remote.repositoryName),
				this._folderRepositoryManager.isHeadUpToDateWithBase(pullRequestModel),
				pullRequestModel.getMergeability(),
				this._folderRepositoryManager.getPreferredEmail(pullRequestModel),
				pullRequestModel.getCoAuthors()
			]);
			if (!pullRequest) {
				throw new Error(
					`Fail to resolve Pull Request #${pullRequestModel.number} in ${pullRequestModel.remote.owner}/${pullRequestModel.remote.repositoryName}`,
				);
			}

			this._item = pullRequest;
			this.registerPrListeners();
			this._repositoryDefaultBranch = defaultBranch!;
			this._teamsCount = orgTeamsCount;
			this.setPanelTitle(`Pull Request #${pullRequestModel.number.toString()}`);

			const isCurrentlyCheckedOut = pullRequestModel.equals(this._folderRepositoryManager.activePullRequest);
			const mergeMethodsAvailability = repositoryAccess!.mergeMethodsAvailability;

			const defaultMergeMethod = getDefaultMergeMethod(mergeMethodsAvailability);
			this._existingReviewers = parseReviewers(requestedReviewers!, timelineEvents!, pullRequest.author);

			const isUpdateBranchWithGitHubEnabled: boolean = this.isUpdateBranchWithGitHubEnabled();
			const reviewState = this.getCurrentUserReviewState(this._existingReviewers, currentUser);

			Logger.debug('pr.initialize', PullRequestOverviewPanel.ID);
			const baseContext = this.getInitializeContext(currentUser, pullRequest, coAuthors, timelineEvents, repositoryAccess, viewerCanEdit, []);

			const context: Partial<PullRequest> = {
				...baseContext,
				isCurrentlyCheckedOut: isCurrentlyCheckedOut,
				isRemoteBaseDeleted: pullRequest.isRemoteBaseDeleted,
				base: pullRequest.base.label,
				isRemoteHeadDeleted: pullRequest.isRemoteHeadDeleted,
				isLocalHeadDeleted: !branchInfo,
				head: pullRequest.head?.label ?? '',
				repositoryDefaultBranch: defaultBranch,
				status: status[0],
				reviewRequirement: status[1],
				canUpdateBranch: pullRequest.item.viewerCanUpdate && !isBranchUpToDateWithBase && isUpdateBranchWithGitHubEnabled,
				mergeable: mergeability.mergeability,
				reviewers: this._existingReviewers,
				isDraft: pullRequest.isDraft,
				mergeMethodsAvailability,
				defaultMergeMethod,
				autoMerge: pullRequest.autoMerge,
				allowAutoMerge: pullRequest.allowAutoMerge,
				autoMergeMethod: pullRequest.autoMergeMethod,
				mergeQueueMethod: mergeQueueMethod,
				mergeQueueEntry: pullRequest.mergeQueueEntry,
				mergeCommitMeta: pullRequest.mergeCommitMeta,
				squashCommitMeta: pullRequest.squashCommitMeta,
				isIssue: false,
				emailForCommit,
				currentUserReviewState: reviewState,
				revertable: pullRequest.state === GithubItemStateEnum.Merged
			};
			this._postMessage({
				command: 'pr.initialize',
				pullrequest: context
			});
			if (pullRequest.isResolved()) {
				this._folderRepositoryManager.checkBranchUpToDate(pullRequest, true);
			}
		} catch (e) {
			vscode.window.showErrorMessage(`Error updating pull request description: ${formatError(e)}`);
		}
	}

	public override async update(
		folderRepositoryManager: FolderRepositoryManager,
		pullRequestModel: PullRequestModel,
	): Promise<void> {
		if (this._folderRepositoryManager !== folderRepositoryManager) {
			this._folderRepositoryManager = folderRepositoryManager;
			this.registerPrListeners();
		}

		this._postMessage({
			command: 'set-scroll',
			scrollPosition: this._scrollPosition,
		});

		if (!this._item || (this._item.number !== pullRequestModel.number) || !this._panel.webview.html) {
			this._panel.webview.html = this.getHtmlForWebview();
		}

		return vscode.window.withProgress({ location: { viewId: 'pr:github' } }, () => this.updateItem(pullRequestModel));
	}

	protected override async _onDidReceiveMessage(message: IRequestMessage<any>) {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}
		switch (message.command) {
			case 'pr.checkout':
				return this.checkoutPullRequest(message);
			case 'pr.merge':
				return this.mergePullRequest(message);
			case 'pr.change-email':
				return this.changeEmail(message);
			case 'pr.deleteBranch':
				return this.deleteBranch(message);
			case 'pr.readyForReview':
				return this.setReadyForReview(message);
			case 'pr.approve':
				return this.approvePullRequestMessage(message);
			case 'pr.request-changes':
				return this.requestChangesMessage(message);
			case 'pr.checkout-default-branch':
				return this.checkoutDefaultBranch(message);
			case 'pr.apply-patch':
				return this.applyPatch(message);
			case 'pr.open-diff':
				return this.openDiff(message);
			case 'pr.resolve-comment-thread':
				return this.resolveCommentThread(message);
			case 'pr.checkMergeability':
				return this._replyMessage(message, await this._item.getMergeability());
			case 'pr.change-reviewers':
				return this.changeReviewers(message);
			case 'pr.update-automerge':
				return this.updateAutoMerge(message);
			case 'pr.dequeue':
				return this.dequeue(message);
			case 'pr.enqueue':
				return this.enqueue(message);
			case 'pr.update-branch':
				return this.updateBranch(message);
			case 'pr.gotoChangesSinceReview':
				return this.gotoChangesSinceReview();
			case 'pr.re-request-review':
				return this.reRequestReview(message);
			case 'pr.revert':
				return this.revert(message);
		}
	}

	private gotoChangesSinceReview() {
		this._item.showChangesSinceReview = true;
	}

	private async changeReviewers(message: IRequestMessage<void>): Promise<void> {
		let quickPick: vscode.QuickPick<vscode.QuickPickItem & {
			user?: IAccount | ITeam | undefined;
		}> | undefined;

		try {
			quickPick = await reviewersQuickPick(this._folderRepositoryManager, this._item.remote.remoteName, this._item.base.isInOrganization, this._teamsCount, this._item.author, this._existingReviewers, this._item.suggestedReviewers);
			quickPick.busy = false;
			const acceptPromise: Promise<(IAccount | ITeam)[]> = asPromise<void>(quickPick.onDidAccept).then(() => {
				const pickedReviewers: (IAccount | ITeam)[] | undefined = quickPick?.selectedItems.filter(item => item.user).map(item => item.user) as (IAccount | ITeam)[];
				const botReviewers = this._existingReviewers.filter(reviewer => !isTeam(reviewer.reviewer) && reviewer.reviewer.accountType === 'Bot').map(reviewer => reviewer.reviewer);
				return pickedReviewers.concat(botReviewers);
			});
			const hidePromise = asPromise<void>(quickPick.onDidHide);
			const allReviewers = await Promise.race<(IAccount | ITeam)[] | void>([acceptPromise, hidePromise]);
			quickPick.busy = true;
			quickPick.enabled = false;

			if (allReviewers) {
				const newUserReviewers: IAccount[] = [];
				const newTeamReviewers: ITeam[] = [];
				allReviewers.forEach(reviewer => {
					const newReviewers: (IAccount | ITeam)[] = isTeam(reviewer) ? newTeamReviewers : newUserReviewers;
					newReviewers.push(reviewer);
				});

				const removedUserReviewers: IAccount[] = [];
				const removedTeamReviewers: ITeam[] = [];
				this._existingReviewers.forEach(existing => {
					let newReviewers: (IAccount | ITeam)[] = isTeam(existing.reviewer) ? newTeamReviewers : newUserReviewers;
					let removedReviewers: (IAccount | ITeam)[] = isTeam(existing.reviewer) ? removedTeamReviewers : removedUserReviewers;
					if (!newReviewers.find(newTeamReviewer => newTeamReviewer.id === existing.reviewer.id)) {
						removedReviewers.push(existing.reviewer);
					}
				});

				await this._item.requestReview(newUserReviewers, newTeamReviewers);
				await this._item.deleteReviewRequest(removedUserReviewers, removedTeamReviewers);
				const addedReviewers: ReviewState[] = allReviewers.map(selected => {
					return {
						reviewer: selected,
						state: 'REQUESTED',
					};
				});

				this._existingReviewers = addedReviewers;
				await this._replyMessage(message, {
					reviewers: addedReviewers,
				});
			}
		} catch (e) {
			Logger.error(formatError(e), PullRequestOverviewPanel.ID);
			vscode.window.showErrorMessage(formatError(e));
		} finally {
			quickPick?.hide();
			quickPick?.dispose();
		}
	}

	private async applyPatch(message: IRequestMessage<{ comment: IComment }>): Promise<void> {
		try {
			const comment = message.args.comment;
			const regex = /```diff\n([\s\S]*)\n```/g;
			const matches = regex.exec(comment.body);

			const tempUri = vscode.Uri.joinPath(this._folderRepositoryManager.repository.rootUri, '.git', `${comment.id}.diff`);

			const encoder = new TextEncoder();

			await vscode.workspace.fs.writeFile(tempUri, encoder.encode(matches![1]));
			await this._folderRepositoryManager.repository.apply(tempUri.fsPath);
			await vscode.workspace.fs.delete(tempUri);
			vscode.window.showInformationMessage('Patch applied!');
		} catch (e) {
			Logger.error(`Applying patch failed: ${e}`, PullRequestOverviewPanel.ID);
			vscode.window.showErrorMessage(`Applying patch failed: ${formatError(e)}`);
		}
	}

	private async openDiff(message: IRequestMessage<{ comment: IComment }>): Promise<void> {
		try {
			const comment = message.args.comment;
			return PullRequestModel.openDiffFromComment(this._folderRepositoryManager, this._item, comment);
		} catch (e) {
			Logger.error(`Open diff view failed: ${formatError(e)}`, PullRequestOverviewPanel.ID);
		}
	}

	private async resolveCommentThread(message: IRequestMessage<{ threadId: string, toResolve: boolean, thread: IComment[] }>) {
		try {
			if (message.args.toResolve) {
				await this._item.resolveReviewThread(message.args.threadId);
			}
			else {
				await this._item.unresolveReviewThread(message.args.threadId);
			}
			const timelineEvents = await this._item.getTimelineEvents();
			this._replyMessage(message, timelineEvents);
		} catch (e) {
			vscode.window.showErrorMessage(e);
			this._replyMessage(message, undefined);
		}
	}

	private checkoutPullRequest(message: IRequestMessage<any>): void {
		vscode.commands.executeCommand('pr.pick', this._item).then(
			() => {
				const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activePullRequest);
				this._replyMessage(message, { isCurrentlyCheckedOut: isCurrentlyCheckedOut });
			},
			() => {
				const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activePullRequest);
				this._replyMessage(message, { isCurrentlyCheckedOut: isCurrentlyCheckedOut });
			},
		);
	}

	private mergePullRequest(
		message: IRequestMessage<MergeArguments>,
	): void {
		const { title, description, method, email } = message.args;
		this._folderRepositoryManager
			.mergePullRequest(this._item, title, description, method, email)
			.then(result => {
				vscode.commands.executeCommand('pr.refreshList');

				if (!result.merged) {
					vscode.window.showErrorMessage(`Merging PR failed: ${result.message}`);
				}

				const mergeResult: MergeResult = {
					state: result.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Open,
					revertable: result.merged,
					events: result.timeline
				};
				this._replyMessage(message, mergeResult);
			})
			.catch(e => {
				vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
				this._throwError(message, {});
			});
	}

	private async changeEmail(message: IRequestMessage<string>): Promise<void> {
		const email = await pickEmail(this._item.githubRepository, message.args);
		if (email) {
			this._folderRepositoryManager.saveLastUsedEmail(email);
		}
		return this._replyMessage(message, email ?? message.args);
	}

	private async deleteBranch(message: IRequestMessage<any>) {
		const result = await PullRequestView.deleteBranch(this._folderRepositoryManager, this._item);
		if (result.isReply) {
			this._replyMessage(message, result.message);
		} else {
			this.refreshPanel();
			this._postMessage(result.message);
		}
	}

	private setReadyForReview(message: IRequestMessage<{}>): void {
		this._item
			.setReadyForReview()
			.then(result => {
				vscode.commands.executeCommand('pr.refreshList');

				this._replyMessage(message, result);
			})
			.catch(e => {
				vscode.window.showErrorMessage(`Unable to set PR ready for review. ${formatError(e)}`);
				this._throwError(message, {});
			});
	}

	private async checkoutDefaultBranch(message: IRequestMessage<string>): Promise<void> {
		try {
			const prBranch = this._folderRepositoryManager.repository.state.HEAD?.name;
			await this._folderRepositoryManager.checkoutDefaultBranch(message.args);
			if (prBranch) {
				await this._folderRepositoryManager.cleanupAfterPullRequest(prBranch, this._item);
			}
		} finally {
			// Complete webview promise so that button becomes enabled again
			this._replyMessage(message, {});
		}
	}

	private updateReviewers(review?: ReviewEvent): void {
		if (review && review.state) {
			const existingReviewer = this._existingReviewers.find(
				reviewer => review.user.login === (reviewer.reviewer as IAccount).login,
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

	private async doReviewCommand(context: { body: string }, reviewType: ReviewType, action: (body: string) => Promise<ReviewEvent>) {
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
				event: review,
				reviewers: this._existingReviewers
			};
			await this._postMessage(reviewMessage);
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Submitting review failed. {0}', formatError(e)));
			this._throwError(undefined, `${formatError(e)}`);
		} finally {
			this._postMessage({ command: 'pr.append-review' });
		}
	}

	private async doReviewMessage(message: IRequestMessage<string>, action: (body) => Promise<ReviewEvent>) {
		try {
			const review = await action(message.args);
			this.updateReviewers(review);
			const reply: SubmitReviewReply = {
				event: review,
				reviewers: this._existingReviewers,
			};
			this._replyMessage(message, reply);
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Submitting review failed. {0}', formatError(e)));
			this._throwError(message, `${formatError(e)}`);
		}
	}

	private approvePullRequest(body: string): Promise<ReviewEvent> {
		return this._item.approve(this._folderRepositoryManager.repository, body);
	}

	private approvePullRequestMessage(message: IRequestMessage<string>): Promise<void> {
		return this.doReviewMessage(message, (body) => this.approvePullRequest(body));
	}

	private approvePullRequestCommand(context: { body: string }): Promise<void> {
		return this.doReviewCommand(context, ReviewType.Approve, (body) => this.approvePullRequest(body));
	}

	private requestChanges(body: string): Promise<ReviewEvent> {
		return this._item.requestChanges(body);
	}

	private requestChangesCommand(context: { body: string }): Promise<void> {
		return this.doReviewCommand(context, ReviewType.RequestChanges, (body) => this.requestChanges(body));
	}

	private requestChangesMessage(message: IRequestMessage<string>): Promise<void> {
		return this.doReviewMessage(message, (body) => this.requestChanges(body));
	}

	private submitReview(body: string): Promise<ReviewEvent> {
		return this._item.submitReview(ReviewEventEnum.Comment, body);
	}

	private submitReviewCommand(context: { body: string }) {
		return this.doReviewCommand(context, ReviewType.Comment, (body) => this.submitReview(body));
	}

	protected override submitReviewMessage(message: IRequestMessage<string>) {
		return this.doReviewMessage(message, (body) => this.submitReview(body));
	}

	private reRequestReview(message: IRequestMessage<string>): void {
		let targetReviewer: ReviewState | undefined;
		const userReviewers: IAccount[] = [];
		const teamReviewers: ITeam[] = [];

		for (const reviewer of this._existingReviewers) {
			let id = reviewer.reviewer.id;
			if (id && ((reviewer.state === 'REQUESTED') || (id === message.args))) {
				if (id === message.args) {
					targetReviewer = reviewer;
				}
			}
		}

		if (targetReviewer && isTeam(targetReviewer.reviewer)) {
			teamReviewers.push(targetReviewer.reviewer);
		} else if (targetReviewer && !isTeam(targetReviewer.reviewer)) {
			userReviewers.push(targetReviewer.reviewer);
		}

		this._item.requestReview(userReviewers, teamReviewers, true).then(() => {
			if (targetReviewer) {
				targetReviewer.state = 'REQUESTED';
			}
			this._replyMessage(message, {
				reviewers: this._existingReviewers,
			});
		});
	}

	private async revert(message: IRequestMessage<string>): Promise<void> {
		await this._folderRepositoryManager.createPullRequestHelper.revert(this._telemetry, this._extensionUri, this._folderRepositoryManager, this._item, async (pullRequest) => {
			const result: Partial<PullRequest> = { revertable: !pullRequest };
			return this._replyMessage(message, result);
		});
	}

	private async updateAutoMerge(message: IRequestMessage<{ autoMerge?: boolean, autoMergeMethod: MergeMethod }>): Promise<void> {
		let replyMessage: { autoMerge: boolean, autoMergeMethod?: MergeMethod };
		if (!message.args.autoMerge && !this._item.autoMerge) {
			replyMessage = { autoMerge: false };
		} else if ((message.args.autoMerge === false) && this._item.autoMerge) {
			await this._item.disableAutoMerge();
			replyMessage = { autoMerge: this._item.autoMerge };
		} else {
			if (this._item.autoMerge && message.args.autoMergeMethod !== this._item.autoMergeMethod) {
				await this._item.disableAutoMerge();
			}
			await this._item.enableAutoMerge(message.args.autoMergeMethod);
			replyMessage = { autoMerge: this._item.autoMerge, autoMergeMethod: this._item.autoMergeMethod };
		}
		this._replyMessage(message, replyMessage);
	}

	private async dequeue(message: IRequestMessage<void>): Promise<void> {
		const result = await this._item.dequeuePullRequest();
		this._replyMessage(message, result);
	}

	private async enqueue(message: IRequestMessage<void>): Promise<void> {
		const result = await this._item.enqueuePullRequest();
		this._replyMessage(message, { mergeQueueEntry: result });
	}

	private async updateBranch(message: IRequestMessage<string>): Promise<void> {
		if (!this.isUpdateBranchWithGitHubEnabled()) {
			await vscode.window.showErrorMessage(vscode.l10n.t('The pull request branch must be checked out to be updated.'), { modal: true });
			return this._replyMessage(message, {});
		}

		if (this._folderRepositoryManager.repository.state.workingTreeChanges.length > 0 || this._folderRepositoryManager.repository.state.indexChanges.length > 0) {
			await vscode.window.showErrorMessage(vscode.l10n.t('The pull request branch cannot be updated when the there changed files in the working tree or index. Stash or commit all change and then try again.'), { modal: true });
			return this._replyMessage(message, {});
		}
		const mergeSucceeded = await this._folderRepositoryManager.tryMergeBaseIntoHead(this._item, true);
		if (!mergeSucceeded) {
			this._replyMessage(message, {});
		}
		// The mergability of the PR doesn't update immediately. Poll.
		let mergability = PullRequestMergeability.Unknown;
		let attemptsRemaining = 5;
		do {
			mergability = (await this._item.getMergeability()).mergeability;
			attemptsRemaining--;
			await new Promise(c => setTimeout(c, 1000));
		} while (attemptsRemaining > 0 && mergability === PullRequestMergeability.Unknown);

		const result: Partial<PullRequest> = {
			events: await this._item.getTimelineEvents(),
			mergeable: mergability,
		};
		await this.refreshPanel();

		this._replyMessage(message, result);
	}

	protected override editCommentPromise(comment: IComment, text: string): Promise<IComment> {
		return this._item.editReviewComment(comment, text);
	}

	protected override deleteCommentPromise(comment: IComment): Promise<void> {
		return this._item.deleteReviewComment(comment.id.toString());
	}

	override dispose() {
		super.dispose();
		disposeAll(this._prListeners);
	}
}

export function getDefaultMergeMethod(
	methodsAvailability: MergeMethodsAvailability,
): MergeMethod {
	const userPreferred = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<MergeMethod>(DEFAULT_MERGE_METHOD);
	// Use default merge method specified by user if it is available
	if (userPreferred && methodsAvailability.hasOwnProperty(userPreferred) && methodsAvailability[userPreferred]) {
		return userPreferred;
	}
	const methods: MergeMethod[] = ['merge', 'squash', 'rebase'];
	// GitHub requires to have at least one merge method to be enabled; use first available as default
	return methods.find(method => methodsAvailability[method])!;
}
