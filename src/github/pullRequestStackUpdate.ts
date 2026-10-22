/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { guideRebaseConflicts } from './conflictGuide';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { getUpdatableStackEntries, GithubItemStateEnum, hasConflictingStackEntry, PullRequestStack } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { StackUpdateCancelledError, supportsStackGitOperations, syncLocalStackBranches, updateStackBranches } from './updateStackBranches';
import { UpdateStackResult } from './views';
import { Remote as GitRemote, Repository } from '../api/api';
import { findLocalRepoRemoteFromGitHubRef } from '../common/githubRef';
import Logger from '../common/logger';
import { PausableProgressNotification } from '../common/progress';
import { parseRemote } from '../common/remote';
import { areStacksEnabled } from '../common/settingsUtils';
import { formatError } from '../common/utils';
import { IRequestMessage } from '../common/webview';

const COMPONENT = 'PullRequestStackUpdate';

/**
 * Stacks whose branches are being rewritten or unstacked, keyed by {@link stackLockKey}.
 * Shared by every view so that two views cannot change the same stack at once.
 */
export const lockedStacks = new Set<string>();

export function stackLockKey(item: PullRequestModel, stack: PullRequestStack): string {
	return `${item.remote.owner.toLowerCase()}/${item.remote.repositoryName.toLowerCase()}#${stack.pullRequests[0].number}`;
}

export interface StackRepositoryTarget {
	manager: FolderRepositoryManager;
	repository: Repository;
	remote: GitRemote;
}

function hasSameActiveRepository(manager: FolderRepositoryManager, item: PullRequestModel): boolean {
	const active = manager.activePullRequest;
	return !!active && active.remote.owner.toLowerCase() === item.remote.owner.toLowerCase()
		&& active.remote.repositoryName.toLowerCase() === item.remote.repositoryName.toLowerCase()
		&& active.githubRepository.remote.normalizedHost === item.githubRepository.remote.normalizedHost;
}

/** The number of the pull request from the same repository that is checked out in any of `managers`. */
export function getCheckedOutPullRequestNumber(managers: readonly FolderRepositoryManager[], item: PullRequestModel): number | undefined {
	return managers.find(manager => hasSameActiveRepository(manager, item))?.activePullRequest?.number;
}

/**
 * Finds a local repository that can rewrite the stack branches: a desktop file repository whose Git extension
 * supports the stack operations, with a writable remote for the pull request's head repository.
 * Prefers the repository where a pull request from the same repository is checked out, then `preferred`.
 */
export function findStackRepository(managers: readonly FolderRepositoryManager[], preferred: FolderRepositoryManager,
	item: PullRequestModel): StackRepositoryTarget | undefined {
	if (vscode.env.uiKind !== vscode.UIKind.Desktop || !item.head) {
		return;
	}
	const candidates = managers.flatMap(manager => {
		const repository = manager.repository;
		if (repository.rootUri.scheme !== 'file' || !supportsStackGitOperations(repository)) {
			return [];
		}
		const remote = findLocalRepoRemoteFromGitHubRef(repository, item.head!);
		const push = remote && parseRemote(remote.name, remote.pushUrl ?? remote.fetchUrl ?? '');
		return remote && !remote.isReadOnly && push
			&& push.owner.toLowerCase() === item.remote.owner.toLowerCase()
			&& push.repositoryName.toLowerCase() === item.remote.repositoryName.toLowerCase()
			&& push.matchesServerUri(item.githubRepository.hub.serverUri)
			? [{ manager, repository, remote }] : [];
	});
	return candidates.find(candidate => hasSameActiveRepository(candidate.manager, item))
		?? candidates.find(candidate => candidate.manager === preferred)
		?? candidates[0];
}

/** Whether and how the stack can be updated, before considering the user's checkout and permissions. */
export interface StackUpdateEligibility {
	/** The open pull requests a local rebase can be started from, by having one of them checked out. */
	pullRequests: ReadonlySet<number>;
	/** Conflicts must be resolved during a local rebase; otherwise GitHub rebases the stack. */
	requiresLocalRebase: boolean;
}

/** How the stack can be updated, or `undefined` if it does not need, or cannot have, an update. */
export function getStackUpdateEligibility(stack: PullRequestStack | undefined): StackUpdateEligibility | undefined {
	const entries = stack?.needsUpdate ? getUpdatableStackEntries(stack) : undefined;
	return entries && { pullRequests: new Set(entries.map(entry => entry.number)), requiresLocalRebase: hasConflictingStackEntry(stack) };
}

export function canUpdateStack(eligibility: StackUpdateEligibility | undefined, checkedOutNumber: number | undefined,
	hasWritePermission: boolean, hasStackRepository: () => boolean): boolean {
	return areStacksEnabled() && hasWritePermission && !!eligibility && (!eligibility.requiresLocalRebase
		|| checkedOutNumber !== undefined && eligibility.pullRequests.has(checkedOutNumber) && hasStackRepository());
}

