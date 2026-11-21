/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IRawFileChange } from './interface';
import { LoggingOctokit } from './loggingOctokit';
import { Repository } from '../api/api';
import { GitErrorCodes } from '../api/api1';
import { GitHubRef } from '../common/githubRef';
import Logger from '../common/logger';
import { GitHubRemote } from '../common/remote';
import { batchPromiseAll, formatError, isObject } from '../common/utils';

const ID = 'ChangesSinceReview';

// GitHub's compare API lists at most 300 changed files.
const MAX_FILES_IN_COMPARISON = 300;
const MAX_CONCURRENT_FILE_CHECKS = 10;
const MAX_FILES_IN_MESSAGE = 5;

export interface ChangesSinceReviewContext {
	readonly remote: GitHubRemote;
	readonly octokit: LoggingOctokit;
	readonly base: GitHubRef;
	readonly head: GitHubRef;
	readonly reviewedSha: string;
	readonly prNumber: number;
	readonly repository?: Repository;
}

export enum ChangesSinceReviewUnavailableReason {
	/** The reviewed commit is no longer an ancestor of the head commit, for example after a force push. */
	ReviewedCommitNotInPullRequest = 'reviewedCommitNotInPullRequest',
	/** A merge since the review changed what the pull request does to files without changing the files. */
	MergeChangedPullRequest = 'mergeChangedPullRequest',
	/** The pull request's history could not be checked. */
	CannotVerify = 'cannotVerify',
}

export interface AvailableChangesSinceReview {
	readonly kind: 'available';
	readonly files: IRawFileChange[];
}

export interface UnavailableChangesSinceReview {
	readonly kind: 'unavailable';
	readonly reason: ChangesSinceReviewUnavailableReason;
	readonly fileNames: readonly string[];
}

export type ChangesSinceReview = AvailableChangesSinceReview | UnavailableChangesSinceReview;

/**
 * The pull request at the reviewed commit and at the head commit. The pull request changes a file at a commit when the file differs
 * between the commit and the commit's merge base with the base branch.
 */
interface PullRequestHistory {
	isReviewedCommitAncestorOfHead(): Promise<boolean>;
	getMergeBases(): Promise<{ readonly reviewed: string; readonly head: string }>;
	/**
	 * Returns the files that are the same at the reviewed and head commits, but that the pull request now changes differently
	 * because a merge changed the base branch version they are compared with. Returns undefined when this can't be checked.
	 */
	getFilesChangedByMerge(): Promise<string[] | undefined>;
	/** Resolves to true only when the pull request provably leaves the file unchanged at both the reviewed and the head commit. */
	isUntouched(fileName: string): Promise<boolean>;
	/** Returns the files the pull request changed at the reviewed commit but no longer changes, or undefined when unknown. */
	getDroppedFiles(): Promise<string[] | undefined>;
}

interface Comparison {
	readonly mergeBase: string;
	readonly files: readonly IRawFileChange[];
	readonly fileNames: ReadonlySet<string>;
	/** Whether the comparison lists every changed file. */
	readonly complete: boolean;
}

type Compare = (base: string, head: string) => Promise<Comparison>;

/**
 * Determines which files changed since the last review, given GitHub's comparison of the reviewed and head commits.
 * Files that only changed because the base branch was merged in are removed, but only when the pull request provably leaves them unchanged.
 * Returns an unavailable result, which callers must answer by showing all changes, whenever the comparison could hide a change:
 * when the reviewed commit is no longer in the pull request's history, when a merge changed what the pull request does to a file
 * that the comparison doesn't list, or when the history can't be checked.
 */
