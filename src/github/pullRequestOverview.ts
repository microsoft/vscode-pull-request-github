/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { onDidUpdatePR, openPullRequestOnGitHub } from '../commands';
import { IComment } from '../common/comment';
import Logger from '../common/logger';
import { ReviewEvent as CommonReviewEvent } from '../common/timelineEvent';
import { dispose, formatError } from '../common/utils';
import { IRequestMessage, PULL_REQUEST_OVERVIEW_VIEW_TYPE } from '../common/webview';
import { FolderRepositoryManager } from './folderRepositoryManager';
import {
	GithubItemStateEnum,
	IAccount,
	IMilestone,
	ISuggestedReviewer,
	MergeMethod,
	MergeMethodsAvailability,
	ReviewEvent,
	ReviewState,
} from './interface';
import { IssueOverviewPanel } from './issueOverview';
import { PullRequestModel } from './pullRequestModel';
import { PullRequestView } from './pullRequestOverviewCommon';
import { isInCodespaces, parseReviewers } from './utils';

type MilestoneQuickPickItem = vscode.QuickPickItem & { id: string; milestone: IMilestone };

function isMilestoneQuickPickItem(x: vscode.QuickPickItem | MilestoneQuickPickItem): x is MilestoneQuickPickItem {
	return !!(x as MilestoneQuickPickItem).id && !!(x as MilestoneQuickPickItem).milestone;
}

export class PullRequestOverviewPanel extends IssueOverviewPanel<PullRequestModel> {
	public static ID: string = 'PullRequestOverviewPanel';
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel?: PullRequestOverviewPanel;

	private _repositoryDefaultBranch: string;
	private _existingReviewers: ReviewState[] = [];

	private _prListeners: vscode.Disposable[] = [];

	public static async createOrShow(
		extensionUri: vscode.Uri,
		folderRepositoryManager: FolderRepositoryManager,
		issue: PullRequestModel,
		toTheSide: Boolean = false,
	) {
		const activeColumn = toTheSide
			? vscode.ViewColumn.Beside
			: vscode.window.activeTextEditor
				? vscode.window.activeTextEditor.viewColumn
				: vscode.ViewColumn.One;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.currentPanel._panel.reveal(activeColumn, true);
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

		this.registerFolderRepositoryListener();

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
	}

	registerFolderRepositoryListener() {
		this._prListeners.push(this._folderRepositoryManager.onDidChangeActivePullRequest(_ => {
			if (this._folderRepositoryManager && this._item) {
				const isCurrentlyCheckedOut = this._item.equals(this._folderRepositoryManager.activePullRequest);
				this._postMessage({
					command: 'pr.update-checkout-status',
					isCurrentlyCheckedOut,
				});
			}
		}));
	}

	registerPrListeners() {
		this._prListeners.push(this._item.onDidChangeComments(() => {
			this.refreshPanel();
		}));
	}