export interface StackUpdateContext {
	item: PullRequestModel;
	folderRepositoryManager: FolderRepositoryManager;
	replyMessage(message: IRequestMessage<any>, response: UpdateStackResult): unknown;
	throwError(message: IRequestMessage<any>, error: string): unknown;
	getCheckedOutPullRequestNumber(): number | undefined;
	getStackRepository(): StackRepositoryTarget | undefined;
}

type OpenStackEntries = NonNullable<ReturnType<typeof getUpdatableStackEntries>>;

interface StackUpdateOutcome {
	updatedPullRequests: number[];
	/** GitHub is still rebasing the stack after we stopped waiting. */
	pending?: boolean;
	/** Local branches that were not brought up to date after GitHub rebased the stack. */
	notUpdatedBranches?: string[];
}

/**
 * Rebases the open pull requests of the item's stack onto their updated bases. Without conflicts, GitHub rebases the
 * stack and local branches are brought up to date. With conflicts, the stack is rebased locally from a checked-out
 * pull request, guiding the user through the conflicts; nothing is pushed until every branch has been rebased.
 */
export async function updatePullRequestStack(ctx: StackUpdateContext, message: IRequestMessage<undefined>): Promise<void> {
	const { item } = ctx;
	let lockKey: string | undefined;
	let stackNumbers: number[] = [];
	try {
		if (!areStacksEnabled()) {
			throw new Error(vscode.l10n.t('Pull request stack features are disabled.'));
		}
		const access = await ctx.folderRepositoryManager.getPullRequestRepositoryAccessAndMergeMethods(item);
		if (!access.hasWritePermission) {
			throw new Error(vscode.l10n.t('You do not have permission to update this stack.'));
		}
		const stack = await item.getStack();
		const openEntries = stack && getUpdatableStackEntries(stack);
		if (!stack || !openEntries) {
			throw new Error(vscode.l10n.t('Update stack requires an open chain of pull requests.'));
		}
		const requiresLocalRebase = hasConflictingStackEntry(stack);
		const activeNumber = ctx.getCheckedOutPullRequestNumber();
		if (requiresLocalRebase && (activeNumber === undefined || !openEntries.some(entry => entry.number === activeNumber))) {
			throw new Error(vscode.l10n.t('Check out a pull request in this stack to resolve its conflicts.'));
		}
		const key = stackLockKey(item, stack);
		if (lockedStacks.has(key)) {
			throw new Error(vscode.l10n.t('The pull request stack is already being updated.'));
		}
		lockKey = key;
		lockedStacks.add(lockKey);
		stackNumbers = stack.pullRequests.map(entry => entry.number);
		const action = vscode.l10n.t('Update stack');
		const answer = await vscode.window.showWarningMessage(
			vscode.l10n.t('Rebase and push {0} pull requests in this stack?', openEntries.length),
			{ modal: true, detail: vscode.l10n.t('This rewrites the stack branches on GitHub.') },
			action,
		);
		if (answer !== action) {
			await ctx.replyMessage(message, { updatedPullRequests: [] });
			return;
		}
		const progress = new PausableProgressNotification(vscode.l10n.t('Updating pull request stack'));
		Logger.appendLine(requiresLocalRebase
			? `Updating the stack of #${item.number} locally from #${activeNumber}, because a pull request in it has conflicts`
			: `Updating the stack of #${item.number} on GitHub, because no pull request in it has conflicts`, COMPONENT);
		let outcome: StackUpdateOutcome;
		try {
			outcome = requiresLocalRebase
				? { updatedPullRequests: await rebaseStackLocally(ctx, stack, openEntries, activeNumber!, progress) }
				: await rebaseStackOnGitHub(ctx, stack, openEntries, progress);
		} finally {
			progress.close();
		}
		Logger.appendLine(`Stack update of #${item.number} finished: ${JSON.stringify(outcome)}`, COMPONENT);
		await ctx.replyMessage(message, { updatedPullRequests: outcome.updatedPullRequests });
		item.githubRepository.notifyStackChanged(stackNumbers);
		if (outcome.pending) {
			void vscode.window.showInformationMessage(vscode.l10n.t('GitHub is still updating the pull request stack. Refresh the pull request later to see the result.'));
		} else if (outcome.notUpdatedBranches?.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Pull request stack updated. These local branches have other changes and were not updated: {0}',
				outcome.notUpdatedBranches.join(', ')));
		} else {
			void vscode.window.showInformationMessage(outcome.updatedPullRequests.length
				? vscode.l10n.t('Pull request stack updated.')
				: vscode.l10n.t('Pull request stack is already up to date.'));
		}
	} catch (error) {
		if (error instanceof StackUpdateCancelledError) {
			await ctx.replyMessage(message, { updatedPullRequests: [] });
			void vscode.window.showInformationMessage(vscode.l10n.t('Pull request stack update cancelled. No branches were pushed.'));
			return;
		}
		Logger.error(`Failed to update pull request stack: ${formatError(error)}`, COMPONENT);
		void vscode.window.showErrorMessage(vscode.l10n.t('Unable to update pull request stack: {0}', formatError(error)));
		await ctx.throwError(message, formatError(error));
		if (stackNumbers.length) {
			item.githubRepository.notifyStackChanged(stackNumbers);
		}
	} finally {
		if (lockKey) {
			lockedStacks.delete(lockKey);
		}
	}
}