export async function getChangesSinceReview(changes: IRawFileChange[], reviewAndHeadMergeBase: string, context: ChangesSinceReviewContext): Promise<ChangesSinceReview> {
	try {
		const compare = createCompare(context);
		const history = (context.repository ? await createLocalHistory(context.repository, context, compare) : undefined)
			?? createRemoteHistory(context, compare);

		// The comparison only shows what changed since the review when it starts at the reviewed commit.
		if (reviewAndHeadMergeBase !== context.reviewedSha) {
			if (await history.isReviewedCommitAncestorOfHead()) {
				return unavailable(ChangesSinceReviewUnavailableReason.CannotVerify);
			}
			const droppedFiles = await history.getDroppedFiles().catch(e => {
				Logger.debug(`Could not list files dropped since the last review of #${context.prNumber}: ${formatError(e)}`, ID);
				return undefined;
			});
			return unavailable(ChangesSinceReviewUnavailableReason.ReviewedCommitNotInPullRequest, droppedFiles);
		}

		const mergeBases = await history.getMergeBases();
		if (mergeBases.reviewed === mergeBases.head) {
			// Nothing from the base branch was merged in since the review, so every change since then was made in the pull request.
			return { kind: 'available', files: changes };
		}

		const filesChangedByMerge = await history.getFilesChangedByMerge();
		if (!filesChangedByMerge) {
			return unavailable(ChangesSinceReviewUnavailableReason.CannotVerify);
		}
		if (filesChangedByMerge.length) {
			return unavailable(ChangesSinceReviewUnavailableReason.MergeChangedPullRequest, filesChangedByMerge);
		}

		const files = await filterInOrder(changes, async change => !await isBaseBranchOnlyChange(change, history));
		Logger.debug(`Excluded ${changes.length - files.length} of ${changes.length} files that only changed in the base branch since the last review of #${context.prNumber}`, ID);
		return { kind: 'available', files };
	} catch (e) {
		Logger.warn(`Could not check the changes since the last review of #${context.prNumber}: ${formatError(e)}`, ID);
		return unavailable(ChangesSinceReviewUnavailableReason.CannotVerify);
	}
}

export function getChangesSinceReviewUnavailableMessage(changesSinceReview: UnavailableChangesSinceReview, prNumber: number): string {
	const fileNames = formatFileNames(changesSinceReview.fileNames);
	switch (changesSinceReview.reason) {
		case ChangesSinceReviewUnavailableReason.ReviewedCommitNotInPullRequest:
			return fileNames
				? vscode.l10n.t('The commit you last reviewed is no longer part of pull request #{0}, so all changes are shown. Files from your review that the pull request no longer changes: {1}', prNumber, fileNames)
				: vscode.l10n.t('The commit you last reviewed is no longer part of pull request #{0}, so all changes are shown.', prNumber);
		case ChangesSinceReviewUnavailableReason.MergeChangedPullRequest:
			return vscode.l10n.t('Since your last review, a merge changed how pull request #{0} affects some files even though their contents are unchanged, so all changes are shown. Affected files: {1}', prNumber, fileNames);
		case ChangesSinceReviewUnavailableReason.CannotVerify:
			return vscode.l10n.t('The changes since your last review of pull request #{0} could not be verified, so all changes are shown.', prNumber);
	}
}

function unavailable(reason: ChangesSinceReviewUnavailableReason, fileNames: readonly string[] = []): UnavailableChangesSinceReview {
	return { kind: 'unavailable', reason, fileNames };
}

function formatFileNames(fileNames: readonly string[]): string {
	const shown = fileNames.slice(0, MAX_FILES_IN_MESSAGE).join(', ');
	return fileNames.length > MAX_FILES_IN_MESSAGE ? vscode.l10n.t('{0} and {1} more', shown, fileNames.length - MAX_FILES_IN_MESSAGE) : shown;
}

async function isBaseBranchOnlyChange(change: IRawFileChange, history: PullRequestHistory): Promise<boolean> {
	try {
		for (const fileName of getChangeFileNames(change)) {
			if (!await history.isUntouched(fileName)) {
				return false;
			}
		}
		return true;
	} catch (e) {
		Logger.debug(`Keeping ${change.filename} because it could not be checked against the pull request: ${formatError(e)}`, ID);
		return false;
	}
}

async function filterInOrder<T>(items: readonly T[], predicate: (item: T) => Promise<boolean>): Promise<T[]> {
	const kept = new Set<T>();
	await batchPromiseAll(items, MAX_CONCURRENT_FILE_CHECKS, async item => {
		if (await predicate(item)) {
			kept.add(item);
		}
	});
	return items.filter(item => kept.has(item));
}

