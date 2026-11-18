/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { GitHubRepository, StackBranchComparison } from './githubRepository';
import { GithubItemStateEnum, MergeMethod, PullRequestMergeability, PullRequestStack } from './interface';
import type { PullRequestModel } from './pullRequestModel';
import { StackCandidate } from '../../common/views';
import Logger from '../common/logger';
import { compareIgnoreCase, formatError } from '../common/utils';

function sameRepository(first: PullRequestModel, second: PullRequestModel): boolean {
	return compareIgnoreCase(first.remote.owner, second.remote.owner) === 0
		&& compareIgnoreCase(first.remote.repositoryName, second.remote.repositoryName) === 0
		&& compareIgnoreCase(first.githubRepository.remote.normalizedHost, second.githubRepository.remote.normalizedHost) === 0;
}

export function isStackablePullRequest(pullRequest: PullRequestModel): boolean {
	const { base, head } = pullRequest;
	if (pullRequest.state !== GithubItemStateEnum.Open || pullRequest.isRemoteHeadDeleted || pullRequest.isRemoteBaseDeleted
		|| !head || !base || head.ref === base.ref) {
		return false;
	}
	const repository = pullRequest.githubRepository.remote;
	return [base, head].every(ref => compareIgnoreCase(ref.owner, repository.owner) === 0
		&& compareIgnoreCase(ref.repositoryCloneUrl.repositoryName, repository.repositoryName) === 0
		&& compareIgnoreCase(ref.repositoryCloneUrl.host, repository.gitProtocol.host) === 0);
}

export function orderStackablePullRequests(pullRequests: readonly PullRequestModel[]): PullRequestModel[] | undefined {
	if (pullRequests.length < 2 || pullRequests.some(pr => !isStackablePullRequest(pr) || !sameRepository(pr, pullRequests[0]))) {
		return;
	}
	const byHead = new Map<string, PullRequestModel>();
	const byBase = new Map<string, PullRequestModel>();
	const numbers = new Set<number>();
	for (const pr of pullRequests) {
		if (byHead.has(pr.head!.ref) || byBase.has(pr.base.ref) || numbers.has(pr.number)) {
			return;
		}
		byHead.set(pr.head!.ref, pr);
		byBase.set(pr.base.ref, pr);
		numbers.add(pr.number);
	}
	const bottoms = pullRequests.filter(pr => !byHead.has(pr.base.ref));
	if (bottoms.length !== 1) {
		return;
	}
	const ordered: PullRequestModel[] = [];
	let current: PullRequestModel | undefined = bottoms[0];
	while (current && ordered.length < pullRequests.length) {
		ordered.push(current);
		current = byBase.get(current.head!.ref);
	}
	return ordered.length === pullRequests.length && !current ? ordered : undefined;
}

/**
 * Marks the open pull requests in a stack that are behind their base, checking all of them in one request that can
 * also look up the merge queue of a branch.
 * @param branches The base branch and the `owner:branch` head of each open pull request, by number.
 * @param startsAtBottom Whether the first open pull request is the bottom of the stack.
 * @param mergeQueueBranch A branch to look up the merge queue of.
 * @returns Whether updating the stack would change any of the pull requests, and the merge method of the merge queue.
 */
