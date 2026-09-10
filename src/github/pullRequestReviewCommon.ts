/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { IAccount, isITeam, ITeam, MergeMethod, PullRequestMergeability, reviewerId, ReviewState } from './interface';
import { BranchInfo } from './pullRequestGitHelper';
import { PullRequestModel } from './pullRequestModel';
import { ConvertToDraftReply, PullRequest, ReadyForReviewReply, ReviewType, SubmitReviewReply } from './views';
import Logger from '../common/logger';
import { DEFAULT_DELETION_METHOD, DELETE_BRANCH_AFTER_MERGE, PR_SETTINGS_NAMESPACE, SELECT_LOCAL_BRANCH, SELECT_REMOTE, SELECT_WORKTREE } from '../common/settingKeys';
import { ReviewEvent, TimelineEvent } from '../common/timelineEvent';
import { Schemes } from '../common/uri';
import { formatError } from '../common/utils';
import { IRequestMessage } from '../common/webview';

/**
 * Context required by review utility functions
 */
export interface ReviewContext {
	item: PullRequestModel;
	folderRepositoryManager: FolderRepositoryManager;
	existingReviewers: ReviewState[];
	postMessage(message: any): Promise<void>;
	replyMessage(message: IRequestMessage<any>, response: any): void;
	throwError(message: IRequestMessage<any> | undefined, error: string): void;
	getTimeline(): Promise<TimelineEvent[] | undefined>;
}

/**
 * Utility functions for handling pull request reviews.
 * These are shared between PullRequestOverviewPanel and PullRequestViewProvider.
 */
export namespace PullRequestReviewCommon {
	/**
	 * Find currently configured user's review status for the current PR
	 */
	export function getCurrentUserReviewState(reviewers: ReviewState[], currentUser: IAccount): string | undefined {
		const review = reviewers.find(r => reviewerId(r.reviewer) === currentUser.login);
		// There will always be a review. If not then the PR shouldn't have been or fetched/shown for the current user
		return review?.state;
	}

	function updateReviewers(existingReviewers: ReviewState[], review?: ReviewEvent): void {
		if (review && review.state) {
			const existingReviewer = existingReviewers.find(
				reviewer => review.user.login === reviewerId(reviewer.reviewer),
			);
			if (existingReviewer) {
				existingReviewer.state = review.state;
			} else {
				existingReviewers.push({
					reviewer: review.user,
					state: review.state,
				});
			}
		}
	}

	export async function doReviewCommand(
		ctx: ReviewContext,
		context: { body: string },
		reviewType: ReviewType,
		needsTimelineRefresh: boolean,
		action: (body: string) => Promise<ReviewEvent>,
		additionalEvents?: TimelineEvent[],
	): Promise<ReviewEvent | undefined> {
		const submittingMessage = {
			command: 'pr.submitting-review',
			lastReviewType: reviewType
		};
		ctx.postMessage(submittingMessage);
		try {
			const review = await action(context.body);
			updateReviewers(ctx.existingReviewers, review);
			const allEvents = needsTimelineRefresh ? await ctx.getTimeline() : [];
			const reviewMessage: SubmitReviewReply & { command: string } = {
				command: 'pr.append-review',
				reviewedEvent: review,
				events: allEvents,
				additionalEvents,
				reviewers: ctx.existingReviewers
			};
			await ctx.postMessage(reviewMessage);
			return review;
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Submitting review failed. {0}', formatError(e)));
			ctx.throwError(undefined, `${formatError(e)}`);
			await ctx.postMessage({ command: 'pr.append-review' });
		}
	}

	export async function doReviewMessage(
		ctx: ReviewContext,
		message: IRequestMessage<string>,
		needsTimelineRefresh: boolean,
		action: (body: string) => Promise<ReviewEvent>,
		additionalEvents?: TimelineEvent[],
	): Promise<ReviewEvent | undefined> {
		try {
			const review = await action(message.args);
			updateReviewers(ctx.existingReviewers, review);
			const allEvents = needsTimelineRefresh ? await ctx.getTimeline() : [];
			const reply: SubmitReviewReply = {
				reviewedEvent: review,
				events: allEvents,
				additionalEvents,
				reviewers: ctx.existingReviewers,
			};
			ctx.replyMessage(message, reply);
			return review;
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Submitting review failed. {0}', formatError(e)));
			ctx.throwError(message, `${formatError(e)}`);
		}
	}

