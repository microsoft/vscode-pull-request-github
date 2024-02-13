/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { onDidUpdatePR, openPullRequestOnGitHub } from '../commands';
import { IComment } from '../common/comment';
import Logger from '../common/logger';
import { DEFAULT_MERGE_METHOD, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { ReviewEvent as CommonReviewEvent } from '../common/timelineEvent';
import { asPromise, dispose, formatError } from '../common/utils';
import { IRequestMessage, PULL_REQUEST_OVERVIEW_VIEW_TYPE } from '../common/webview';
import { FolderRepositoryManager } from './folderRepositoryManager';
import {
	GithubItemStateEnum,
	IAccount,
	IMilestone,
	IProject,
	IProjectItem,
	isTeam,
	ITeam,
	MergeMethod,
	MergeMethodsAvailability,
	reviewerId,
	ReviewEvent,
	ReviewState,
} from './interface';
import { IssueOverviewPanel } from './issueOverview';
import { PullRequestModel } from './pullRequestModel';
import { PullRequestView } from './pullRequestOverviewCommon';
import { getAssigneesQuickPickItems, getMilestoneFromQuickPick, getProjectFromQuickPick, pickEmail, reviewersQuickPick } from './quickPicks';
import { isInCodespaces, parseReviewers, vscodeDevPrLink } from './utils';
import { MergeArguments, ProjectItemsReply, PullRequest, ReviewType } from './views';

export class PullRequestOverviewPanel extends IssueOverviewPanel<PullRequestModel> {
	public static ID: string = 'PullRequestOverviewPanel';
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel?: PullRequestOverviewPanel;

	private _repositoryDefaultBranch: string;
	private _existingReviewers: ReviewState[] = [];
	private _teamsCount = 0;

	private _prListeners: vscode.Disposable[] = [];
	private _isUpdating: boolean = false;

	public static async createOrShow(
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
				extensionUri,
				activeColumn || vscode.ViewColumn.Active,
				title,
				folderRepositoryManager,
			);
		}

		await PullRequestOverviewPanel.currentPanel!.update(folderRepositoryManager, issue);
	}

	protected set _currentPanel(panel: PullRequestOverviewPanel | undefined) {
		PullRequestOverviewPanel.currentPanel = panel;
	}

	public static refresh(): void {
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
		extensionUri: vscode.Uri,
		column: vscode.ViewColumn,
		title: string,
		folderRepositoryManager: FolderRepositoryManager,
	) {
		super(extensionUri, column, title, folderRepositoryManager, PULL_REQUEST_OVERVIEW_VIEW_TYPE);

		this.registerPrListeners();
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

		this._disposables.push(
			folderRepositoryManager.onDidMergePullRequest(_ => {
				this._postMessage({
					command: 'update-state',
					state: GithubItemStateEnum.Merged,
				});
			}),
		);
		this._disposables.push(folderRepositoryManager.credentialStore.onDidUpgradeSession(() => {
			this.updatePullRequest(this._item);
		}));

		this._disposables.push(vscode.commands.registerCommand('review.approveDescription', (e) => this.approvePullRequestCommand(e)));
		this._disposables.push(vscode.commands.registerCommand('review.commentDescription', (e) => this.submitReviewCommand(e)));
		this._disposables.push(vscode.commands.registerCommand('review.requestChangesDescription', (e) => this.requestChangesCommand(e)));
		this._disposables.push(vscode.commands.registerCommand('review.approveOnDotComDescription', () => {
			return openPullRequestOnGitHub(this._item, (this._item as any)._telemetry);
		}));
		this._disposables.push(vscode.commands.registerCommand('review.requestChangesOnDotComDescription', () => {
			return openPullRequestOnGitHub(this._item, (this._item as any)._telemetry);
		}));
	}

	registerPrListeners() {
		dispose(this._prListeners);
		this._prListeners = [];
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

	private async updatePullRequest(pullRequestModel: PullRequestModel): Promise<void> {
		return Promise.all([
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
			this._folderRepositoryManager.isHeadUpToDateWithBase(pullRequestModel)])
			.then(result => {
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
					isBranchUpToDateWithBase
				] = result;
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
				const hasWritePermission = repositoryAccess!.hasWritePermission;
				const mergeMethodsAvailability = repositoryAccess!.mergeMethodsAvailability;
				const canEdit = hasWritePermission || viewerCanEdit;

				const defaultMergeMethod = getDefaultMergeMethod(mergeMethodsAvailability);
				this._existingReviewers = parseReviewers(requestedReviewers!, timelineEvents!, pullRequest.author);

				const isCrossRepository =
					pullRequest.base &&
					!!pullRequest.head &&
					!pullRequest.base.repositoryCloneUrl.equals(pullRequest.head.repositoryCloneUrl);

				const continueOnGitHub = isCrossRepository && isInCodespaces();
				const reviewState = this.getCurrentUserReviewState(this._existingReviewers, currentUser);
				Logger.debug('pr.initialize', PullRequestOverviewPanel.ID);
				const context: Partial<PullRequest> = {
					number: pullRequest.number,
					title: pullRequest.title,
					titleHTML: pullRequest.titleHTML,
					url: pullRequest.html_url,
					createdAt: pullRequest.createdAt,
					body: pullRequest.body,
					bodyHTML: pullRequest.bodyHTML,
					labels: pullRequest.item.labels,
					author: {
						id: pullRequest.author.id,
						login: pullRequest.author.login,
						name: pullRequest.author.name,
						avatarUrl: pullRequest.userAvatar,
						url: pullRequest.author.url,
					},
					state: pullRequest.state,
					events: timelineEvents,
					isCurrentlyCheckedOut: isCurrentlyCheckedOut,
					isRemoteBaseDeleted: pullRequest.isRemoteBaseDeleted,
					base: pullRequest.base.label,
					isRemoteHeadDeleted: pullRequest.isRemoteHeadDeleted,
					isLocalHeadDeleted: !branchInfo,
					head: pullRequest.head?.label ?? '',
					repositoryDefaultBranch: defaultBranch,
					canEdit: canEdit,
					hasWritePermission,
					status: status[0],
					reviewRequirement: status[1],
					canUpdateBranch: pullRequest.item.viewerCanUpdate && !isBranchUpToDateWithBase,
					mergeable: pullRequest.item.mergeable,
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
					projectItems: pullRequest.item.projectItems,
					milestone: pullRequest.milestone,
					assignees: pullRequest.assignees,
					continueOnGitHub,
					emailForCommit: currentUser.email,
					isAuthor: currentUser.login === pullRequest.author.login,
					currentUserReviewState: reviewState,
					isDarkTheme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark,
					isEnterprise: pullRequest.githubRepository.remote.isEnterprise
				};
				this._postMessage({
					command: 'pr.initialize',
					pullrequest: context
				});
				if (pullRequest.isResolved()) {
					this._folderRepositoryManager.checkBranchUpToDate(pullRequest, true);
				}
			})
			.catch(e => {
				vscode.window.showErrorMessage(formatError(e));
			});
	}

	public async update(
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
			this._panel.webview.html = this.getHtmlForWebview(pullRequestModel.number.toString());
		}

		return this.updatePullRequest(pullRequestModel);
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>) {
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
			case 'pr.submit':
				return this.submitReviewMessage(message);
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
			case 'pr.remove-milestone':
				return this.removeMilestone(message);
			case 'pr.add-milestone':
				return this.addMilestone(message);
			case 'pr.change-projects':
				return this.changeProjects(message);
			case 'pr.remove-project':
				return this.removeProject(message);
			case 'pr.change-assignees':
				return this.changeAssignees(message);
			case 'pr.add-assignee-yourself':
				return this.addAssigneeYourself(message);
			case 'pr.copy-prlink':
				return this.copyPrLink();
			case 'pr.copy-vscodedevlink':
				return this.copyVscodeDevLink();
			case 'pr.openOnGitHub':
				return openPullRequestOnGitHub(this._item, (this._item as any)._telemetry);
			case 'pr.update-automerge':
				return this.updateAutoMerge(message);
			case 'pr.dequeue':
				return this.dequeue(message);
			case 'pr.enqueue':
				return this.enqueue(message);
			case 'pr.update-branch':
				return this.updateBranch(message);
			case 'pr.gotoChangesSinceReview':
				this.gotoChangesSinceReview();
				break;
			case 'pr.re-request-review':
				this.reRequestReview(message);
				break;
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
			const acceptPromise = asPromise<void>(quickPick.onDidAccept).then(() => {
				return quickPick!.selectedItems.filter(item => item.user) as (vscode.QuickPickItem & { user: IAccount | ITeam })[] | undefined;
			});
			const hidePromise = asPromise<void>(quickPick.onDidHide);
			const allReviewers = await Promise.race<(vscode.QuickPickItem & { user: IAccount | ITeam })[] | void>([acceptPromise, hidePromise]);
			quickPick.busy = true;

			if (allReviewers) {
				const newUserReviewers: string[] = [];
				const newTeamReviewers: string[] = [];
				allReviewers.forEach(reviewer => {
					const newReviewers = isTeam(reviewer.user) ? newTeamReviewers : newUserReviewers;
					newReviewers.push(reviewer.user.id);
				});

				const removedUserReviewers: string[] = [];
				const removedTeamReviewers: string[] = [];
				this._existingReviewers.forEach(existing => {
					let newReviewers: string[] = isTeam(existing.reviewer) ? newTeamReviewers : newUserReviewers;
					let removedReviewers: string[] = isTeam(existing.reviewer) ? removedTeamReviewers : removedUserReviewers;
					if (!newReviewers.find(newTeamReviewer => newTeamReviewer === existing.reviewer.id)) {
						removedReviewers.push(existing.reviewer.id);
					}
				});

				await this._item.requestReview(newUserReviewers, newTeamReviewers);
				await this._item.deleteReviewRequest(removedUserReviewers, removedTeamReviewers);
				const addedReviewers: ReviewState[] = allReviewers.map(selected => {
					return {
						reviewer: selected.user,
						state: 'REQUESTED',
					};
				});

				this._existingReviewers = addedReviewers;
				await this._replyMessage(message, {
					reviewers: addedReviewers,
				});
			}
		} catch (e) {
			Logger.error(formatError(e));
			vscode.window.showErrorMessage(formatError(e));
		} finally {
			quickPick?.hide();
			quickPick?.dispose();
		}
	}

	private async addMilestone(message: IRequestMessage<void>): Promise<void> {
		return getMilestoneFromQuickPick(this._folderRepositoryManager, this._item.githubRepository, this._item.milestone, (milestone) => this.updateMilestone(milestone, message));
	}

	private async updateMilestone(milestone: IMilestone | undefined, message: IRequestMessage<void>) {
		if (!milestone) {
			return this.removeMilestone(message);
		}
		await this._item.updateMilestone(milestone.id);
		this._replyMessage(message, {
			added: milestone,
		});
	}

	private async removeMilestone(message: IRequestMessage<void>): Promise<void> {
		try {
			await this._item.updateMilestone('null');
			this._replyMessage(message, {});
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async changeProjects(message: IRequestMessage<void>): Promise<void> {
		return getProjectFromQuickPick(this._folderRepositoryManager, this._item.githubRepository, this._item.item.projectItems?.map(item => item.project), (project) => this.updateProjects(project, message));
	}

	private async updateProjects(projects: IProject[] | undefined, message: IRequestMessage<void>) {
		if (projects) {
			const newProjects = await this._item.updateProjects(projects);
			const projectItemsReply: ProjectItemsReply = {
				projectItems: newProjects,
			};
			return this._replyMessage(message, projectItemsReply);
		}
	}

	private async removeProject(message: IRequestMessage<IProjectItem>): Promise<void> {
		await this._item.removeProjects([message.args]);
		return this._replyMessage(message, {});
	}

	private async changeAssignees(message: IRequestMessage<void>): Promise<void> {
		const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { user?: IAccount }>();

		try {
			quickPick.busy = true;
			quickPick.canSelectMany = true;
			quickPick.matchOnDescription = true;
			quickPick.show();
			quickPick.items = await getAssigneesQuickPickItems(this._folderRepositoryManager, undefined, this._item.remote.remoteName, this._item.assignees ?? [], this._item);
			quickPick.selectedItems = quickPick.items.filter(item => item.picked);

			quickPick.busy = false;
			const acceptPromise = asPromise<void>(quickPick.onDidAccept).then(() => {
				return quickPick.selectedItems.filter(item => item.user) as (vscode.QuickPickItem & { user: IAccount })[] | undefined;
			});
			const hidePromise = asPromise<void>(quickPick.onDidHide);
			const allAssignees = await Promise.race<(vscode.QuickPickItem & { user: IAccount })[] | void>([acceptPromise, hidePromise]);
			quickPick.busy = true;

			if (allAssignees) {
				const newAssignees: IAccount[] = allAssignees.map(item => item.user);
				const removeAssignees: IAccount[] = this._item.assignees?.filter(currentAssignee => !newAssignees.find(newAssignee => newAssignee.login === currentAssignee.login)) ?? [];
				this._item.assignees = newAssignees;

				await this._item.addAssignees(newAssignees.map(assignee => assignee.login));
				await this._item.deleteAssignees(removeAssignees.map(assignee => assignee.login));
				await this._replyMessage(message, {
					assignees: newAssignees,
				});
			}
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		} finally {
			quickPick.hide();
			quickPick.dispose();
		}
	}

	private async addAssigneeYourself(message: IRequestMessage<void>): Promise<void> {
		try {
			const currentUser = await this._folderRepositoryManager.getCurrentUser();
			const alreadyAssigned = this._item.assignees?.find(user => user.login === currentUser.login);
			if (!alreadyAssigned) {
				this._item.assignees = this._item.assignees?.concat(currentUser);
				await this._item.addAssignees([currentUser.login]);
			}
			this._replyMessage(message, {
				assignees: this._item.assignees,
			});
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
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

				this._replyMessage(message, {
					state: result.merged ? GithubItemStateEnum.Merged : GithubItemStateEnum.Open,
				});
			})
			.catch(e => {
				vscode.window.showErrorMessage(`Unable to merge pull request. ${formatError(e)}`);
				this._throwError(message, {});
			});
	}

	private async changeEmail(message: IRequestMessage<string>): Promise<void> {
		const email = await pickEmail(this._item.githubRepository, message.args);
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

	private updateReviewers(review?: CommonReviewEvent): void {
		if (review) {
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
		} finally {
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

	private async copyPrLink(): Promise<void> {
		return vscode.env.clipboard.writeText(this._item.html_url);
	}

	private async copyVscodeDevLink(): Promise<void> {
		return vscode.env.clipboard.writeText(vscodeDevPrLink(this._item));
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
		if (this._folderRepositoryManager.repository.state.workingTreeChanges.length > 0 || this._folderRepositoryManager.repository.state.indexChanges.length > 0) {
			await vscode.window.showErrorMessage(vscode.l10n.t('The pull request branch cannot be updated when the there changed files in the working tree or index. Stash or commit all change and then try again.'), { modal: true });
			return this._replyMessage(message, {});
		}
		await this._folderRepositoryManager.tryMergeBaseIntoHead(this._item, true);
		await this.refreshPanel();

		this._replyMessage(message, {});
	}

	protected editCommentPromise(comment: IComment, text: string): Promise<IComment> {
		return this._item.editReviewComment(comment, text);
	}

	protected deleteCommentPromise(comment: IComment): Promise<void> {
		return this._item.deleteReviewComment(comment.id.toString());
	}

	dispose() {
		super.dispose();
		dispose(this._prListeners);
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