function getChangeFileNames(change: IRawFileChange): string[] {
	return change.previous_filename ? [change.filename, change.previous_filename] : [change.filename];
}

function createCompare({ remote, octokit }: ChangesSinceReviewContext): Compare {
	const comparisons = new Map<string, Promise<Comparison>>();
	return (base, head) => {
		const key = `${base}...${head}`;
		let comparison = comparisons.get(key);
		if (!comparison) {
			comparison = (async () => {
				const { data } = await octokit.call(octokit.api.repos.compareCommits, {
					repo: remote.repositoryName,
					owner: remote.owner,
					base,
					head,
				});
				const files = (data.files ?? []) as IRawFileChange[];
				return {
					mergeBase: data.merge_base_commit.sha,
					files,
					fileNames: new Set(files.flatMap(getChangeFileNames)),
					complete: files.length < MAX_FILES_IN_COMPARISON,
				};
			})();
			comparisons.set(key, comparison);
		}
		return comparison;
	};
}

function getRefs({ base, head, reviewedSha }: ChangesSinceReviewContext) {
	const inBaseRepository = (sha: string) => `${base.repositoryCloneUrl.owner}:${sha}`;
	return {
		inBaseRepository,
		base: inBaseRepository(base.sha),
		reviewed: inBaseRepository(reviewedSha),
		head: `${head.repositoryCloneUrl.owner}:${head.sha}`,
	};
}

/**
 * Checks the pull request with the local git repository, which compares exact tree entries (mode and object).
 * GitHub's comparisons are only used to list the files the pull request changes.
 */
async function createLocalHistory(repository: Repository, context: ChangesSinceReviewContext, compare: Compare): Promise<PullRequestHistory | undefined> {
	const baseSha = context.base.sha;
	const headSha = context.head.sha;
	const { reviewedSha } = context;
	let reviewedMergeBase: string | undefined;
	let headMergeBase: string | undefined;
	let reviewedAndHeadMergeBase: string | undefined;
	try {
		const shas = [baseSha, reviewedSha, headSha];
		const commits = await Promise.all(shas.map(sha => repository.getCommit(sha)));
		const mismatch = commits.findIndex((commit, i) => commit.hash !== shas[i]);
		if (mismatch !== -1) {
			Logger.debug(`Using GitHub to check changes since review because local commit ${commits[mismatch].hash} does not match pull request commit ${shas[mismatch]}`, ID);
			return undefined;
		}

		[reviewedMergeBase, headMergeBase, reviewedAndHeadMergeBase] = await Promise.all([
			repository.getMergeBase(baseSha, reviewedSha),
			repository.getMergeBase(baseSha, headSha),
			repository.getMergeBase(reviewedSha, headSha),
		]);
	} catch (e) {
		Logger.debug(`Using GitHub to check changes since review because the pull request commits are not available locally: ${formatError(e)}`, ID);
		return undefined;
	}
	if (!reviewedMergeBase || !headMergeBase || !reviewedAndHeadMergeBase) {
		Logger.debug('Using GitHub to check changes since review because the local merge bases could not be determined', ID);
		return undefined;
	}

	const refs = getRefs(context);
	const entries = new Map<string, Promise<string>>();
	const getEntry = (commit: string, fileName: string) => {
		const key = `${commit}:${fileName}`;
		let entry = entries.get(key);
		if (!entry) {
			entry = getTreeEntry(repository, commit, fileName);
			entries.set(key, entry);
		}
		return entry;
	};
	// The git extension rewrites `\` to `/`, so such names can't be looked up.
	const canCheck = (fileName: string) => !fileName.includes('\\');
	const isChangedBetween = async (from: string, to: string, fileName: string) => await getEntry(from, fileName) !== await getEntry(to, fileName);

	return {
		isReviewedCommitAncestorOfHead: async () => reviewedAndHeadMergeBase === reviewedSha,
		getMergeBases: async () => ({ reviewed: reviewedMergeBase, head: headMergeBase }),
		getFilesChangedByMerge: async () => {
			const headChanges = await compare(refs.base, refs.head);
			if (!headChanges.complete) {
				return undefined;
			}
			return filterInOrder([...headChanges.fileNames], async fileName => !canCheck(fileName)
				|| (!await isChangedBetween(reviewedSha, headSha, fileName) && await isChangedBetween(reviewedMergeBase, headMergeBase, fileName)));
		},
		isUntouched: async fileName => canCheck(fileName)
			&& !await isChangedBetween(headMergeBase, headSha, fileName)
			&& !await isChangedBetween(reviewedMergeBase, reviewedSha, fileName),
		getDroppedFiles: async () => {
			const reviewedChanges = await compare(refs.base, refs.reviewed);
			if (!reviewedChanges.complete) {
				return undefined;
			}
			return filterInOrder(reviewedChanges.files.map(file => file.filename), async fileName => canCheck(fileName)
				&& !await isChangedBetween(headMergeBase, headSha, fileName));
		},
	};
}