	export function reRequestReview(ctx: ReviewContext, message: IRequestMessage<string>): void {
		let targetReviewer: ReviewState | undefined;
		const userReviewers: IAccount[] = [];
		const teamReviewers: ITeam[] = [];

		for (const reviewer of ctx.existingReviewers) {
			let id = reviewer.reviewer.id;
			if (id && ((reviewer.state === 'REQUESTED') || (id === message.args))) {
				if (id === message.args) {
					targetReviewer = reviewer;
				}
			}
		}

		if (targetReviewer && isITeam(targetReviewer.reviewer)) {
			teamReviewers.push(targetReviewer.reviewer);
		} else if (targetReviewer && !isITeam(targetReviewer.reviewer)) {
			userReviewers.push(targetReviewer.reviewer);
		}

		ctx.item.requestReview(userReviewers, teamReviewers, true).then(() => {
			if (targetReviewer) {
				targetReviewer.state = 'REQUESTED';
			}
			ctx.replyMessage(message, {
				reviewers: ctx.existingReviewers,
			});
		});
	}

	export async function checkoutDefaultBranch(ctx: ReviewContext, message: IRequestMessage<string>): Promise<void> {
		try {
			const prBranch = ctx.folderRepositoryManager.repository.state.HEAD?.name;
			await ctx.folderRepositoryManager.checkoutDefaultBranch(message.args, ctx.item);
			if (prBranch) {
				await ctx.folderRepositoryManager.cleanupAfterPullRequest(prBranch, ctx.item);
			}
		} finally {
			// Complete webview promise so that button becomes enabled again
			ctx.replyMessage(message, {});
		}
	}

	export async function updateBranch(
		ctx: ReviewContext,
		message: IRequestMessage<string>,
		refreshAfterUpdate: () => Promise<void>,
		checkUpdateEnabled?: () => boolean
	): Promise<void> {
		// When there are conflicts and the PR is not checked out, we need local checkout to resolve them
		const hasConflicts = ctx.item.item.mergeable === PullRequestMergeability.Conflict;
		if (hasConflicts && checkUpdateEnabled && !checkUpdateEnabled()) {
			await vscode.window.showErrorMessage(vscode.l10n.t('The pull request branch must be checked out to resolve conflicts.'), { modal: true });
			return ctx.replyMessage(message, {});
		}

		// Working tree/index checks only apply when the PR is checked out
		if (ctx.item.isActive && (ctx.folderRepositoryManager.repository.state.workingTreeChanges.length > 0 || ctx.folderRepositoryManager.repository.state.indexChanges.length > 0)) {
			await vscode.window.showErrorMessage(vscode.l10n.t('The pull request branch cannot be updated when there are changed files in the working tree or index. Stash or commit all change and then try again.'), { modal: true });
			return ctx.replyMessage(message, {});
		}
		const mergeSucceeded = await ctx.folderRepositoryManager.tryMergeBaseIntoHead(ctx.item, true);
		// The mergability of the PR doesn't update immediately. Poll.
		let mergability = PullRequestMergeability.Unknown;
		let attemptsRemaining = 5;
		do {
			mergability = (await ctx.item.getMergeability()).mergeability;
			attemptsRemaining--;
			await new Promise(c => setTimeout(c, 1000));
		} while (attemptsRemaining > 0 && mergability === PullRequestMergeability.Unknown);

		const result: Partial<PullRequest> = {
			events: await ctx.getTimeline(),
			mergeable: mergability,
			canUpdateBranch: !mergeSucceeded,
		};
		await refreshAfterUpdate();

		ctx.replyMessage(message, result);
	}

	export async function setReadyForReview(ctx: ReviewContext, message: IRequestMessage<{}>): Promise<void> {
		try {
			const result = await ctx.item.setReadyForReview();
			ctx.replyMessage(message, result);
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Unable to set pull request ready for review. {0}', formatError(e)));
			ctx.throwError(message, '');
		}
	}