export async function checkStackBranches(repository: GitHubRepository, entries: PullRequestStack['pullRequests'],
	branches: ReadonlyMap<number, StackBranchComparison>, startsAtBottom: boolean, mergeQueueBranch?: string,
): Promise<{ needsUpdate: boolean; mergeQueueMethod?: MergeMethod }> {
	// GitHub merges a stack onto its base, so being behind that base does not block merging when the lowest open
	// pull request has no conflicts. Updating the stack is still offered. Only staleness inside the stack blocks.
	const bottom = startsAtBottom ? entries.find(entry => entry.state === GithubItemStateEnum.Open) : undefined;
	if (bottom?.mergeable === PullRequestMergeability.Behind) {
		bottom.mergeable = PullRequestMergeability.Mergeable;
	}
	const open = entries.filter(entry => entry.state === GithubItemStateEnum.Open);
	// A conflict means the base has changes the head does not, so updating the stack is how it is resolved.
	const compared = open.filter(entry => entry.mergeable !== PullRequestMergeability.Conflict);
	const comparisons = compared.map(entry => {
		const comparison = branches.get(entry.number);
		if (!comparison) {
			throw new Error(`Unable to check whether pull request #${entry.number} is behind its stack base.`);
		}
		return comparison;
	});
	const { behindBy, mergeQueueMethod } = await repository.getStackBranchStatus(comparisons, mergeQueueBranch);
	compared.forEach((entry, index) => {
		const behind = behindBy[index];
		if (behind === undefined) {
			throw new Error(`Unable to check whether pull request #${entry.number} is behind its stack base.`);
		}
		// Being behind is shown as having no conflicts, so only a pull request GitHub reports as mergeable is marked
		// behind; conflicts that are not checked yet and unmet merge requirements stay visible.
		if (behind > 0 && entry !== bottom && entry.mergeable === PullRequestMergeability.Mergeable) {
			entry.mergeable = PullRequestMergeability.Behind;
		}
	});
	return {
		needsUpdate: compared.length < open.length || behindBy.some(behind => (behind ?? 0) > 0),
		mergeQueueMethod,
	};
}

/** Gets the stack that the bottom of the ordered pull requests would start, or extend if it is the top of one. */
export async function getStackCandidateForPullRequests(ordered: readonly PullRequestModel[]): Promise<StackCandidate> {
	const bottom = ordered[0];
	const candidate = await bottom.githubRepository.getStackCandidate(bottom.head!.ref);
	if (!candidate || candidate.parentPullRequestNumber !== bottom.number) {
		throw new Error(`Pull request #${bottom.number} is no longer eligible to start or extend a stack.`);
	}
	return candidate;
}

/**
 * Gets the current pull requests from GitHub, including whether they have auto-merge enabled, which pull request
 * lists don't include.
 */
export function refreshPullRequestsForStack(repository: GitHubRepository, numbers: readonly number[]): Promise<PullRequestModel[]> {
	return Promise.all(numbers.map(async number => {
		const current = await repository.getPullRequest(number, 'refreshPullRequestsForStack');
		if (!current) {
			throw new Error(vscode.l10n.t('Unable to refresh pull request #{0} before stacking.', number));
		}
		return current;
	}));
}

/**
 * The merge method to enable auto-merge for a stack with, when the pull requests being stacked have auto-merge enabled:
 * that of the highest one, nearest the top of the stack that the request is enabled on.
 * @param autoMerge The pull requests with auto-merge enabled, in stack order.
 */
function getStackAutoMergeMethod(autoMerge: readonly PullRequestModel[]): MergeMethod | undefined {
	return autoMerge.length ? autoMerge[autoMerge.length - 1].autoMergeMethod ?? 'merge' : undefined;
}

/**
 * Offers to enable auto-merge for the entire stack instead of disabling it, when the pull requests being stacked have it
 * enabled. The merge method is the one that the user confirms, so it is not looked up again once they have.
 * @param pullRequests The pull requests being stacked, in stack order.
 */
export function getStackAutoMergeOffer(pullRequests: readonly PullRequestModel[]): { method: MergeMethod; warning: string } | undefined {
	const autoMerge = pullRequests.filter(pr => pr.autoMerge);
	const method = getStackAutoMergeMethod(autoMerge);
	if (!method) {
		return;
	}
	const numbers = autoMerge.map(pr => `#${pr.number}`).join(', ');
	return {
		method,
		warning: vscode.l10n.t('Auto-merge is enabled for {0}. Enable auto-merge ({1}) for the entire stack, or disable it.', numbers, method),
	};
}

/**
 * Asks what to do about auto-merge on the pull requests that have it enabled before they are stacked: enable it for the
 * entire stack, or disable it.
 * @param pullRequests The pull requests being stacked, in stack order.
 * @returns `undefined` if stacking was cancelled, otherwise the merge method that the user chose to enable auto-merge for
 * the entire stack with, if they did.
 */
