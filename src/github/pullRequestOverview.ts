/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { OpenCommitChangesArgs } from '../../common/views';
import { openPullRequestOnGitHub } from '../commands';
import { getCopilotApi } from './copilotApi';
import { SessionIdForPr } from './copilotRemoteAgent';
import { FolderRepositoryManager } from './folderRepositoryManager';
import {
	GithubItemStateEnum,
	IAccount,
	isITeam,
	ITeam,
	MergeMethod,
	MergeMethodsAvailability,
	PullRequestCheckStatus,
	PullRequestMergeability,
	ReviewEventEnum,
	ReviewState,
} from './interface';
import { IssueOverviewPanel, panelKey } from './issueOverview';
import { isCopilotOnMyBehalf, PullRequestModel } from './pullRequestModel';
import { PullRequestReviewCommon, ReviewContext } from './pullRequestReviewCommon';
import { branchPicks, pickEmail, reviewersQuickPick } from './quickPicks';
import { parseReviewers } from './utils';
import { CancelCodingAgentReply, ChangeBaseReply, ChangeReviewersReply, DeleteReviewResult, MergeArguments, MergeResult, PullRequest, ReadyForReviewAndMergeContext, ReadyForReviewContext, ReviewCommentContext, ReviewType, UnresolvedIdentity } from './views';
import { debounce } from '../common/async';
import { COPILOT_ACCOUNTS, IComment } from '../common/comment';
import { COPILOT_REVIEWER, COPILOT_REVIEWER_ACCOUNT, COPILOT_SWE_AGENT, copilotEventToStatus, CopilotPRStatus, mostRecentCopilotEvent } from '../common/copilot';
import { commands, contexts } from '../common/executeCommands';
import { disposeAll } from '../common/lifecycle';
import Logger from '../common/logger';
import { CHECKOUT_DEFAULT_BRANCH, CHECKOUT_PULL_REQUEST_BASE_BRANCH, DEFAULT_MERGE_METHOD, DELETE_BRANCH_AFTER_MERGE, POST_DONE, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { EventType, ReviewEvent, SessionLinkInfo, TimelineEvent } from '../common/timelineEvent';
import { asPromise, formatError } from '../common/utils';
import { IRequestMessage, PULL_REQUEST_OVERVIEW_VIEW_TYPE } from '../common/webview';
import { toCheckRunLogUri } from '../view/checkRunLogContentProvider';

export class PullRequestOverviewPanel extends IssueOverviewPanel<PullRequestModel> {
	public static override ID: string = 'PullRequestOverviewPanel';
	public static override readonly viewType = PULL_REQUEST_OVERVIEW_VIEW_TYPE;

	/**
	 * All open PR panels, keyed by "owner/repo#number".
	 */
	protected static override _panels: Map<string, PullRequestOverviewPanel> = new Map();

	/**
	 * Event emitter for when a PR overview becomes active
	 */
	private static _onVisible = new vscode.EventEmitter<PullRequestModel>();
	public static readonly onVisible = PullRequestOverviewPanel._onVisible.event;

	private _repositoryDefaultBranch: string;
	private _existingReviewers: ReviewState[] = [];
	private _teamsCount = 0;
	private _assignableUsers: { [key: string]: IAccount[] } = {};

	private _prListeners: vscode.Disposable[] = [];
	private _updatingPromise: Promise<unknown> | undefined;

	public static override async createOrShow(
		telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		folderRepositoryManager: FolderRepositoryManager,
		identity: UnresolvedIdentity,
		issue?: PullRequestModel,
		toTheSide: boolean = false,
		preserveFocus: boolean = true,
		existingPanel?: vscode.WebviewPanel
	) {

		/* __GDPR__
			"pr.openDescription" : {
				"isCopilot" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		telemetry.sendTelemetryEvent('pr.openDescription', { isCopilot: (issue?.author.login === COPILOT_SWE_AGENT) ? 'true' : 'false' });

		const activeColumn = toTheSide
			? vscode.ViewColumn.Beside
			: vscode.window.activeTextEditor
				? vscode.window.activeTextEditor.viewColumn
				: vscode.ViewColumn.One;

		const key = panelKey(identity.owner, identity.repo, identity.number);
		let panel = this._panels.get(key);
		if (panel) {
			panel._panel.reveal(activeColumn, preserveFocus);
		} else {
			const title = `#${identity.number.toString()}`;
			panel = new PullRequestOverviewPanel(
				telemetry,
				extensionUri,
				activeColumn || vscode.ViewColumn.Active,
				title,
				folderRepositoryManager,
				existingPanel
			);
			this._panels.set(key, panel);
		}

		await panel.updateWithIdentity(folderRepositoryManager, identity, issue);
	}

	public static scrollToReview(owner: string, repo: string, number: number): void {
		const panel = this.findPanel(owner, repo, number);
		if (panel) {
			panel.scrollToPendingReview();
		}
	}

	/**
	 * Scroll the webview to the pending review section.
	 */
	public scrollToPendingReview(): void {
		this._postMessage({ command: 'pr.scrollToPendingReview' });
	}

	/**
	 * Get the currently active pull request from the active panel
	 */
	public static getCurrentPullRequest(): PullRequestModel | undefined {
		return this.getActivePanel()?._item;
	}

	/**
	 * Return the panel whose webview is currently active (focused),
	 * or `undefined` when no PR panel is active.
	 */
	public static override getActivePanel(): PullRequestOverviewPanel | undefined {
		return super.getActivePanel() as PullRequestOverviewPanel | undefined;
	}

	/**
	 * Find the panel showing a specific pull request.
	 */
	public static override findPanel(owner: string, repo: string, number: number): PullRequestOverviewPanel | undefined {
		return super.findPanel(owner, repo, number) as PullRequestOverviewPanel | undefined;
	}

	/**
	 * Register the webview context-menu commands once globally,
	 * rather than per panel instance.  Each command receives the
	 * PR identity (owner / repo / number) from the webview context
	 * and looks up the matching panel.
	 */
	public static registerGlobalCommands(context: vscode.ExtensionContext, telemetry: ITelemetry): void {
		context.subscriptions.push(
			vscode.commands.registerCommand('pr.readyForReviewDescription', async (ctx: ReadyForReviewContext) => {
				const panel = PullRequestOverviewPanel.findPanel(ctx.owner, ctx.repo, ctx.number);
				if (panel) {
					return panel.readyForReviewCommand();
				}
			}),
			vscode.commands.registerCommand('pr.readyForReviewAndMergeDescription', async (ctx: ReadyForReviewAndMergeContext) => {
				const panel = PullRequestOverviewPanel.findPanel(ctx.owner, ctx.repo, ctx.number);
				if (panel) {
					return panel.readyForReviewAndMergeCommand(ctx);
				}
			}),
			vscode.commands.registerCommand('review.approveDescription', (ctx: ReviewCommentContext) => {
				const panel = PullRequestOverviewPanel.findPanel(ctx.owner, ctx.repo, ctx.number);
				if (panel) {
					return panel.approvePullRequestCommand(ctx);
				}
			}),
			vscode.commands.registerCommand('review.commentDescription', (ctx: ReviewCommentContext) => {
				const panel = PullRequestOverviewPanel.findPanel(ctx.owner, ctx.repo, ctx.number);
				if (panel) {
					return panel.submitReviewCommand(ctx);
				}
			}),
			vscode.commands.registerCommand('review.requestChangesDescription', (ctx: ReviewCommentContext) => {
				const panel = PullRequestOverviewPanel.findPanel(ctx.owner, ctx.repo, ctx.number);
				if (panel) {
					return panel.requestChangesCommand(ctx);
				}
			}),
			vscode.commands.registerCommand('review.approveOnDotComDescription', (ctx: ReviewCommentContext) => {
				const panel = PullRequestOverviewPanel.findPanel(ctx.owner, ctx.repo, ctx.number);
				if (panel) {
					return openPullRequestOnGitHub(panel._item, telemetry);
				}
			}),
			vscode.commands.registerCommand('review.requestChangesOnDotComDescription', (ctx: ReviewCommentContext) => {
				const panel = PullRequestOverviewPanel.findPanel(ctx.owner, ctx.repo, ctx.number);
				if (panel) {
					return openPullRequestOnGitHub(panel._item, telemetry);
				}
			}),
		);
	}

	protected constructor(
		telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		column: vscode.ViewColumn,
		title: string,
		folderRepositoryManager: FolderRepositoryManager,
		existingPanel?: vscode.WebviewPanel
	) {
		super(telemetry, extensionUri, column, title, folderRepositoryManager, PullRequestOverviewPanel.viewType, existingPanel, {
			light: 'resources/icons/git-pull-request_webview.svg',
			dark: 'resources/icons/dark/git-pull-request_webview.svg'
		});

		this.registerPrListeners();

		this.setVisibilityContext();
	}

	protected override registerPrListeners() {
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
			this._prListeners.push(this._item.onDidChange(e => {
				if ((e.state || e.comments) && !this._updatingPromise) {
					this.refreshPanel();
				}
			}));
		}
	}

	protected override onDidChangeViewState(e: vscode.WebviewPanelOnDidChangeViewStateEvent): void {
		super.onDidChangeViewState(e);
		this.setVisibilityContext();

		// If the panel becomes visible and we have an item, notify that this PR is active
		if (this._panel.visible && this._item) {
			PullRequestOverviewPanel._onVisible.fire(this._item);
		}
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
			getTimeline: () => this._getTimeline()
		};
	}

	private isUpdateBranchWithGitHubEnabled(): boolean {
		// With the GraphQL UpdatePullRequestBranch API, we can update branches even when not checked out
		// (as long as there are no conflicts). If there are conflicts, we need the branch to be checked out.
		const hasConflicts = this._item.item.mergeable === PullRequestMergeability.Conflict;
		if (hasConflicts) {
			return this._item.isActive;
		}
		return true;
	}

	protected override continueOnGitHub() {
		const isCrossRepository: boolean =
			!!this._item.base &&
			!!this._item.head &&
			!this._item.base.repositoryCloneUrl.equals(this._item.head.repositoryCloneUrl);
		return super.continueOnGitHub() && isCrossRepository;
	}

	private preLoadInfoNotRequiredForOverview(pullRequest: PullRequestModel): void {
		// Load some more info in the background, don't await.
		pullRequest.getFileChangesInfo();
	}

	protected override async updateItem(pullRequestModel: PullRequestModel): Promise<void> {
		if (this._updatingPromise) {
			Logger.error('Already updating pull request webview', PullRequestOverviewPanel.ID);
			return;
		}
		this._item = pullRequestModel;

		try {
			const updatingPromise = Promise.all([
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
				pullRequestModel.getCoAuthors(),
				pullRequestModel.validateDraftMode(),
				this._folderRepositoryManager.getAssignableUsers()
			]);
			const clearingPromise = updatingPromise.finally(() => {
				if (this._updatingPromise === clearingPromise) {
					this._updatingPromise = undefined;
				}
			});
			this._updatingPromise = clearingPromise;

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
				coAuthors,
				hasReviewDraft,
				assignableUsers
			] = await updatingPromise;

			if (!pullRequest) {
				throw new Error(
					`Fail to resolve Pull Request #${pullRequestModel.number} in ${pullRequestModel.remote.owner}/${pullRequestModel.remote.repositoryName}`,
				);
			}

			this._item = pullRequest;
			this.registerPrListeners();
			this._repositoryDefaultBranch = defaultBranch!;
			this._teamsCount = orgTeamsCount;
			this._assignableUsers = assignableUsers;
			this.setPanelTitle(this.buildPanelTitle(pullRequestModel.number, pullRequestModel.title));

			const isCurrentlyCheckedOut = pullRequestModel.equals(this._folderRepositoryManager.activePullRequest);
			const mergeMethodsAvailability = repositoryAccess!.mergeMethodsAvailability;

			const defaultMergeMethod = getDefaultMergeMethod(mergeMethodsAvailability);
			this._existingReviewers = parseReviewers(requestedReviewers!, timelineEvents!, pullRequest.author);

			const isUpdateBranchWithGitHubEnabled: boolean = this.isUpdateBranchWithGitHubEnabled();
			const reviewState = this.getCurrentUserReviewState(this._existingReviewers, currentUser);

			Logger.debug('pr.initialize', PullRequestOverviewPanel.ID);
			const users = this._assignableUsers[pullRequestModel.remote.remoteName] ?? [];
			const copilotUser = users.find(user => COPILOT_ACCOUNTS[user.login]);
			const isCopilotAlreadyReviewer = this._existingReviewers.some(reviewer => !isITeam(reviewer.reviewer) && reviewer.reviewer.login === COPILOT_REVIEWER);
			const baseContext = this.getInitializeContext(currentUser, pullRequest, timelineEvents, repositoryAccess, viewerCanEdit, users);

			this.preLoadInfoNotRequiredForOverview(pullRequest);

			const postDoneAction = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string>(POST_DONE, CHECKOUT_DEFAULT_BRANCH);
			const doneCheckoutBranch = postDoneAction.startsWith(CHECKOUT_PULL_REQUEST_BASE_BRANCH)
				? pullRequest.base.ref
				: defaultBranch;

			const context: Partial<PullRequest> = {
				...baseContext,
				canRequestCopilotReview: copilotUser !== undefined && !isCopilotAlreadyReviewer,
				isCurrentlyCheckedOut: isCurrentlyCheckedOut,
				isRemoteBaseDeleted: pullRequest.isRemoteBaseDeleted,
				base: `${pullRequest.base.owner}/${pullRequest.remote.repositoryName}:${pullRequest.base.ref}`,
				isRemoteHeadDeleted: pullRequest.isRemoteHeadDeleted,
				isLocalHeadDeleted: !branchInfo,
				head: pullRequest.head ? `${pullRequest.head.owner}/${pullRequest.remote.repositoryName}:${pullRequest.head.ref}` : '',
				repositoryDefaultBranch: defaultBranch,
				doneCheckoutBranch: doneCheckoutBranch,
				status: status[0],
				reviewRequirement: status[1],
				canUpdateBranch: pullRequest.item.viewerCanUpdate && !isBranchUpToDateWithBase && isUpdateBranchWithGitHubEnabled,
				mergeable: mergeability.mergeability,
				reviewers: this._existingReviewers,
				isDraft: pullRequest.isDraft,
				mergeMethodsAvailability,
				defaultMergeMethod,
				hasReviewDraft,
				autoMerge: pullRequest.autoMerge,
				allowAutoMerge: pullRequest.allowAutoMerge,
				autoMergeMethod: pullRequest.autoMergeMethod,
				mergeQueueMethod,
				mergeQueueEntry: pullRequest.mergeQueueEntry,
				mergeCommitMeta: pullRequest.mergeCommitMeta,
				squashCommitMeta: pullRequest.squashCommitMeta,
				isIssue: false,
				emailForCommit,
				currentUserReviewState: reviewState,
				revertable: pullRequest.state === GithubItemStateEnum.Merged,
				isCopilotOnMyBehalf: await isCopilotOnMyBehalf(pullRequest, currentUser, coAuthors),
				generateDescriptionTitle: this.getGenerateDescriptionTitle()
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

	/**
	 * Override to resolve pull requests instead of issues.
	 */
	protected override async resolveModel(identity: UnresolvedIdentity): Promise<PullRequestModel | undefined> {
		return this._folderRepositoryManager.resolvePullRequest(
			identity.owner,
			identity.repo,
			identity.number
		);
	}

	protected override getItemTypeName(): string {
		return 'Pull Request';
	}

	public override async updateWithIdentity(
		folderRepositoryManager: FolderRepositoryManager,
		identity: UnresolvedIdentity,
		pullRequestModel?: PullRequestModel,
		progressLocation?: string
	): Promise<void> {
		await super.updateWithIdentity(folderRepositoryManager, identity, pullRequestModel, progressLocation);

		// Notify that this PR overview is now active
		PullRequestOverviewPanel._onVisible.fire(this._item);
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
			case 'pr.readyForReviewAndMerge':
				return this.setReadyForReviewAndMerge(message);
			case 'pr.convertToDraft':
				return this.setConvertToDraft(message);
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
			case 'pr.open-changes':
				return this.openChanges(message);
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
				return this.gotoChangesSinceReview(message);
			case 'pr.re-request-review':
				return this.reRequestReview(message);
			case 'pr.add-reviewer-copilot':
				return this.addReviewerCopilot(message);
			case 'pr.revert':
				return this.revert(message);
			case 'pr.open-session-log':
				return this.openSessionLog(message);
			case 'pr.cancel-coding-agent':
				return this.cancelCodingAgent(message);
			case 'pr.view-check-logs':
				return this.viewCheckLogs(message);
			case 'pr.openCommitChanges':
				return this.openCommitChanges(message);
			case 'pr.delete-review':
				return this.deleteReview(message);
			case 'pr.generate-description':
				return this.generateDescription(message);
			case 'pr.cancel-generate-description':
				return this.cancelGenerateDescription();
			case 'pr.change-base-branch':
				return this.changeBaseBranch(message);
		}
	}

	private gotoChangesSinceReview(message: IRequestMessage<void>): Promise<void> {
		if (!this._item.showChangesSinceReview) {
			this._item.showChangesSinceReview = true;
		} else {
			PullRequestModel.openChanges(this._folderRepositoryManager, this._item);
		}
		return this._replyMessage(message, {});
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
				return pickedReviewers;
			});
			const hidePromise = asPromise<void>(quickPick.onDidHide);
			const allReviewers = await Promise.race<(IAccount | ITeam)[] | void>([acceptPromise, hidePromise]);
			quickPick.busy = true;
			quickPick.enabled = false;

			if (allReviewers) {
				const newUserReviewers: IAccount[] = [];
				const newTeamReviewers: ITeam[] = [];
				allReviewers.forEach(reviewer => {
					const newReviewers: (IAccount | ITeam)[] = isITeam(reviewer) ? newTeamReviewers : newUserReviewers;
					newReviewers.push(reviewer);
				});

				const removedUserReviewers: IAccount[] = [];
				const removedTeamReviewers: ITeam[] = [];
				this._existingReviewers.forEach(existing => {
					let newReviewers: (IAccount | ITeam)[] = isITeam(existing.reviewer) ? newTeamReviewers : newUserReviewers;
					let removedReviewers: (IAccount | ITeam)[] = isITeam(existing.reviewer) ? removedTeamReviewers : removedUserReviewers;
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

	protected override _getTimeline(): Promise<TimelineEvent[]> {
		return this._item.getTimelineEvents();
	}

	private async openDiff(message: IRequestMessage<{ comment: IComment }>): Promise<void> {
		try {
			const comment = message.args.comment;
			return PullRequestModel.openDiffFromComment(this._folderRepositoryManager, this._item, comment);
		} catch (e) {
			Logger.error(`Open diff view failed: ${formatError(e)}`, PullRequestOverviewPanel.ID);
		}
	}

	private async openSessionLog(message: IRequestMessage<{ link: SessionLinkInfo }>): Promise<void> {
		try {
			const resource = SessionIdForPr.getResource(this._item.number, message.args.link.sessionIndex);
			return vscode.commands.executeCommand('vscode.open', resource);
		} catch (e) {
			Logger.error(`Open session log view failed: ${formatError(e)}`, PullRequestOverviewPanel.ID);
		}
	}

	private async viewCheckLogs(message: IRequestMessage<{ status: PullRequestCheckStatus }>): Promise<void> {
		try {
			const { status } = message.args;
			if (!status.databaseId) {
				return this._replyMessage(message, { error: 'Logs are only available for GitHub Actions check runs.' });
			}
			const uri = toCheckRunLogUri({
				owner: this._item.remote.owner,
				repo: this._item.remote.repositoryName,
				checkRunDatabaseId: status.databaseId,
				checkName: status.context,
			});

			await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: false });
			return this._replyMessage(message, {});
		} catch (e) {
			Logger.error(`View check run logs failed: ${formatError(e)}`, PullRequestOverviewPanel.ID);
			return this._replyMessage(message, { error: formatError(e) });
		}
	}

	private async cancelCodingAgent(message: IRequestMessage<TimelineEvent>): Promise<void> {
		try {
			let result = false;
			if (message.args.event !== EventType.CopilotStarted) {
				return this._replyMessage(message, { success: false, error: 'Invalid event type' });
			} else {
				const copilotApi = await getCopilotApi(this._folderRepositoryManager.credentialStore, this._telemetry, this._item.remote.authProviderId);
				if (copilotApi) {
					const session = (await copilotApi.getAllSessions(this._item.id))[0];
					if (session.state !== 'completed') {
						result = await this._item.githubRepository.cancelWorkflow(session.workflow_run_id);
					}
				}
			}
			// need to wait until we get the updated timeline events
			let events: TimelineEvent[] = [];
			if (result) {
				do {
					events = await this._getTimeline();
				} while (copilotEventToStatus(mostRecentCopilotEvent(events)) !== CopilotPRStatus.Completed && await new Promise<boolean>(c => setTimeout(() => c(true), 2000)));
			}
			const reply: CancelCodingAgentReply = {
				events
			};
			this._replyMessage(message, reply);
		} catch (e) {
			Logger.error(`Cancelling coding agent failed: ${formatError(e)}`, PullRequestOverviewPanel.ID);
			vscode.window.showErrorMessage(vscode.l10n.t('Cannot cancel coding agent'));
			const reply: CancelCodingAgentReply = {
				events: [],
			};
			this._replyMessage(message, reply);
		}
	}

	private async openCommitChanges(message: IRequestMessage<OpenCommitChangesArgs>): Promise<void> {
		try {
			const { commitSha } = message.args;
			await PullRequestModel.openCommitChanges(this._extensionUri, this._item.githubRepository, commitSha);
			this._replyMessage(message, {});
		} catch (error) {
			Logger.error(`Failed to open commit changes: ${formatError(error)}`, PullRequestOverviewPanel.ID);
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to open commit changes: {0}', formatError(error)));
		}
	}

	private async openChanges(message?: IRequestMessage<{ openToTheSide?: boolean }>): Promise<void> {
		const openToTheSide = message?.args?.openToTheSide || false;
		return PullRequestModel.openChanges(this._folderRepositoryManager, this._item, openToTheSide);
	}

	private async resolveCommentThread(message: IRequestMessage<{ threadId: string, toResolve: boolean, thread: IComment[] }>) {
		try {
			if (message.args.toResolve) {
				await this._item.resolveReviewThread(message.args.threadId);
			}
			else {
				await this._item.unresolveReviewThread(message.args.threadId);
			}
			const timelineEvents = await this._getTimeline();
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

	private async mergePullRequest(
		message: IRequestMessage<MergeArguments>,
	): Promise<void> {
		const { title, description, method, email } = message.args;
		try {
			const result = await this._item.merge(this._folderRepositoryManager.repository, title, description, method, email);

			if (!result.merged) {
				vscode.window.showErrorMessage(`Merging pull request failed: ${result.message}`);
			} else {
				// Check if auto-delete branch setting is enabled
				const deleteBranchAfterMerge = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(DELETE_BRANCH_AFTER_MERGE, false);
				if (deleteBranchAfterMerge) {
					// Automatically delete the branch after successful merge
					await PullRequestReviewCommon.autoDeleteBranchesAfterMerge(this._folderRepositoryManager, this._item);
				}
			}

			const mergeResult: MergeResult = {
				state: result.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Open,
				revertable: result.merged,
				events: result.timeline
			};
			this._replyMessage(message, mergeResult);
		} catch (e) {
			vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
			this._throwError(message, '');
		}
	}

	private async changeEmail(message: IRequestMessage<string>): Promise<void> {
		const email = await pickEmail(this._item.githubRepository, message.args);
		if (email) {
			this._folderRepositoryManager.saveLastUsedEmail(email);
		}
		return this._replyMessage(message, email ?? message.args);
	}

	private async deleteBranch(message: IRequestMessage<any>) {
		const result = await PullRequestReviewCommon.deleteBranch(this._folderRepositoryManager, this._item);
		if (result.isReply) {
			this._replyMessage(message, result.message);
		} else {
			this.refreshPanel();
			this._postMessage(result.message);
		}
	}

	private async setReadyForReview(message: IRequestMessage<{}>): Promise<void> {
		return PullRequestReviewCommon.setReadyForReview(this.getReviewContext(), message);
	}

	private async setReadyForReviewAndMerge(message: IRequestMessage<{ mergeMethod: MergeMethod }>): Promise<void> {
		return PullRequestReviewCommon.setReadyForReviewAndMerge(this.getReviewContext(), message);
	}

	private async setConvertToDraft(message: IRequestMessage<{}>): Promise<void> {
		return PullRequestReviewCommon.setConvertToDraft(this.getReviewContext(), message);
	}

	private async readyForReviewCommand(): Promise<void> {
		return PullRequestReviewCommon.readyForReviewCommand(this.getReviewContext());
	}

	private async readyForReviewAndMergeCommand(context: { mergeMethod: MergeMethod }): Promise<void> {
		return PullRequestReviewCommon.readyForReviewAndMergeCommand(this.getReviewContext(), context);
	}

	private async checkoutDefaultBranch(message: IRequestMessage<string>): Promise<void> {
		return PullRequestReviewCommon.checkoutDefaultBranch(this.getReviewContext(), message);
	}

	private async doReviewCommand(context: { body: string }, reviewType: ReviewType, action: (body: string) => Promise<ReviewEvent>) {
		const result = await PullRequestReviewCommon.doReviewCommand(
			this.getReviewContext(),
			context,
			reviewType,
			true,
			action,
		);
		if (result) {
			this.tryScheduleCopilotRefresh(result.body, result.state);
		}
	}

	private async doReviewMessage(message: IRequestMessage<string>, action: (body) => Promise<ReviewEvent>) {
		const result = await PullRequestReviewCommon.doReviewMessage(
			this.getReviewContext(),
			message,
			true,
			action,
		);
		if (result) {
			this.tryScheduleCopilotRefresh(result.body, result.state);
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
		return PullRequestReviewCommon.reRequestReview(this.getReviewContext(), message);
	}

	private async addReviewerCopilot(message: IRequestMessage<void>): Promise<void> {
		try {
			const copilotUser = this._assignableUsers[this._item.remote.remoteName]?.find(user => COPILOT_ACCOUNTS[user.login]);
			if (copilotUser) {
				await this._item.requestReview([COPILOT_REVIEWER_ACCOUNT], []);
				const newReviewers = await this._item.getReviewRequests();
				this._existingReviewers = parseReviewers(newReviewers!, await this._item.getTimelineEvents(), this._item.author);
				const reply: ChangeReviewersReply = {
					reviewers: this._existingReviewers
				};
				this._replyMessage(message, reply);
			} else {
				this._throwError(message, 'Copilot reviewer not found.');
			}
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
			this._throwError(message, formatError(e));
		}
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

		// Check if auto-delete branch setting is enabled
		const deleteBranchAfterMerge = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(DELETE_BRANCH_AFTER_MERGE, false);
		if (deleteBranchAfterMerge && result) {
			// For merge queues, only delete the local branch since the PR isn't merged yet
			try {
				await PullRequestReviewCommon.autoDeleteLocalBranchAfterEnqueue(this._folderRepositoryManager, this._item);
			} catch (e) {
				Logger.appendLine(`Auto-delete local branch after enqueue failed: ${formatError(e)}`, PullRequestOverviewPanel.ID);
				void vscode.window.showWarningMessage(vscode.l10n.t('Auto-deleting the local branch after enqueueing to the merge queue failed.'));
			}
		}

		this._replyMessage(message, { mergeQueueEntry: result });
	}

	private async updateBranch(message: IRequestMessage<string>): Promise<void> {
		return PullRequestReviewCommon.updateBranch(
			this.getReviewContext(),
			message,
			() => this.refreshPanel(),
			() => this.isUpdateBranchWithGitHubEnabled()
		);
	}

	protected override editCommentPromise(comment: IComment, text: string): Promise<IComment> {
		return this._item.editReviewComment(comment, text);
	}

	protected override deleteCommentPromise(comment: IComment): Promise<void> {
		return this._item.deleteReviewComment(comment.id.toString());
	}

	private async deleteReview(message: IRequestMessage<void>) {
		try {
			const result: DeleteReviewResult = await this._item.deleteReview();
			await this._replyMessage(message, result);
		} catch (e) {
			Logger.error(formatError(e), PullRequestOverviewPanel.ID);
			vscode.window.showErrorMessage(vscode.l10n.t('Deleting review failed. {0}', formatError(e)));
			this._throwError(message, `${formatError(e)}`);
		}
	}

	private getGenerateDescriptionTitle(): string | undefined {
		const provider = this._folderRepositoryManager.getTitleAndDescriptionProvider();
		return provider ? `Generate description with ${provider.title}` : undefined;
	}

	private generatingDescriptionCancellationToken: vscode.CancellationTokenSource | undefined;

	private async generateDescription(message: IRequestMessage<void>): Promise<void> {
		if (this.generatingDescriptionCancellationToken) {
			this.generatingDescriptionCancellationToken.cancel();
		}
		this.generatingDescriptionCancellationToken = new vscode.CancellationTokenSource();

		try {
			const provider = this._folderRepositoryManager.getTitleAndDescriptionProvider();
			if (!provider) {
				return this._replyMessage(message, { description: undefined });
			}

			// Get commits and raw file changes for the PR
			const [commits, rawFileChanges] = await Promise.all([
				this._item.getCommits(),
				this._item.getRawFileChangesInfo()
			]);

			const commitMessages = commits.map(commit => commit.commit.message);
			const patches = rawFileChanges
				.filter(file => file.patch !== undefined)
				.map(file => {
					const fileUri = vscode.Uri.joinPath(this._folderRepositoryManager.repository.rootUri, file.filename).toString();
					const previousFileUri = file.previous_filename ?
						vscode.Uri.joinPath(this._folderRepositoryManager.repository.rootUri, file.previous_filename).toString() :
						undefined;
					return { patch: file.patch!, fileUri, previousFileUri };
				});

			// Get the PR template
			const templateContent = await this._folderRepositoryManager.getPullRequestTemplateBody(this._item.remote.owner);

			const result = await provider.provider.provideTitleAndDescription(
				{ commitMessages, patches, issues: [], template: templateContent },
				this.generatingDescriptionCancellationToken.token
			);

			/* __GDPR__
				"pr.generatedTitleAndDescription" : {
					"providerTitle" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
					"source" : { "classification": "SystemMetaData", "purpose": "FeatureInsight"
				}
			*/
			this._telemetry.sendTelemetryEvent('pr.generatedTitleAndDescription', { providerTitle: provider?.title, source: 'regenerate' });

			this.generatingDescriptionCancellationToken = undefined;
			return this._replyMessage(message, { description: result?.description });
		} catch (e) {
			Logger.error(`Error generating description: ${formatError(e)}`, PullRequestOverviewPanel.ID);
			this.generatingDescriptionCancellationToken = undefined;
			return this._replyMessage(message, { description: undefined });
		}
	}

	private async cancelGenerateDescription(): Promise<void> {
		if (this.generatingDescriptionCancellationToken) {
			this.generatingDescriptionCancellationToken.cancel();
			this.generatingDescriptionCancellationToken = undefined;
		}
	}

	private async changeBaseBranch(message: IRequestMessage<void>): Promise<void> {
		const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { branch?: string }>();
		let updateCounter = 0;
		const updateItems = async (prefix: string | undefined) => {
			const currentUpdate = ++updateCounter;
			quickPick.busy = true;
			const items = await branchPicks(this._item.githubRepository, this._folderRepositoryManager, undefined, true, prefix);
			if (currentUpdate === updateCounter) {
				quickPick.items = items;
				quickPick.busy = false;
			}
		};
		const debounced = debounce(updateItems, 300);
		const onDidChangeValueDisposable = quickPick.onDidChangeValue(async value => {
			return debounced(value);
		});

		try {
			quickPick.busy = true;
			quickPick.canSelectMany = false;
			quickPick.placeholder = vscode.l10n.t('Select a new base branch');
			quickPick.show();
			await updateItems(undefined);

			quickPick.busy = false;
			const acceptPromise = asPromise<void>(quickPick.onDidAccept).then(() => {
				return quickPick.selectedItems[0]?.branch;
			});
			const hidePromise = asPromise<void>(quickPick.onDidHide);
			const selectedBranch = await Promise.race<string | void>([acceptPromise, hidePromise]);
			quickPick.busy = true;
			quickPick.enabled = false;

			if (selectedBranch) {
				try {
					await this._item.updateBaseBranch(selectedBranch);
					const events = await this._getTimeline();
					const reply: ChangeBaseReply = {
						base: selectedBranch,
						events
					};
					await this._replyMessage(message, reply);
				} catch (e) {
					Logger.error(formatError(e), PullRequestOverviewPanel.ID);
					vscode.window.showErrorMessage(vscode.l10n.t('Changing base branch failed. {0}', formatError(e)));
					this._throwError(message, `${formatError(e)}`);
				}
			}
		} catch (e) {
			Logger.error(formatError(e), PullRequestOverviewPanel.ID);
			vscode.window.showErrorMessage(formatError(e));
		} finally {
			quickPick.hide();
			onDidChangeValueDisposable.dispose();
			quickPick.dispose();
		}
	}

	override dispose() {
		super.dispose();
		disposeAll(this._prListeners);
	}

	/**
	 * Static dispose method to clean up static resources
	 */
	public static dispose() {
		PullRequestOverviewPanel._onVisible.dispose();
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