	export async function setReadyForReviewAndMerge(ctx: ReviewContext, message: IRequestMessage<{ mergeMethod: MergeMethod }>): Promise<void> {
		try {
			const readyResult = await ctx.item.setReadyForReview();

			try {
				await ctx.item.approve(ctx.folderRepositoryManager.repository, '');
			} catch (e) {
				vscode.window.showErrorMessage(`Pull request marked as ready for review, but failed to approve. ${formatError(e)}`);
				ctx.replyMessage(message, readyResult);
				return;
			}

			try {
				await ctx.item.enableAutoMerge(message.args.mergeMethod);
			} catch (e) {
				vscode.window.showErrorMessage(`Pull request marked as ready and approved, but failed to enable auto-merge. ${formatError(e)}`);
				ctx.replyMessage(message, readyResult);
				return;
			}

			ctx.replyMessage(message, readyResult);
		} catch (e) {
			vscode.window.showErrorMessage(`Unable to mark pull request as ready for review. ${formatError(e)}`);
			ctx.throwError(message, '');
		}
	}

	export async function setConvertToDraft(ctx: ReviewContext, _message: IRequestMessage<{}>): Promise<void> {
		try {
			const result: ConvertToDraftReply = await ctx.item.convertToDraft();
			ctx.replyMessage(_message, result);
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Unable to convert pull request to draft. {0}', formatError(e)));
			ctx.throwError(_message, '');
		}
	}

	export async function readyForReviewCommand(ctx: ReviewContext): Promise<void> {
		ctx.postMessage({
			command: 'pr.readying-for-review'
		});
		try {
			const result = await ctx.item.setReadyForReview();

			const readiedResult: ReadyForReviewReply = {
				isDraft: result.isDraft
			};
			await ctx.postMessage({
				command: 'pr.readied-for-review',
				result: readiedResult
			});
		} catch (e) {
			vscode.window.showErrorMessage(`Unable to set pull request ready for review. ${formatError(e)}`);
			ctx.throwError(undefined, e.message);
		}
	}

	export async function readyForReviewAndMergeCommand(ctx: ReviewContext, context: { mergeMethod: MergeMethod }): Promise<void> {
		ctx.postMessage({
			command: 'pr.readying-for-review'
		});
		try {
			const [readyResult, approveResult] = await Promise.all([ctx.item.setReadyForReview(), ctx.item.approve(ctx.folderRepositoryManager.repository)]);
			await ctx.item.enableAutoMerge(context.mergeMethod);
			updateReviewers(ctx.existingReviewers, approveResult);

			const readiedResult: ReadyForReviewReply = {
				isDraft: readyResult.isDraft,
				autoMerge: true,
				reviewEvent: approveResult,
				reviewers: ctx.existingReviewers
			};
			await ctx.postMessage({
				command: 'pr.readied-for-review',
				result: readiedResult
			});
		} catch (e) {
			vscode.window.showErrorMessage(`Unable to set pull request ready for review. ${formatError(e)}`);
			ctx.throwError(undefined, e.message);
		}
	}

	interface SelectedAction {
		type: 'remoteHead' | 'local' | 'remote' | 'suspend' | 'worktree'
		/** Path to the worktree directory to remove. Only used when type is 'worktree'. */
		worktreePath?: string;
	};

	function isWorktreeInWorkspace(worktreePath: vscode.Uri): boolean {
		const worktreeFsPath = worktreePath.fsPath;
		return !!vscode.workspace.workspaceFolders?.some(folder => {
			const folderPath = folder.uri.fsPath;
			return folderPath === worktreeFsPath ||
				(process.platform === 'win32' && folderPath.toLowerCase() === worktreeFsPath.toLowerCase());
		});
	}

	function isBranchNotFoundError(error: unknown): boolean {
		const stderr = error && typeof error === 'object' ? Reflect.get(error, 'stderr') : undefined;
		return typeof stderr === 'string' && stderr.includes('not found');
	}