/**
 * Has GitHub rebase the stack, then brings the stack's local branches up to date when a local repository for them is
 * available. GitHub checks that the stack still has the pull requests the user confirmed.
 */
async function rebaseStackOnGitHub(ctx: StackUpdateContext, stack: PullRequestStack, openEntries: OpenStackEntries,
	progress: PausableProgressNotification): Promise<StackUpdateOutcome> {
	progress.report(vscode.l10n.t('Rebasing the stack on GitHub'));
	const result = await ctx.item.githubRepository.rebaseStack(ctx.item.number, stack.pullRequests.map(entry => entry.number));
	if (result.status === 'pending') {
		return { updatedPullRequests: [], pending: true };
	}
	const open = new Set(openEntries.map(entry => entry.number));
	const updatedPullRequests = result.rebasedPullRequests?.filter(number => open.has(number)) ?? [...open];
	const target = ctx.getStackRepository();
	if (!target || !supportsStackGitOperations(target.repository)) {
		Logger.appendLine('No local repository can update the stack branches, so local branches were left as they are', COMPONENT);
		return { updatedPullRequests };
	}
	progress.report(vscode.l10n.t('Updating local branches'));
	const notUpdatedBranches = await syncLocalStackBranches(target.repository, target.remote.name,
		result.before.filter(pr => open.has(pr.number)).map(pr => ({ head: pr.ref, previousSha: pr.sha })));
	return { updatedPullRequests, notUpdatedBranches };
}

/** Rebases the stack locally from the checked-out pull request, guiding the user through conflicts, then pushes it. */
async function rebaseStackLocally(ctx: StackUpdateContext, stack: PullRequestStack, openEntries: OpenStackEntries,
	activeNumber: number, progress: PausableProgressNotification): Promise<number[]> {
	const { item } = ctx;
	progress.report(vscode.l10n.t('Checking stack branches'));
	const current = await item.getStack();
	const currentOpenEntries = current && getUpdatableStackEntries(current);
	if (!current || !currentOpenEntries || currentOpenEntries.length !== openEntries.length
		|| ctx.getCheckedOutPullRequestNumber() !== activeNumber
		|| current.size !== stack.size || current.pullRequests.some((entry, index) =>
			entry.number !== stack.pullRequests[index].number || entry.head !== stack.pullRequests[index].head)) {
		throw new Error(vscode.l10n.t('The pull request stack changed. Refresh and try again.'));
	}
	const target = ctx.getStackRepository();
	if (!target) {
		throw new Error(vscode.l10n.t('A writable Git remote for this stack is not available locally.'));
	}
	const { manager, repository, remote } = target;
	if (!supportsStackGitOperations(repository)) {
		throw new Error(vscode.l10n.t('A newer built-in Git extension is required to update this stack.'));
	}
	const branches = await Promise.all(currentOpenEntries.map(async (entry, index) => {
		const pr = await item.githubRepository.getPullRequest(entry.number, 'updateStack');
		const base = index === 0 ? current.base : current.pullRequests[index - 1].head;
		if (!pr || pr.state !== GithubItemStateEnum.Open || !pr.head || !pr.base
			|| pr.mergeQueueEntry || pr.head.ref !== entry.head || pr.base.ref !== base
			|| pr.head.owner.toLowerCase() !== item.remote.owner.toLowerCase()
			|| pr.base.owner.toLowerCase() !== item.remote.owner.toLowerCase()
			|| pr.head.repositoryCloneUrl.repositoryName.toLowerCase() !== item.remote.repositoryName.toLowerCase()
			|| pr.base.repositoryCloneUrl.repositoryName.toLowerCase() !== item.remote.repositoryName.toLowerCase()) {
			throw new Error(vscode.l10n.t('Pull request #{0} is no longer part of a supported, open branch chain.', entry.number));
		}
		return { number: entry.number, base, head: entry.head, sha: pr.head.sha };
	}));
	if (!areStacksEnabled()) {
		throw new Error(vscode.l10n.t('Pull request stack features are disabled.'));
	}
	return updateStackBranches(repository,
		path => manager.openWorktreeRepository(vscode.Uri.file(path)),
		remote.name, branches, activeNumber, step => progress.report(step),
		(worktree, branch) => {
			// The conflict guide shows its own notifications while the user resolves conflicts.
			progress.close();
			return guideRebaseConflicts(worktree, `#${branch.number} (${branch.head})`);
		});
}