async function getTreeEntry(repository: Repository, treeish: string, fileName: string): Promise<string> {
	try {
		// The literal pathspec stops git from interpreting attacker-controlled file names as pathspec magic or globs.
		const { mode, object } = await repository.getObjectDetails(treeish, `:(literal)${fileName}`);
		return `${mode} ${object}`;
	} catch (e) {
		if (isObject(e) && e.gitErrorCode === GitErrorCodes.UnknownPath) {
			return 'absent';
		}
		throw e;
	}
}

/**
 * Checks the pull request with GitHub's comparisons of pinned commits, which list mode and type changes. The pull request files API isn't used
 * because it describes the pull request's live head, which an author can change between loading and displaying the changes.
 */
function createRemoteHistory(context: ChangesSinceReviewContext, compare: Compare): PullRequestHistory {
	const refs = getRefs(context);
	const getReviewedChanges = () => compare(refs.base, refs.reviewed);
	const getHeadChanges = () => compare(refs.base, refs.head);
	const getReviewToHeadChanges = () => compare(refs.reviewed, refs.head);

	return {
		isReviewedCommitAncestorOfHead: async () => (await getReviewToHeadChanges()).mergeBase === context.reviewedSha,
		getMergeBases: async () => {
			const [reviewedChanges, headChanges] = await Promise.all([getReviewedChanges(), getHeadChanges()]);
			return { reviewed: reviewedChanges.mergeBase, head: headChanges.mergeBase };
		},
		getFilesChangedByMerge: async () => {
			const [reviewedChanges, headChanges, reviewToHeadChanges] = await Promise.all([getReviewedChanges(), getHeadChanges(), getReviewToHeadChanges()]);
			const baseChanges = await compare(refs.inBaseRepository(reviewedChanges.mergeBase), refs.inBaseRepository(headChanges.mergeBase));
			// The base branch comparison only lists every file that differs between the merge bases when it starts at the reviewed merge base.
			if (!headChanges.complete || !reviewToHeadChanges.complete || !baseChanges.complete || baseChanges.mergeBase !== reviewedChanges.mergeBase) {
				return undefined;
			}
			return [...headChanges.fileNames].filter(fileName => !reviewToHeadChanges.fileNames.has(fileName) && baseChanges.fileNames.has(fileName));
		},
		isUntouched: async fileName => {
			const [reviewedChanges, headChanges] = await Promise.all([getReviewedChanges(), getHeadChanges()]);
			return reviewedChanges.complete && headChanges.complete && !reviewedChanges.fileNames.has(fileName) && !headChanges.fileNames.has(fileName);
		},
		getDroppedFiles: async () => {
			const [reviewedChanges, headChanges] = await Promise.all([getReviewedChanges(), getHeadChanges()]);
			if (!reviewedChanges.complete || !headChanges.complete) {
				return undefined;
			}
			return reviewedChanges.files.map(file => file.filename).filter(fileName => !headChanges.fileNames.has(fileName));
		},
	};
}