	export async function deleteBranch(folderRepositoryManager: FolderRepositoryManager, item: PullRequestModel): Promise<{ isReply: boolean, message: any }> {
		const branchInfo = await folderRepositoryManager.getBranchNameForPullRequest(item);
		const actions: (vscode.MessageItem & SelectedAction)[] = [];
		const cleanupDetails: string[] = [];
		const defaultBranch = await folderRepositoryManager.getPullRequestRepositoryDefaultBranch(item);

		if (item.isResolved()) {
			const branchHeadRef = item.head.ref;
			const headRepo = folderRepositoryManager.findRepo(repo => repo.remote.owner === item.head.owner && repo.remote.repositoryName === item.remote.repositoryName);

			const isDefaultBranch = defaultBranch === item.head.ref;
			if (!isDefaultBranch && !item.isRemoteHeadDeleted) {
				const remoteBranch = headRepo ? `${headRepo.remote.remoteName}/${branchHeadRef}` : branchHeadRef;
				actions.push({
					title: vscode.l10n.t('Delete Remote Branch'),
					type: 'remoteHead',
				});
				cleanupDetails.push(
					vscode.l10n.t('Remote branch: {0}', remoteBranch),
					vscode.l10n.t('Remote repository: {0}', `${item.remote.normalizedHost}/${item.head.repositoryCloneUrl.owner}/${item.remote.repositoryName}`),
				);
			}
		}

		if (branchInfo) {
			actions.push({
				title: vscode.l10n.t('Delete Local Branch'),
				type: 'local',
			});
			cleanupDetails.push(vscode.l10n.t('Local branch: {0}', branchInfo.branch));

			if (branchInfo.remote && branchInfo.createdForPullRequest && !branchInfo.remoteInUse) {
				actions.push({
					title: vscode.l10n.t('Delete Remote'),
					type: 'remote',
				});
				cleanupDetails.push(vscode.l10n.t('Unused Git remote: {0}', branchInfo.remote));
			}

			const worktreePath = folderRepositoryManager.getWorktreeForBranch(branchInfo.branch);
			if (worktreePath && !isWorktreeInWorkspace(worktreePath)) {
				actions.push({
					title: vscode.l10n.t('Remove Worktree'),
					type: 'worktree',
					worktreePath: worktreePath.fsPath,
				});
				cleanupDetails.push(vscode.l10n.t('Worktree: {0}', worktreePath.fsPath));
			}
		}

		if (vscode.env.remoteName === 'codespaces') {
			actions.push({
				title: vscode.l10n.t('Suspend Codespace'),
				type: 'suspend'
			});
			cleanupDetails.push(vscode.l10n.t('Codespace: current Codespace'));
		}

		if (!actions.length) {
			vscode.window.showWarningMessage(
				vscode.l10n.t('There is no longer an upstream or local branch for Pull Request #{0}', item.number),
			);
			return {
				isReply: true,
				message: {
					cancelled: true
				}
			};
		}

		const options: (vscode.MessageItem & { actions: SelectedAction[] })[] = actions.map(action => ({
			title: action.title,
			actions: [action],
		}));
		const deletionActions = actions.filter(action => action.type !== 'suspend');
		if (deletionActions.length > 1) {
			options.unshift({ title: vscode.l10n.t('Delete All'), actions: deletionActions });
		}
		const selectedOption = await vscode.window.showWarningMessage(
			vscode.l10n.t('Choose what to delete for Pull Request #{0}', item.number),
			{
				modal: true,
				detail: vscode.l10n.t(
					'Choose an action below to clean up the resources associated with this pull request.\n\n{0}',
					cleanupDetails.join('\n'),
				)
			},
			...options,
		);

		if (selectedOption) {
			const deletedBranchTypes: string[] = await performBranchDeletion(folderRepositoryManager, item, defaultBranch, branchInfo!, selectedOption.actions);

			return {
				isReply: false,
				message: {
					command: 'pr.deleteBranch',
					branchTypes: deletedBranchTypes
				}
			};
		} else {
			return {
				isReply: true,
				message: {
					cancelled: true
				}
			};
		}
	}

