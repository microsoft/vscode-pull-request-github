/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { IAccount, isITeam, ITeam, PullRequestMergeability, reviewerId, ReviewState } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { PullRequest, ReviewType, SubmitReviewReply } from './views';
import { ReviewEvent, TimelineEvent } from '../common/timelineEvent';
import { formatError } from '../common/utils';
import { IRequestMessage } from '../common/webview';

/**
 * Context required by review utility functions
 */
export interface ReviewContext {
	item: PullRequestModel;
	folderRepositoryManager: FolderRepositoryManager;
	existingReviewers: ReviewState[];
	postMessage(message: any): void;
	replyMessage(message: IRequestMessage<any>, response: any): void;
	throwError(message: IRequestMessage<any> | undefined, error: string): void;
	getTimeline(): Promise<TimelineEvent[]>;
}

/**
 * Utility functions for handling pull request reviews.
 * These are shared between PullRequestOverviewPanel and PullRequestViewProvider.
 */
export namespace PullRequestReviewHelpers {
	/**
	 * Find currently configured user's review status for the current PR
	 */
	export function getCurrentUserReviewState(reviewers: ReviewState[], currentUser: IAccount): string | undefined {
		const review = reviewers.find(r => reviewerId(r.reviewer) === currentUser.login);
		// There will always be a review. If not then the PR shouldn't have been or fetched/shown for the current user
		return review?.state;
	}

	/**
	 * Update the reviewers list with a new review
	 */
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

	/**
	 * Handle review command submission
	 */
	export async function doReviewCommand(
		ctx: ReviewContext,
		context: { body: string },
		reviewType: ReviewType,
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
			const allEvents = await ctx.getTimeline(); // activity bar view doesn't do this.
			const reviewMessage: SubmitReviewReply & { command: string } = {
				command: 'pr.append-review',
				reviewedEvent: review,
				events: allEvents,
				reviewers: ctx.existingReviewers
			};
			ctx.postMessage(reviewMessage);
			return review;
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Submitting review failed. {0}', formatError(e)));
			ctx.throwError(undefined, `${formatError(e)}`);
			ctx.postMessage({ command: 'pr.append-review' });
		}
	}

	/**
	 * Handle review message submission
	 */
	export async function doReviewMessage(
		ctx: ReviewContext,
		message: IRequestMessage<string>,
		action: (body: string) => Promise<ReviewEvent>,
	): Promise<ReviewEvent | undefined> {
		try {
			const review = await action(message.args);
			updateReviewers(ctx.existingReviewers, review);
			const allEvents = await ctx.getTimeline(); // activity bar view doesn't do this.
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

	/**
	 * Re-request a review from a specific reviewer
	 */
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

	/**
	 * Checkout the default branch
	 */
	export async function checkoutDefaultBranch(ctx: ReviewContext, message: IRequestMessage<string>): Promise<void> {
		try {
			const prBranch = ctx.folderRepositoryManager.repository.state.HEAD?.name;
			await ctx.folderRepositoryManager.checkoutDefaultBranch(message.args); // test that this works with activity bar
			if (prBranch) {
				await ctx.folderRepositoryManager.cleanupAfterPullRequest(prBranch, ctx.item);
			}
		} finally {
			// Complete webview promise so that button becomes enabled again
			ctx.replyMessage(message, {});
		}
	}

	/**
	 * Update the PR branch with the base branch
	 */
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

	/**
	 * Set the PR as ready for review
	 */
	export async function setReadyForReview(ctx: ReviewContext, message: IRequestMessage<{}>): Promise<void> {
		try {
			const result = await ctx.item.setReadyForReview();
			ctx.replyMessage(message, result);
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('Unable to set pull request ready for review. {0}', formatError(e)));
			ctx.throwError(message, '');
		}
	}
}