	/**
	 * Find currently configured user's review status for the current PR
	 * @param reviewers All the reviewers who have been requested to review the current PR
	 * @param pullRequestModel Model of the PR
	 */
	private getCurrentUserReviewState(reviewers: ReviewState[], currentUser: IAccount): string | undefined {
		const review = reviewers.find(r => r.reviewer.login === currentUser.login);
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
		])
			.then(result => {
				const [
					pullRequest,
					timelineEvents,
					defaultBranch,
					status,
					requestedReviewers,
					repositoryAccess,
					branchInfo,
				] = result;
				if (!pullRequest) {
					throw new Error(
						`Fail to resolve Pull Request #${pullRequestModel.number} in ${pullRequestModel.remote.owner}/${pullRequestModel.remote.repositoryName}`,
					);
				}

				this._item = pullRequest;
				this.registerPrListeners();
				this._repositoryDefaultBranch = defaultBranch!;
				this._panel.title = `Pull Request #${pullRequestModel.number.toString()}`;

				const isCurrentlyCheckedOut = pullRequestModel.equals(this._folderRepositoryManager.activePullRequest);
				const hasWritePermission = repositoryAccess!.hasWritePermission;
				const mergeMethodsAvailability = repositoryAccess!.mergeMethodsAvailability;
				const canEdit = hasWritePermission || this._item.canEdit();

				const defaultMergeMethod = getDefaultMergeMethod(mergeMethodsAvailability);
				this._existingReviewers = parseReviewers(requestedReviewers!, timelineEvents!, pullRequest.author);
				const currentUser = this._folderRepositoryManager.getCurrentUser(this._item.githubRepository);

				const isCrossRepository =
					pullRequest.base &&
					pullRequest.head &&
					!pullRequest.base.repositoryCloneUrl.equals(pullRequest.head.repositoryCloneUrl);

				const continueOnGitHub = isCrossRepository && isInCodespaces();
				const reviewState = this.getCurrentUserReviewState(this._existingReviewers, currentUser);
				Logger.debug('pr.initialize', PullRequestOverviewPanel.ID);
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
						status: status ? status : { statuses: [] },
						mergeable: pullRequest.item.mergeable,
						reviewers: this._existingReviewers,
						isDraft: pullRequest.isDraft,
						mergeMethodsAvailability,
						defaultMergeMethod,
						autoMerge: pullRequest.autoMerge,
						allowAutoMerge: pullRequest.allowAutoMerge,
						autoMergeMethod: pullRequest.autoMergeMethod,
						isIssue: false,
						milestone: pullRequest.milestone,
						assignees: pullRequest.assignees,
						continueOnGitHub,
						isAuthor: currentUser.login === pullRequest.author.login,
						currentUserReviewState: reviewState,
						isDarkTheme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
					},
				});
				if (pullRequest.isResolved()) {
					this._folderRepositoryManager.checkBranchUpToDate(pullRequest);
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
			dispose(this._prListeners);
			this._prListeners = [];
			this.registerFolderRepositoryListener();
			this.registerPrListeners();
		}

		this._postMessage({
			command: 'set-scroll',
			scrollPosition: this._scrollPosition,
		});

		this._panel.webview.html = this.getHtmlForWebview(pullRequestModel.number.toString());

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
			case 'pr.checkout-default-branch':
				return this.checkoutDefaultBranch(message);
			case 'pr.apply-patch':
				return this.applyPatch(message);
			case 'pr.open-diff':
				return this.openDiff(message);
			case 'pr.resolve-comment-thread':
				return this.resolveComentThread(message);
			case 'pr.checkMergeability':
				return this._replyMessage(message, await this._item.getMergeability());
			case 'pr.add-reviewers':
				return this.addReviewers(message);
			case 'pr.remove-milestone':
				return this.removeMilestone(message);
			case 'pr.add-milestone':
				return this.addMilestone(message);
			case 'pr.add-assignees':
				return this.addAssignees(message);
			case 'pr.add-assignee-yourself':
				return this.addAssigneeYourself(message);
			case 'pr.remove-reviewer':
				return this.removeReviewer(message);
			case 'pr.remove-assignee':
				return this.removeAssignee(message);
			case 'pr.copy-prlink':
				return this.copyPrLink();
			case 'pr.openOnGitHub':
				return openPullRequestOnGitHub(this._item, (this._item as any)._telemetry);
			case 'pr.update-automerge':
				return this.updateAutoMerge(message);
			case 'pr.gotoChangesSinceReview':
				this.gotoChangesSinceReview();
				break;
		}
	}

	private gotoChangesSinceReview() {
		this._item.showChangesSinceReview = true;
	}

	private async getReviewersQuickPickItems(
		suggestedReviewers: ISuggestedReviewer[] | undefined,
	): Promise<(vscode.QuickPickItem & { reviewer?: IAccount })[]> {
		if (!suggestedReviewers) {
			return [];
		}

		const allAssignableUsers = await this._folderRepositoryManager.getAssignableUsers();
		const assignableUsers = allAssignableUsers[this._item.remote.remoteName] ?? [];

		// used to track logins that shouldn't be added to pick list
		// e.g. author, existing and already added reviewers
		const skipList: Set<string> = new Set([
			this._item.author.login,
			...this._existingReviewers.map(reviewer => reviewer.reviewer.login),
		]);

		const reviewers: (vscode.QuickPickItem & { reviewer?: IAccount })[] = [];
		for (const user of suggestedReviewers) {
			const { login, name, isAuthor, isCommenter } = user;
			if (skipList.has(login)) {
				continue;
			}

			const suggestionReason: string =
				isAuthor && isCommenter
					? 'Recently edited and reviewed changes to these files'
					: isAuthor
						? 'Recently edited these files'
						: isCommenter
							? 'Recently reviewed changes to these files'
							: 'Suggested reviewer';

			reviewers.push({
				label: login,
				description: name,
				detail: suggestionReason,
				reviewer: user,
			});
			// this user shouldn't be added later from assignable users list
			skipList.add(login);
		}

		for (const user of assignableUsers) {
			if (skipList.has(user.login)) {
				continue;
			}

			reviewers.push({
				label: user.login,
				description: user.name,
				reviewer: user,
			});
		}

		if (reviewers.length === 0) {
			reviewers.push({
				label: 'No reviewers available for this repository'
			});
		}

		return reviewers;
	}
	private async getAssigneesQuickPickItems():
		Promise<(vscode.QuickPickItem & { assignee?: IAccount })[]> {

		const [allAssignableUsers, { participants, viewer }] = await Promise.all([
			this._folderRepositoryManager.getAssignableUsers(),
			this._folderRepositoryManager.getPullRequestParticipants(this._item.githubRepository, this._item.number)
		]);

		let assignableUsers = allAssignableUsers[this._item.remote.remoteName];

		assignableUsers = assignableUsers ?? [];
		// used to track logins that shouldn't be added to pick list
		// e.g. author, existing and already added reviewers
		const skipList: Set<string> = new Set([...(this._item.assignees?.map(assignee => assignee.login) ?? [])]);

		const assignees: (vscode.QuickPickItem & { assignee?: IAccount })[] = [];
		// Check if the viewer is allowed to be assigned to the PR
		if (assignableUsers.findIndex((assignableUser: IAccount) => assignableUser.login === viewer.login) !== -1) {
			assignees.push({
				label: viewer.login,
				description: viewer.name,
				assignee: viewer,
			});
			skipList.add(viewer.login);
		}

		for (const suggestedReviewer of participants) {
			if (skipList.has(suggestedReviewer.login)) {
				continue;
			}

			assignees.push({
				label: suggestedReviewer.login,
				description: suggestedReviewer.name,
				assignee: suggestedReviewer,
			});
			// this user shouldn't be added later from assignable users list
			skipList.add(suggestedReviewer.login);
		}

		if (assignees.length !== 0) {
			assignees.unshift({
				kind: vscode.QuickPickItemKind.Separator,
				label: 'Suggestions'
			});
		}

		assignees.push({
			kind: vscode.QuickPickItemKind.Separator,
			label: 'Users'
		});

		for (const user of assignableUsers) {
			if (skipList.has(user.login)) {
				continue;
			}

			assignees.push({
				label: user.login,
				description: user.name,
				assignee: user,
			});
		}

		if (assignees.length === 0) {
			assignees.push({
				label: 'No assignees available for this repository'
			});
		}

		return assignees;
	}

	private async addReviewers(message: IRequestMessage<void>): Promise<void> {
		try {
			const reviewersToAdd: (vscode.QuickPickItem & { reviewer: IAccount })[] | undefined = (await vscode.window.showQuickPick(
				this.getReviewersQuickPickItems(this._item.suggestedReviewers),
				{
					canPickMany: true,
					matchOnDescription: true,
				},
			))?.filter(item => item.reviewer) as (vscode.QuickPickItem & { reviewer: IAccount })[] | undefined;

			if (reviewersToAdd) {
				await this._item.requestReview(reviewersToAdd.map(r => r.label));
				const addedReviewers: ReviewState[] = reviewersToAdd.map(selected => {
					return {
						reviewer: selected.reviewer,
						state: 'REQUESTED',
					};
				});

				this._existingReviewers = this._existingReviewers.concat(addedReviewers);
				this._replyMessage(message, {
					added: addedReviewers,
				});
			}
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async addMilestone(message: IRequestMessage<void>): Promise<void> {
		try {
			const githubRepository = this._item.githubRepository;
			async function getMilestoneOptions(): Promise<(MilestoneQuickPickItem | vscode.QuickPickItem)[]> {
				const milestones = await githubRepository.getMilestones();
				if (!milestones.length) {
					return [
						{
							label: 'No milestones created for this repository.',
						},
					];
				}

				return milestones.map(result => {
					return {
						label: result.title,
						id: result.id,
						milestone: result,
					};
				});
			}

			const quickPick = vscode.window.createQuickPick();
			quickPick.busy = true;
			quickPick.canSelectMany = false;
			quickPick.title = 'Select a milestone to add';
			quickPick.buttons = [{
				iconPath: new vscode.ThemeIcon('add'),
				tooltip: 'Create',
			}];
			quickPick.onDidTriggerButton((_) => {
				quickPick.hide();

				const inputBox = vscode.window.createInputBox();
				inputBox.title = 'Create new milestone';
				inputBox.placeholder = 'New milestone title';
				if (quickPick.value !== '') {
					inputBox.value = quickPick.value;
				}
				inputBox.show();
				inputBox.onDidAccept(async () => {
					inputBox.hide();
					if (inputBox.value === '') {
						return;
					}
					if (inputBox.value.length > 255) {
						vscode.window.showErrorMessage(`Failed to create milestone: The title can contain a maximum of 255 characters`);
						return;
					}
					// Check if milestone already exists (only check open ones)
					for (const existingMilestone of quickPick.items) {
						if (existingMilestone.label === inputBox.value) {
							vscode.window.showErrorMessage(`Failed to create milestone: The milestone '${inputBox.value}' already exists`);
							return;
						}
					}
					try {
						const milestone = await this._folderRepositoryManager.createMilestone(githubRepository, inputBox.value);
						if (milestone !== undefined) {
							await this.updateMilestone(milestone, message);
						}
					} catch (e) {
						if (e.errors && Array.isArray(e.errors) && e.errors.find(error => error.code === 'already_exists') !== undefined) {
							vscode.window.showErrorMessage(`Failed to create milestone: The milestone already exists and might be closed`);
						}
						else {
							vscode.window.showErrorMessage(`Failed to create milestone: ${formatError(e)}`);
						}
					}
				});
			});

			quickPick.show();
			quickPick.items = await getMilestoneOptions();
			quickPick.busy = false;

			quickPick.onDidAccept(async () => {
				quickPick.hide();
				const milestoneToAdd = quickPick.selectedItems[0];
				if (milestoneToAdd && isMilestoneQuickPickItem(milestoneToAdd)) {
					await this.updateMilestone(milestoneToAdd.milestone, message);
				}
			});

		} catch (e) {
			vscode.window.showErrorMessage(`Failed to add milestone: ${formatError(e)}`);
		}
	}

	private async updateMilestone(milestone: IMilestone, message: IRequestMessage<void>) {
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

	private async addAssignees(message: IRequestMessage<void>): Promise<void> {
		try {
			const assigneesToAdd = (await vscode.window.showQuickPick(
				this.getAssigneesQuickPickItems(),
				{
					canPickMany: true,
					matchOnDescription: true,
				},
			))?.filter(item => item.assignee) as (vscode.QuickPickItem & { assignee: IAccount })[] | undefined;;

			if (assigneesToAdd) {
				const addedAssignees: IAccount[] = assigneesToAdd.map(item => item.assignee);
				this._item.assignees = this._item.assignees?.concat(addedAssignees);

				await this._item.updateAssignees(addedAssignees.map(assignee => assignee.login));

				this._replyMessage(message, {
					added: addedAssignees,
				});
			}
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async addAssigneeYourself(message: IRequestMessage<void>): Promise<void> {
		try {
			const currentUser = this._folderRepositoryManager.getCurrentUser();

			this._item.assignees = this._item.assignees?.concat(currentUser);

			await this._item.updateAssignees([currentUser.login]);

			this._replyMessage(message, {
				added: [currentUser],
			});
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async removeReviewer(message: IRequestMessage<string>): Promise<void> {
		try {
			await this._item.deleteReviewRequest(message.args);

			const index = this._existingReviewers.findIndex(reviewer => reviewer.reviewer.login === message.args);
			this._existingReviewers.splice(index, 1);

			this._replyMessage(message, {});
		} catch (e) {
			vscode.window.showErrorMessage(formatError(e));
		}
	}

	private async removeAssignee(message: IRequestMessage<string>): Promise<void> {
		try {
			await this._item.deleteAssignees(message.args);

			const index = this._item.assignees?.findIndex(assignee => assignee.login === message.args) ?? -1;
			this._item.assignees?.splice(index, 1);

			this._replyMessage(message, {});
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
			Logger.appendLine(`Applying patch failed: ${e}`);
			vscode.window.showErrorMessage(`Applying patch failed: ${formatError(e)}`);
		}
	}

	private async openDiff(message: IRequestMessage<{ comment: IComment }>): Promise<void> {
		try {
			const comment = message.args.comment;
			return PullRequestModel.openDiffFromComment(this._folderRepositoryManager, this._item, comment);
		} catch (e) {
			Logger.appendLine(`Open diff view failed: ${formatError(e)}`, PullRequestOverviewPanel.ID);
		}
	}

	private async resolveComentThread(message: IRequestMessage<{ threadId: string, toResolve: boolean, thread: IComment[] }>) {
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
		message: IRequestMessage<{ title: string; description: string; method: 'merge' | 'squash' | 'rebase' }>,
	): void {
		const { title, description, method } = message.args;
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
			.then(isDraft => {
				vscode.commands.executeCommand('pr.refreshList');

				this._replyMessage(message, { isDraft });
			})
			.catch(e => {
				vscode.window.showErrorMessage(`Unable to set PR ready for review. ${formatError(e)}`);
				this._throwError(message, {});
			});
	}

	private async checkoutDefaultBranch(message: IRequestMessage<string>): Promise<void> {
		try {
			await this._folderRepositoryManager.checkoutDefaultBranch(message.args);
		} finally {
			// Complete webview promise so that button becomes enabled again
			this._replyMessage(message, {});
		}
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

	private async copyPrLink(): Promise<void> {
		await vscode.env.clipboard.writeText(this._item.html_url);
		vscode.window.showInformationMessage(`Copied link to PR "${this._item.title}"!`);
	}

	private async updateAutoMerge(message: IRequestMessage<{ autoMerge?: boolean, autoMergeMethod: MergeMethod }>): Promise<void> {
		let replyMessage: { autoMerge: boolean, autoMergeMethod?: MergeMethod };
		if (!message.args.autoMerge && !this._item.autoMerge) {
			replyMessage = { autoMerge: false };
		} else if ((message.args.autoMerge === false) && this._item.autoMerge) {
			await this._item.disableAutoMerge();
			replyMessage = { autoMerge: this._item.autoMerge };
		} else {
			await this._item.enableAutoMerge(message.args.autoMergeMethod);
			replyMessage = { autoMerge: this._item.autoMerge, autoMergeMethod: this._item.autoMergeMethod };
		}
		this._replyMessage(message, replyMessage);
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
	const userPreferred = vscode.workspace.getConfiguration('githubPullRequests').get<MergeMethod>('defaultMergeMethod');
	// Use default merge method specified by user if it is available
	if (userPreferred && methodsAvailability.hasOwnProperty(userPreferred) && methodsAvailability[userPreferred]) {
		return userPreferred;
	}
	const methods: MergeMethod[] = ['merge', 'squash', 'rebase'];
	// GitHub requires to have at least one merge method to be enabled; use first available as default
	return methods.find(method => methodsAvailability[method])!;
}