	export async function handleBranchDeletionAfterMerge(folderRepositoryManager: FolderRepositoryManager, item: PullRequestModel): Promise<{ command: string, branchTypes: string[] } | undefined> {
		try {
			const deleteBranchAfterMerge = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(DELETE_BRANCH_AFTER_MERGE, false);
			if (deleteBranchAfterMerge) {
				await autoDeleteBranchesAfterMerge(folderRepositoryManager, item);
			} else if ((await item.githubRepository.getMetadata()).delete_branch_on_merge) {
				const result = await deleteBranch(folderRepositoryManager, item);
				return result.isReply ? undefined : result.message;
			}
		} catch (e) {
			Logger.error(`Branch cleanup after merge failed: ${formatError(e)}`, 'PullRequestReviewCommon');
		}
	}

	async function performBranchDeletion(folderRepositoryManager: FolderRepositoryManager, item: PullRequestModel, defaultBranch: string, branchInfo: BranchInfo, selectedActions: SelectedAction[]): Promise<string[]> {
		const isBranchActive = item.equals(folderRepositoryManager.activePullRequest) || (folderRepositoryManager.repository.state.HEAD?.name && folderRepositoryManager.repository.state.HEAD.name === branchInfo?.branch);
		const deletedBranchTypes: string[] = [];

		// Remove worktree first, before deleting the branch, since a branch checked out
		// in a worktree cannot be deleted.
		const worktreeAction = selectedActions.find(a => a.type === 'worktree');
		if (worktreeAction?.worktreePath) {
			await folderRepositoryManager.removeWorktree(worktreeAction.worktreePath);
			deletedBranchTypes.push(worktreeAction.type);
		}

		const remainingActions = selectedActions.filter(a => a.type !== 'worktree');
		const promises = remainingActions.map(async action => {
			switch (action.type) {
				case 'remoteHead':
					await folderRepositoryManager.deleteBranch(item);
					deletedBranchTypes.push(action.type);
					await folderRepositoryManager.repository.fetch({ prune: true });
					// If we're in a remote repository, then we should checkout the default branch.
					if (folderRepositoryManager.repository.rootUri.scheme === Schemes.VscodeVfs) {
						await folderRepositoryManager.repository.checkout(defaultBranch);
					}
					return;
				case 'local':
					if (isBranchActive) {
						if (folderRepositoryManager.repository.state.workingTreeChanges.length) {
							const yes = vscode.l10n.t('Yes');
							const response = await vscode.window.showWarningMessage(
								vscode.l10n.t('Your local changes will be lost, do you want to continue?'),
								{ modal: true },
								yes,
							);
							if (response === yes) {
								await vscode.commands.executeCommand('git.cleanAll');
							} else {
								return;
							}
						}
						await folderRepositoryManager.checkoutDefaultBranch(defaultBranch, item);
					}
					try {
						await folderRepositoryManager.repository.deleteBranch(branchInfo!.branch, true);
					} catch (error) {
						if (!isBranchNotFoundError(error)) {
							throw error;
						}
						Logger.debug(`Local branch ${branchInfo!.branch} no longer exists.`, 'PullRequestReviewCommon');
					}
					return deletedBranchTypes.push(action.type);
				case 'remote':
					deletedBranchTypes.push(action.type);
					return folderRepositoryManager.repository.removeRemote(branchInfo!.remote!);
				case 'suspend':
					deletedBranchTypes.push(action.type);
					return vscode.commands.executeCommand('github.codespaces.disconnectSuspend');
			}
		});

		await Promise.all(promises);
		return deletedBranchTypes;
	}

