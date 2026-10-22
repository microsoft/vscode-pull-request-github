/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GithubItemStateEnum, PullRequestMergeability, PullRequestStack, PullRequestStackRecommendation, StackablePullRequest } from './interface';
import type { PullRequestModel } from './pullRequestModel';
import { isStackablePullRequest, markOutdatedStackEntries } from './pullRequestStack';

export interface StackRecommendation {
	/** What the stack would look like, for the user to confirm. */
	preview: PullRequestStackRecommendation;
	/** The pull request that the others would be stacked on, followed by those pull requests, from bottom to top. */
	pullRequestNumbers: number[];
}

/**
 * Finds the open pull requests that could be stacked with a pull request that is not in a stack.
 *
 * The chain is followed down through the pull requests whose head is the base of the one above them,
 * and up through those whose base is the head of the one below them. It stops where no single pull
 * request lines up, where another pull request merges into the same branch, or where it reaches one
 * that is already in a stack. If the pull request below the chain is the top of a stack, the chain
 * would extend that stack.
 *
 * @returns `undefined` if no other pull request could be stacked with this one.
 */
export async function getStackRecommendation(pullRequest: PullRequestModel): Promise<StackRecommendation | undefined> {
	if (!isStackablePullRequest(pullRequest)) {
		return;
	}
	const repository = pullRequest.githubRepository;
	const chain: StackablePullRequest[] = [{
		number: pullRequest.number,
		title: pullRequest.title,
		url: pullRequest.html_url,
		base: pullRequest.base.ref,
		head: pullRequest.head!.ref,
		isDraft: !!pullRequest.isDraft,
		isQueued: !!pullRequest.mergeQueueEntry,
		mergeable: pullRequest.item.mergeable ?? PullRequestMergeability.Unknown,
	}];
	const seen = new Set([pullRequest.number]);
	let stackTop: StackablePullRequest | undefined;
	let lookBelow = true;
	let lookAbove = true;
	while (lookBelow || lookAbove) {
		const found = await repository.getStackablePullRequests(
			lookBelow ? chain[0].base : undefined,
			lookAbove ? chain[chain.length - 1].head : undefined,
		);
		if (!found) {
			return;
		}
		const { targetingBase, above } = found;
		// Another pull request that merges into the same branch as the bottom of the chain would be left in the middle of the stack.
		const below = targetingBase === chain[0].number ? found.below : undefined;
		// Branches that loop back around cannot be stacked.
		if ((below && seen.has(below.number)) || (above && (seen.has(above.number) || above.number === below?.number))) {
			return;
		}
		lookBelow = !!below && !below.stackEntry;
		if (lookBelow) {
			chain.unshift(below!);
			seen.add(below!.number);
		} else if (below?.stackEntry && below.stackEntry.position === below.stackEntry.size) {
			stackTop = below;
		}
		// Two stacks cannot be joined, so the chain stops below a pull request that is already in a stack.
		lookAbove = !!above && !above.stackEntry;
		if (lookAbove) {
			chain.push(above!);
			seen.add(above!.number);
		}
	}

	let existing: PullRequestStack | undefined;
	if (stackTop) {
		const top = await repository.getPullRequest(stackTop.number, 'getStackRecommendation', true);
		existing = await top?.getStack();
		if (existing?.pullRequests[existing.pullRequests.length - 1]?.number !== stackTop.number) {
			return;
		}
	} else if (chain.length < 2) {
		return;
	}

	const added: PullRequestStack['pullRequests'] = chain.map(pr => ({
		position: 0,
		number: pr.number,
		title: pr.title,
		url: pr.url,
		head: pr.head,
		state: GithubItemStateEnum.Open,
		isDraft: pr.isDraft,
		isQueued: pr.isQueued,
		mergeable: pr.mergeable,
	}));
	const owner = pullRequest.remote.owner;
	const outdated = await markOutdatedStackEntries(repository, added,
		new Map(chain.map(pr => [pr.number, { base: `${owner}:${pr.base}`, head: `${owner}:${pr.head}` }])));
	const pullRequests = [...(existing?.pullRequests ?? []), ...added].map((entry, index) => ({ ...entry, position: index + 1 }));
	return {
		preview: {
			stack: {
				position: pullRequests.findIndex(entry => entry.number === pullRequest.number) + 1,
				size: pullRequests.length,
				base: existing?.base ?? chain[0].base,
				needsUpdate: !!existing?.needsUpdate || outdated,
				pullRequests,
			},
			existingStackSize: existing?.size,
		},
		pullRequestNumbers: [...(stackTop ? [stackTop.number] : []), ...chain.map(pr => pr.number)],
	};
}
