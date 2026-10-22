/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { GitHubRepository } from './githubRepository';
import { GithubItemStateEnum, PullRequestMergeability, PullRequestStack } from './interface';
import type { PullRequestModel } from './pullRequestModel';
import { StackCandidate } from '../../common/views';
import { assertStacksEnabled } from '../common/settingsUtils';
import { compareIgnoreCase } from '../common/utils';

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
 * Marks the open pull requests in a stack that are behind their base.
 * @param branches The `owner:branch` base and head of each open pull request, by number.
 * @param startsAtBottom Whether the first open pull request is the bottom of the stack.
 * @returns Whether updating the stack would change any of the pull requests.
 */
export async function markOutdatedStackEntries(repository: GitHubRepository, entries: PullRequestStack['pullRequests'],
	branches: ReadonlyMap<number, { base: string; head: string }>, startsAtBottom: boolean): Promise<boolean> {
	// GitHub merges a stack onto its base, so being behind that base does not block merging when the lowest open
	// pull request has no conflicts. Updating the stack is still offered. Only staleness inside the stack blocks.
	const bottom = startsAtBottom ? entries.find(entry => entry.state === GithubItemStateEnum.Open) : undefined;
	if (bottom?.mergeable === PullRequestMergeability.Behind) {
		bottom.mergeable = PullRequestMergeability.Mergeable;
	}
	const outdated = await Promise.all(entries.filter(entry => entry.state === GithubItemStateEnum.Open).map(async entry => {
		// A conflict means the base has changes the head does not, so updating the stack is how it is resolved.
		if (entry.mergeable === PullRequestMergeability.Conflict) {
			return true;
		}
		const refs = branches.get(entry.number);
		const comparison = refs && await repository.compareCommits(refs.base, refs.head);
		if (comparison?.behind_by === undefined) {
			throw new Error(`Unable to check whether pull request #${entry.number} is behind its stack base.`);
		}
		// Being behind is shown as having no conflicts, so only a pull request GitHub reports as mergeable is marked
		// behind; conflicts that are not checked yet and unmet merge requirements stay visible.
		if (comparison.behind_by > 0 && entry !== bottom && entry.mergeable === PullRequestMergeability.Mergeable) {
			entry.mergeable = PullRequestMergeability.Behind;
		}
		return comparison.behind_by > 0;
	}));
	return outdated.some(Boolean);
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

export async function addPullRequestsToStack(pullRequests: readonly PullRequestModel[], confirmedCandidate: StackCandidate): Promise<number[]> {
	assertStacksEnabled();

	const initial = orderStackablePullRequests(pullRequests);
	if (!initial) {
		throw new Error('Select two or more open pull requests whose head and base branches form a chain in the same repository.');
	}
	const selectedBranches = initial.map(pr => ({ number: pr.number, base: pr.base.ref, head: pr.head!.ref }));
	const repository = initial[0].githubRepository;
	const refreshed = await Promise.all(initial.map(async pr => {
		const current = await repository.getPullRequest(pr.number, 'addPullRequestsToStack');
		if (!current) {
			throw new Error(`Unable to refresh pull request #${pr.number} before creating a stack.`);
		}
		return current;
	}));
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
	await repository.addPullRequestsToStack(candidate, ordered.slice(1).map(pr => pr.number));
	return ordered.map(pr => pr.number);
}