export async function chooseStackAutoMerge(pullRequests: readonly PullRequestModel[]): Promise<{ stackAutoMergeMethod?: MergeMethod } | undefined> {
	const offer = getStackAutoMergeOffer(pullRequests);
	if (!offer) {
		return {};
	}
	const enable = vscode.l10n.t('Enable Auto-Merge for Stack');
	const disable = vscode.l10n.t('Disable Auto-Merge');
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t('Enable auto-merge for the entire stack?'), { modal: true, detail: offer.warning }, enable, disable,
	);
	return choice === enable ? { stackAutoMergeMethod: offer.method } : choice === disable ? {} : undefined;
}

/**
 * Enables auto-merge for the pull request at the top of a stack together with every unmerged pull request below it.
 * The pull requests are already stacked, so a failure is reported instead of thrown.
 */
export async function enableAutoMergeForStack(top: PullRequestModel, mergeMethod: MergeMethod): Promise<void> {
	try {
		await top.enableAutoMerge(mergeMethod, true);
	} catch (error) {
		Logger.error(`Failed to enable auto-merge for the stack through #${top.number}: ${formatError(error)}`, 'PullRequestStack');
		void vscode.window.showErrorMessage(vscode.l10n.t('The pull requests were stacked, but auto-merge could not be enabled for the stack: {0}', formatError(error)));
	}
}

/**
 * @param confirmedAutoMerge The pull requests that the user approved changing auto-merge on. Stacking is rejected if
 * any other pull request has auto-merge enabled.
 * @param confirmedStackAutoMergeMethod The merge method that the user approved replacing the auto-merge of those pull
 * requests with, for the entire stack, instead of only disabling it. Stacking is rejected if their auto-merge has
 * changed so that it would be enabled with another one.
 */
export async function addPullRequestsToStack(pullRequests: readonly PullRequestModel[], confirmedCandidate: StackCandidate,
	confirmedAutoMerge: readonly number[] = [], confirmedStackAutoMergeMethod?: MergeMethod): Promise<number[]> {
	const initial = orderStackablePullRequests(pullRequests);
	if (!initial) {
		throw new Error('Select two or more open pull requests whose head and base branches form a chain in the same repository.');
	}
	const selectedBranches = initial.map(pr => ({ number: pr.number, base: pr.base.ref, head: pr.head!.ref }));
	const repository = initial[0].githubRepository;
	const refreshed = await refreshPullRequestsForStack(repository, initial.map(pr => pr.number));
	const ordered = orderStackablePullRequests(refreshed);
	if (!ordered || ordered.some((pr, index) =>
		pr.number !== selectedBranches[index].number
		|| pr.base.ref !== selectedBranches[index].base
		|| pr.head?.ref !== selectedBranches[index].head)) {
		throw new Error('The selected pull request branches have changed. Refresh the view and try again.');
	}
	const candidate = await getStackCandidateForPullRequests(ordered);
	if (candidate.parentPullRequestNumber !== confirmedCandidate.parentPullRequestNumber
		|| candidate.stackNumber !== confirmedCandidate.stackNumber) {
		throw new Error('The selected pull request stack has changed. Refresh the view and try again.');
	}
	for (const pr of ordered.slice(1)) {
		if (await pr.getStack()) {
			throw new Error(`Pull request #${pr.number} is already in a stack.`);
		}
	}
	const autoMerge = ordered.filter(pr => pr.autoMerge);
	const unconfirmed = autoMerge.find(pr => !confirmedAutoMerge.includes(pr.number));
	if (unconfirmed) {
		throw new Error(vscode.l10n.t('Auto-merge was enabled on pull request #{0}. Refresh the view and try again.', unconfirmed.number));
	}
	if (confirmedStackAutoMergeMethod && getStackAutoMergeMethod(autoMerge) !== confirmedStackAutoMergeMethod) {
		throw new Error(vscode.l10n.t('Auto-merge changed on the pull requests being stacked. Refresh the view and try again.'));
	}
	// One at a time, so a failure leaves auto-merge enabled on the pull requests after it.
	for (const pr of autoMerge) {
		await pr.disableAutoMerge();
	}
	await repository.addPullRequestsToStack(candidate, ordered.slice(1).map(pr => pr.number));
	if (confirmedStackAutoMergeMethod) {
		await enableAutoMergeForStack(ordered[ordered.length - 1], confirmedStackAutoMergeMethod);
	}
	return ordered.map(pr => pr.number);
}
