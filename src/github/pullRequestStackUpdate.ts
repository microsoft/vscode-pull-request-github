/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { guideRebaseConflicts } from './conflictGuide';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { getUpdatableStackEntries, GithubItemStateEnum, PullRequestStack } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { StackUpdateCancelledError, supportsStackGitOperations, updateStackBranches } from './updateStackBranches';
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

/** The open pull requests that Update Stack can be run from, or `undefined` if the stack does not need an update. */
export function getUpdatableStackPullRequestNumbers(stack: PullRequestStack | undefined): Set<number> | undefined {
	const entries = stack?.needsUpdate ? getUpdatableStackEntries(stack) : undefined;
	return entries && new Set(entries.map(entry => entry.number));
}

export function canUpdateStack(updatable: ReadonlySet<number> | undefined, checkedOutNumber: number | undefined,
	hasWritePermission: boolean, hasStackRepository: () => boolean): boolean {
	return areStacksEnabled() && hasWritePermission && checkedOutNumber !== undefined
		&& !!updatable?.has(checkedOutNumber) && hasStackRepository();
}

export interface StackUpdateContext {
	item: PullRequestModel;
	folderRepositoryManager: FolderRepositoryManager;
	replyMessage(message: IRequestMessage<any>, response: UpdateStackResult): unknown;
	throwError(message: IRequestMessage<any>, error: string): unknown;
	getCheckedOutPullRequestNumber(): number | undefined;
	getStackRepository(): StackRepositoryTarget | undefined;
}

/**
 * Rebases the open pull requests of the item's stack onto their updated bases and pushes them, guiding the user
 * through any conflicts. Nothing is pushed until every branch has been rebased.
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
		const activeNumber = ctx.getCheckedOutPullRequestNumber();
		if (activeNumber === undefined || !openEntries.some(entry => entry.number === activeNumber)) {
			throw new Error(vscode.l10n.t('Check out a pull request in this stack before updating it.'));
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
		let updatedPullRequests: number[];
		try {
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
			updatedPullRequests = await updateStackBranches(repository,
				path => manager.openWorktreeRepository(vscode.Uri.file(path)),
				remote.name, branches, activeNumber, step => progress.report(step),
				(worktree, branch) => {
					// The conflict guide shows its own notifications while the user resolves conflicts.
					progress.close();
					return guideRebaseConflicts(worktree, `#${branch.number} (${branch.head})`);
				});
		} finally {
			progress.close();
		}
		await ctx.replyMessage(message, { updatedPullRequests });
		item.githubRepository.notifyStackChanged(stackNumbers);
		void vscode.window.showInformationMessage(updatedPullRequests.length
			? vscode.l10n.t('Pull request stack updated.')
			: vscode.l10n.t('Pull request stack is already up to date.'));
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
