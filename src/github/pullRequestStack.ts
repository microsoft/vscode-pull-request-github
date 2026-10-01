/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GithubItemStateEnum } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { compareIgnoreCase } from '../common/utils';

function sameRepository(first: PullRequestModel, second: PullRequestModel): boolean {
	return compareIgnoreCase(first.remote.owner, second.remote.owner) === 0
		&& compareIgnoreCase(first.remote.repositoryName, second.remote.repositoryName) === 0
		&& compareIgnoreCase(first.githubRepository.remote.normalizedHost, second.githubRepository.remote.normalizedHost) === 0;
}

export function isStackablePullRequest(pullRequest: PullRequestModel): boolean {
	const { base, head } = pullRequest;
	if (pullRequest.state !== GithubItemStateEnum.Open || !head || !base || head.ref === base.ref) {
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

export async function addPullRequestsToStack(pullRequests: readonly PullRequestModel[]): Promise<number[]> {
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
	const bottom = ordered[0];
	const candidate = await repository.getStackCandidate(bottom.head!.ref);
	if (!candidate || candidate.parentPullRequestNumber !== bottom.number) {
		throw new Error(`Pull request #${bottom.number} is no longer eligible to start or extend a stack.`);
	}
	for (const pr of ordered.slice(1)) {
		if (await pr.getStack()) {
			throw new Error(`Pull request #${pr.number} is already in a stack.`);
		}
	}
	await repository.addPullRequestsToStack(candidate, ordered.slice(1).map(pr => pr.number));
	return ordered.map(pr => pr.number);
}
