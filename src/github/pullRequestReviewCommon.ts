/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { IAccount, isITeam, ITeam, MergeMethod, PullRequestMergeability, reviewerId, ReviewState } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { ConvertToDraftReply, PullRequest, ReadyForReviewReply, ReviewType, SubmitReviewReply } from './views';
import { DEFAULT_DELETION_METHOD, PR_SETTINGS_NAMESPACE, SELECT_LOCAL_BRANCH, SELECT_REMOTE } from '../common/settingKeys';
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
	getTimeline(): Promise<TimelineEvent[]>;
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
	): Promise<ReviewEvent | undefined> {
		try {
			const review = await action(message.args);
			updateReviewers(ctx.existingReviewers, review);
			const allEvents = needsTimelineRefresh ? await ctx.getTimeline() : [];
			const reply: SubmitReviewReply = {
				reviewedEvent: review,
				events: allEvents,
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
			await ctx.folderRepositoryManager.checkoutDefaultBranch(message.args);
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
		if (checkUpdateEnabled && !checkUpdateEnabled()) {
			await vscode.window.showErrorMessage(vscode.l10n.t('The pull request branch must be checked out to be updated.'), { modal: true });
			return ctx.replyMessage(message, {});
		}

		if (ctx.folderRepositoryManager.repository.state.workingTreeChanges.length > 0 || ctx.folderRepositoryManager.repository.state.indexChanges.length > 0) {
			await vscode.window.showErrorMessage(vscode.l10n.t('The pull request branch cannot be updated when the there changed files in the working tree or index. Stash or commit all change and then try again.'), { modal: true });
			return ctx.replyMessage(message, {});
		}
		const mergeSucceeded = await ctx.folderRepositoryManager.tryMergeBaseIntoHead(ctx.item, true);
		if (!mergeSucceeded) {
			ctx.replyMessage(message, {});
		}
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

	export async function convertToDraftCommand(ctx: ReviewContext): Promise<void> {
		ctx.postMessage({
			command: 'pr.converting-to-draft'
		});
		try {
			const result = await ctx.item.convertToDraft();

			const convertedResult = {
				isDraft: result.isDraft
			};
			await ctx.postMessage({
				command: 'pr.converted-to-draft',
				result: convertedResult
			});
		} catch (e) {
			vscode.window.showErrorMessage(`Unable to convert pull request to draft. ${formatError(e)}`);
			ctx.throwError(undefined, e.message);
		}
	}

	export async function deleteBranch(folderRepositoryManager: FolderRepositoryManager, item: PullRequestModel): Promise<{ isReply: boolean, message: any }> {
		const branchInfo = await folderRepositoryManager.getBranchNameForPullRequest(item);
		const actions: (vscode.QuickPickItem & { type: 'remoteHead' | 'local' | 'remote' | 'suspend' })[] = [];
		const defaultBranch = await folderRepositoryManager.getPullRequestRepositoryDefaultBranch(item);

		if (item.isResolved()) {
			const branchHeadRef = item.head.ref;
			const headRepo = folderRepositoryManager.findRepo(repo => repo.remote.owner === item.head.owner && repo.remote.repositoryName === item.remote.repositoryName);

			const isDefaultBranch = defaultBranch === item.head.ref;
			if (!isDefaultBranch && !item.isRemoteHeadDeleted) {
				actions.push({
					label: vscode.l10n.t('Delete remote branch {0}', `${headRepo?.remote.remoteName}/${branchHeadRef}`),
					description: `${item.remote.normalizedHost}/${item.head.repositoryCloneUrl.owner}/${item.remote.repositoryName}`,
					type: 'remoteHead',
					picked: true,
				});
			}
		}

		if (branchInfo) {
			const preferredLocalBranchDeletionMethod = vscode.workspace
				.getConfiguration(PR_SETTINGS_NAMESPACE)
				.get<boolean>(`${DEFAULT_DELETION_METHOD}.${SELECT_LOCAL_BRANCH}`);
			actions.push({
				label: vscode.l10n.t('Delete local branch {0}', branchInfo.branch),
				type: 'local',
				picked: !!preferredLocalBranchDeletionMethod,
			});

			const preferredRemoteDeletionMethod = vscode.workspace
				.getConfiguration(PR_SETTINGS_NAMESPACE)
				.get<boolean>(`${DEFAULT_DELETION_METHOD}.${SELECT_REMOTE}`);

			if (branchInfo.remote && branchInfo.createdForPullRequest && !branchInfo.remoteInUse) {
				actions.push({
					label: vscode.l10n.t('Delete remote {0}, which is no longer used by any other branch', branchInfo.remote),
					type: 'remote',
					picked: !!preferredRemoteDeletionMethod,
				});
			}
		}

		if (vscode.env.remoteName === 'codespaces') {
			actions.push({
				label: vscode.l10n.t('Suspend Codespace'),
				type: 'suspend'
			});
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

		const selectedActions = await vscode.window.showQuickPick(actions, {
			canPickMany: true,
			ignoreFocusOut: true,
		});

		const deletedBranchTypes: string[] = [];

		if (selectedActions) {
			const isBranchActive = item.equals(folderRepositoryManager.activePullRequest) || (folderRepositoryManager.repository.state.HEAD?.name && folderRepositoryManager.repository.state.HEAD.name === branchInfo?.branch);

			const promises = selectedActions.map(async action => {
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
							await folderRepositoryManager.checkoutDefaultBranch(defaultBranch);
						}
						await folderRepositoryManager.repository.deleteBranch(branchInfo!.branch, true);
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
}