	/**
	 * Automatically delete the local branch after adding to a merge queue.
	 * Only deletes the local branch since the PR isn't merged yet.
	 */
	export async function autoDeleteLocalBranchAfterEnqueue(folderRepositoryManager: FolderRepositoryManager, item: PullRequestModel): Promise<void> {
		const branchInfo = await folderRepositoryManager.getBranchNameForPullRequest(item);
		const defaultBranch = await folderRepositoryManager.getPullRequestRepositoryDefaultBranch(item);

		// Get user preference for local branch deletion
		const deleteLocalBranch = vscode.workspace
			.getConfiguration(PR_SETTINGS_NAMESPACE)
			.get<boolean>(`${DEFAULT_DELETION_METHOD}.${SELECT_LOCAL_BRANCH}`, true);

		if (!branchInfo || !deleteLocalBranch) {
			return;
		}

		const selectedActions: SelectedAction[] = [{ type: 'local' }];

		// Execute deletion
		const deletedBranchTypes = await performBranchDeletion(folderRepositoryManager, item, defaultBranch, branchInfo, selectedActions);

		// Show notification
		if (deletedBranchTypes.includes('local')) {
			const branchName = branchInfo.branch || item.head?.ref;
			if (branchName) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('Deleted local branch {0}.', branchName)
				);
			}
		}
	}

	/**
	 * Automatically delete branches after merge based on user preferences.
	 * This function does not show any prompts - it uses the default deletion method preferences.
	 */
	export async function autoDeleteBranchesAfterMerge(folderRepositoryManager: FolderRepositoryManager, item: PullRequestModel): Promise<void> {
		const branchInfo = await folderRepositoryManager.getBranchNameForPullRequest(item);
		const defaultBranch = await folderRepositoryManager.getPullRequestRepositoryDefaultBranch(item);

		// Get user preferences for automatic deletion
		const deleteLocalBranch = vscode.workspace
			.getConfiguration(PR_SETTINGS_NAMESPACE)
			.get<boolean>(`${DEFAULT_DELETION_METHOD}.${SELECT_LOCAL_BRANCH}`, true);

		const deleteRemote = vscode.workspace
			.getConfiguration(PR_SETTINGS_NAMESPACE)
			.get<boolean>(`${DEFAULT_DELETION_METHOD}.${SELECT_REMOTE}`, true);

		const selectedActions: SelectedAction[] = [];

		// Delete remote head branch if it's not the default branch
		if (item.isResolved()) {
			const isDefaultBranch = defaultBranch === item.head.ref;
			if (!isDefaultBranch && !item.isRemoteHeadDeleted) {
				selectedActions.push({ type: 'remoteHead' });
			}
		}

		// Delete local branch if preference is set
		if (branchInfo && deleteLocalBranch) {
			selectedActions.push({ type: 'local' });
		}

		// Delete remote if it's no longer used and preference is set
		if (branchInfo && branchInfo.remote && branchInfo.createdForPullRequest && !branchInfo.remoteInUse && deleteRemote) {
			selectedActions.push({ type: 'remote' });
		}

		// Remove worktree if preference is set
		const deleteWorktree = vscode.workspace
			.getConfiguration(PR_SETTINGS_NAMESPACE)
			.get<boolean>(`${DEFAULT_DELETION_METHOD}.${SELECT_WORKTREE}`, false);
		if (branchInfo && deleteWorktree) {
			const worktreePath = folderRepositoryManager.getWorktreeForBranch(branchInfo.branch);
			if (worktreePath && !isWorktreeInWorkspace(worktreePath)) {
				selectedActions.push({ type: 'worktree', worktreePath: worktreePath.fsPath });
			}
		}

		// Execute all deletions in parallel
		const deletedBranchTypes = await performBranchDeletion(folderRepositoryManager, item, defaultBranch, branchInfo!, selectedActions);

		// Show notification to the user about what was deleted
		if (deletedBranchTypes.length > 0) {
			const wasLocalDeleted = deletedBranchTypes.includes('local');
			const wasRemoteDeleted = deletedBranchTypes.includes('remoteHead') || deletedBranchTypes.includes('remote');
			const branchName = branchInfo?.branch || item.head?.ref;

			// Only show notification if we have a branch name
			if (branchName) {
				if (wasLocalDeleted && wasRemoteDeleted) {
					vscode.window.showInformationMessage(
						vscode.l10n.t('Deleted local and remote branches for {0}.', branchName)
					);
				} else if (wasLocalDeleted) {
					vscode.window.showInformationMessage(
						vscode.l10n.t('Deleted local branch {0}.', branchName)
					);
				} else {
					vscode.window.showInformationMessage(
						vscode.l10n.t('Deleted remote branch {0}.', branchName)
					);
				}
			}
		}
	}
}
