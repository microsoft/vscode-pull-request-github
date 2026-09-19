/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This module intentionally has no runtime dependency on `vscode` so that it can be unit tested
// without an extension host. Keep it that way: only `import type` from modules that import `vscode`.
import type { IComment, IReviewThread } from '../common/comment';

/**
 * Which commits of a pull request are compared when showing its changed files.
 * - `all`: the pull request base (merge base) to the head. This is the default.
 * - `sinceLastReview`: the commit the viewer last reviewed to the head.
 * - `sinceLastComment`: the commit the viewer's newest review comment was written against, to the head.
 * - `sinceEarliestUnresolvedThread`: the commit the earliest unresolved thread was started on, to the head.
 * - `custom`: a base commit chosen by the user.
 */
export type DiffRangePreset = 'all' | 'sinceLastReview' | 'sinceLastComment' | 'sinceEarliestUnresolvedThread' | 'custom';

/**
 * Presets whose base commit is derived from review data.
 */
export type ResolvableDiffRangePreset = Exclude<DiffRangePreset, 'all' | 'custom'>;

/**
 * Values accepted by the `githubPullRequests.defaultDiffRange` setting.
 */
export type DefaultDiffRangePreset = Extract<DiffRangePreset, 'all' | 'sinceLastReview' | 'sinceEarliestUnresolvedThread'>;

export type DiffRangeUnavailableReason =
	| 'noReview'
	| 'reviewAtHead'
	| 'noViewer'
	| 'noOwnComment'
	| 'commentAtHead'
	| 'noUnresolvedThread'
	| 'threadAtHead';

export type DiffRangeWarning =
	/** The base commit is not part of the pull request's commit list (for example after a force push). */
	| 'baseNotInPullRequest'
	/** The base commit is not an ancestor of the head; GitHub compared from their merge base instead. */
	| 'baseNotAncestor'
	/** The preset could not be resolved and all changes are shown instead. */
	| 'presetUnavailable';

export interface DiffRange {
	readonly preset: DiffRangePreset;
	/**
	 * The commit to use as the left side of the comparison. `undefined` means the pull request base
	 * for `all`, and "not resolved yet" for the resolvable presets.
	 */
	readonly baseSha?: string;
	/**
	 * The commit to use as the right side of the comparison. `undefined` means the pull request head.
	 */
	readonly headSha?: string;
	readonly warning?: DiffRangeWarning;
}

export const ALL_CHANGES: DiffRange = { preset: 'all' };

export interface DiffRangeInputs {
	readonly threads: readonly IReviewThread[];
	/** The commit of the viewer's most recent submitted review, if any. */
	readonly latestReviewSha?: string;
	readonly viewerLogin?: string;
	/** The commits in the pull request. When empty, the "base is part of the pull request" check is skipped. */
	readonly commits: readonly { sha: string }[];
	readonly headSha: string;
}

export interface ResolvedDiffRange {
	readonly baseSha: string;
	readonly headSha: string;
	readonly warning?: DiffRangeWarning;
	/** The comment that determined the base commit, when there is one. */
	readonly anchor?: { readonly path?: string; readonly createdAt: string };
}

export interface UnavailableDiffRange {
	readonly unavailable: DiffRangeUnavailableReason;
}

export type DiffRangeResolution = ResolvedDiffRange | UnavailableDiffRange;

export function isUnavailableDiffRange(resolution: DiffRangeResolution): resolution is UnavailableDiffRange {
	return (resolution as UnavailableDiffRange).unavailable !== undefined;
}

export function shortSha(sha: string): string {
	return sha.substring(0, 7);
}

/**
 * A string that changes exactly when the range would produce a different comparison.
 */
export function diffRangeKey(range: DiffRange): string {
	return `${range.preset}:${range.baseSha ?? ''}:${range.headSha ?? ''}`;
}

/**
 * The tree item context value segment describing the range, used by the menu `when` clauses in package.json.
 */
export function diffRangeContextValue(range: DiffRange): ':showingAllChanges' | ':showingChangesSinceReview' | ':customRange' {
	switch (range.preset) {
		case 'all':
			return ':showingAllChanges';
		case 'sinceLastReview':
			return ':showingChangesSinceReview';
		default:
			return ':customRange';
	}
}

export function resolveDiffRangePreset(preset: ResolvableDiffRangePreset, inputs: DiffRangeInputs): DiffRangeResolution {
	switch (preset) {
		case 'sinceLastReview':
			return resolveSinceLastReview(inputs);
		case 'sinceLastComment':
			return resolveSinceLastComment(inputs);
		case 'sinceEarliestUnresolvedThread':
			return resolveSinceEarliestUnresolvedThread(inputs);
	}
}

function resolveSinceLastReview(inputs: DiffRangeInputs): DiffRangeResolution {
	if (!inputs.latestReviewSha) {
		return { unavailable: 'noReview' };
	}
	if (inputs.latestReviewSha === inputs.headSha) {
		return { unavailable: 'reviewAtHead' };
	}
	return finish(inputs.latestReviewSha, inputs);
}

function resolveSinceLastComment(inputs: DiffRangeInputs): DiffRangeResolution {
	if (!inputs.viewerLogin) {
		return { unavailable: 'noViewer' };
	}
	let newest: IComment | undefined;
	for (const thread of inputs.threads) {
		for (const comment of thread.comments) {
			if (!comment.originalCommitId || comment.user?.login !== inputs.viewerLogin) {
				continue;
			}
			if (!newest || compareDates(comment.createdAt, newest.createdAt) > 0) {
				newest = comment;
			}
		}
	}
	if (!newest) {
		return { unavailable: 'noOwnComment' };
	}
	if (newest.originalCommitId === inputs.headSha) {
		return { unavailable: 'commentAtHead' };
	}
	return finish(newest.originalCommitId!, inputs, newest);
}

function resolveSinceEarliestUnresolvedThread(inputs: DiffRangeInputs): DiffRangeResolution {
	let earliest: IComment | undefined;
	for (const thread of inputs.threads) {
		if (thread.isResolved) {
			continue;
		}
		const first = thread.comments[0];
		if (!first?.originalCommitId) {
			continue;
		}
		if (!earliest || compareDates(first.createdAt, earliest.createdAt) < 0) {
			earliest = first;
		}
	}
	if (!earliest) {
		return { unavailable: 'noUnresolvedThread' };
	}
	if (earliest.originalCommitId === inputs.headSha) {
		return { unavailable: 'threadAtHead' };
	}
	return finish(earliest.originalCommitId!, inputs, earliest);
}

function finish(baseSha: string, inputs: DiffRangeInputs, anchor?: IComment): ResolvedDiffRange {
	const inPullRequest = inputs.commits.length === 0 || inputs.commits.some(commit => commit.sha === baseSha);
	return {
		baseSha,
		headSha: inputs.headSha,
		warning: inPullRequest ? undefined : 'baseNotInPullRequest',
		anchor: anchor ? { path: anchor.path, createdAt: anchor.createdAt } : undefined,
	};
}

function compareDates(a: string, b: string): number {
	return Date.parse(a) - Date.parse(b);
}
