/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { realpathSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { Repository } from '../api/api';
import Logger from '../common/logger';
import { generateUuid } from '../common/uuid';

const STACK_WORKTREE_PREFIX = 'vscode-pr-stack-';
// Worktree names record the owning process so another window's in-progress update is never removed.
const STACK_WORKTREE_NAME = /^vscode-pr-stack-(?<pid>\d+)-[0-9a-f-]+$/i;
// Names of temporary worktrees owned by updates running in this process.
const activeStackWorktrees = new Set<string>();

function normalizeWorktreePath(worktreePath: string): string {
	const resolved = path.resolve(worktreePath);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Git records worktree paths with symlinks resolved (on macOS, /private/var rather than /var), so the temporary
 * directory is matched in both its reported and canonical forms. Paths read from the repository are never resolved,
 * so they cannot cause file system or network access.
 */
function temporaryDirectories(): Set<string> {
	const directory = tmpdir();
	const forms = [directory];
	try {
		forms.push(realpathSync.native(directory));
	} catch {
		// Match the reported form only.
	}
	return new Set(forms.map(normalizeWorktreePath));
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return error?.code === 'EPERM';
	}
}

/**
 * Removes temporary stack worktrees left behind when VS Code exited during an update, for example while the
 * user was resolving conflicts. Worktrees still in use by an update in this or another running window are kept.
 */
export async function removeOrphanedStackWorktrees(repository: StackGitRepository,
	isRunning: (pid: number) => boolean = isProcessRunning): Promise<void> {
	const temporaryDirectoryForms = temporaryDirectories();
	const orphaned = (repository.state.worktrees ?? []).filter(worktree => {
		const name = path.basename(worktree.path);
		const pid = STACK_WORKTREE_NAME.exec(name)?.groups?.pid;
		if (worktree.main || !pid || !temporaryDirectoryForms.has(normalizeWorktreePath(path.dirname(worktree.path)))
			|| activeStackWorktrees.has(name.toLowerCase())) {
			return false;
		}
		return Number(pid) === process.pid || !isRunning(Number(pid));
	});
	for (const worktree of orphaned) {
		try {
			await repository.deleteWorktree(worktree.path, { force: true });
		} catch (error) {
			Logger.warn(`Could not remove orphaned stack worktree ${worktree.path}: ${error}`, 'UpdateStack');
		}
	}
}

export interface StackBranch {
	number: number;
	head: string;
	base: string;
	sha: string;
}

export type StackGitRepository = Repository & Required<Pick<Repository,
	'createWorktree' | 'deleteWorktree' | 'rebase' | 'rebaseAbort' | 'resetKeep' | 'updateRef' | 'pushRefWithLease' | 'getRemoteRefs'>>;

export function supportsStackGitOperations(repository: Repository): repository is StackGitRepository {
	return typeof repository.createWorktree === 'function'
		&& typeof repository.deleteWorktree === 'function'
		&& typeof repository.rebase === 'function'
		&& typeof repository.rebaseAbort === 'function'
		&& typeof repository.resetKeep === 'function'
		&& typeof repository.updateRef === 'function'
		&& typeof repository.pushRefWithLease === 'function'
		&& typeof repository.getRemoteRefs === 'function';
}

/**
 * Guides the user through resolving the conflicts of the rebase stopped in `repository` and continuing it.
 * Resolves to `true` once the rebase has moved past the conflicting commit, or `false` if the user cancelled.
 */
export type StackConflictResolver = (repository: Repository, branch: StackBranch) => Promise<boolean>;

export class StackUpdateCancelledError extends Error {
	constructor(branch: StackBranch) {
		super(`Updating the stack was cancelled while rebasing #${branch.number} (${branch.head}). No branches were pushed.`);
	}
}

async function isStoppedAtConflict(repository: StackGitRepository): Promise<boolean> {
	if (typeof repository.rebaseContinue !== 'function') {
		return false;
	}
	await repository.status();
	return !!repository.state.rebaseCommit && repository.state.mergeChanges.length > 0;
}

async function resolveRebaseConflicts(repository: StackGitRepository, branch: StackBranch, newBase: string,
	resolveConflicts: StackConflictResolver): Promise<void> {
	for (; ;) {
		await repository.status();
		if (!repository.state.rebaseCommit) {
			break;
		}
		if (!repository.state.mergeChanges.length) {
			await repository.rebaseAbort();
			throw new Error(`Rebasing #${branch.number} (${branch.head}) stopped without conflicts to resolve. No branches were pushed.`);
		}
		if (!await resolveConflicts(repository, branch)) {
			await repository.status();
			if (repository.state.rebaseCommit) {
				await repository.rebaseAbort();
			}
			throw new StackUpdateCancelledError(branch);
		}
	}
	// The rebase can also be aborted from the Source Control view, which leaves the branch on its old base.
	if (await repository.getMergeBase(newBase, 'HEAD') !== newBase) {
		throw new StackUpdateCancelledError(branch);
	}
}

async function localBranches(repository: Repository): Promise<Map<string, string>> {
	const branches = await repository.getBranches({ remote: false });
	const result = new Map<string, string>();
	for (const branch of branches) {
		if (branch.name && branch.commit) {
			result.set(branch.name, branch.commit);
		}
	}
	return result;
}

async function ensureClean(repository: Repository): Promise<void> {
	await repository.status();
	const { indexChanges, workingTreeChanges, mergeChanges } = repository.state;
	if (indexChanges.length || workingTreeChanges.length || mergeChanges.length || repository.state.untrackedChanges?.length) {
		throw new Error('Commit or stash all working tree changes before updating the stack.');
	}
}

function checkedOutElsewhere(repository: Repository, name: string, activeName: string): boolean {
	return name !== activeName && (repository.state.worktrees?.some(worktree =>
		!worktree.detached && worktree.ref === `refs/heads/${name}`) ?? false);
}

/**
 * Brings local stack branches up to date after the stack was rebased on GitHub. A branch is only moved if it still
 * points at the commit the pull request had before the rebase, so local commits are never discarded. The checked-out
 * branch is moved with `reset --keep`, which keeps uncommitted changes and refuses if it would overwrite them.
 * Resolves to the local branches that were left as they were because they diverged or could not be moved.
 */
export async function syncLocalStackBranches(repository: StackGitRepository, remote: string,
	branches: readonly { head: string; previousSha: string }[]): Promise<string[]> {
	await repository.status();
	const activeName = repository.state.HEAD?.name;
	const local = await localBranches(repository);
	const notUpdated: string[] = [];
	for (const { head, previousSha } of branches) {
		const localSha = local.get(head);
		if (!localSha) {
			Logger.appendLine(`Local branch ${head} does not exist, so there is nothing to update`, 'UpdateStack');
			continue;
		}
		try {
			await repository.fetch(remote, `+refs/heads/${head}:refs/remotes/${remote}/${head}`);
			const rebasedSha = (await repository.getBranch(`refs/remotes/${remote}/${head}`)).commit;
			const state = `local ${localSha}, before the rebase ${previousSha}, on GitHub now ${rebasedSha}`;
			if (!rebasedSha || rebasedSha === localSha) {
				Logger.appendLine(`Local branch ${head} is already up to date (${state})`, 'UpdateStack');
				continue;
			}
			if (localSha !== previousSha || checkedOutElsewhere(repository, head, activeName ?? '')) {
				Logger.appendLine(`Left local branch ${head} as it is, because ${localSha !== previousSha ? 'it has other commits' : 'another worktree has it checked out'} (${state})`, 'UpdateStack');
				notUpdated.push(head);
			} else if (head === activeName) {
				await repository.resetKeep(rebasedSha);
				Logger.appendLine(`Moved the checked-out branch ${head} to the rebased commit (${state})`, 'UpdateStack');
			} else {
				await repository.updateRef(`refs/heads/${head}`, rebasedSha, previousSha);
				Logger.appendLine(`Moved local branch ${head} to the rebased commit (${state})`, 'UpdateStack');
			}
		} catch (error) {
			Logger.warn(`Could not update local branch ${head} after rebasing the stack on GitHub: ${error}`, 'UpdateStack');
			notUpdated.push(head);
		}
	}
	return notUpdated;
}

async function verifyBases(repository: StackGitRepository, remote: string, branches: readonly StackBranch[],
	original: Map<string, string>, skipped: number): Promise<void> {
	const remoteRefs = await repository.getRemoteRefs(remote, { heads: true });
	for (const ref of [branches[0].base, ...branches.slice(0, skipped).map(branch => branch.head)]) {
		if (remoteRefs.find(branch => branch.name === ref)?.commit !== original.get(ref)) {
			throw new Error(`Base branch ${ref} changed on GitHub. Refresh and try again.`);
		}
	}
}

/**
 * Deletes the temporary worktree. A worktree that cannot be deleted, for example because Windows briefly still has
 * a handle on its folder, does not fail the update: by then the update has finished, been cancelled, or failed for
 * another reason. The next update removes the worktree if Git still lists it; otherwise only an empty temporary
 * folder remains.
 */
async function removeTemporaryWorktree(repository: StackGitRepository, worktreePath: string): Promise<void> {
	try {
		await repository.deleteWorktree(worktreePath, { force: true });
	} catch (error) {
		Logger.warn(`Could not remove temporary stack worktree ${worktreePath}: ${error}`, 'UpdateStack');
	}
}

export async function updateStackBranches(
	repository: StackGitRepository,
	openWorktree: (worktreePath: string) => Promise<Repository | null>,
	remote: string,
	branches: readonly StackBranch[],
	activeNumber: number,
	report: (message: string) => void,
	resolveConflicts?: StackConflictResolver,
): Promise<number[]> {
	if (!branches.length || new Set(branches.map(branch => branch.number)).size !== branches.length
		|| new Set([branches[0].base, ...branches.map(branch => branch.head)]).size !== branches.length + 1
		|| !branches.some(branch => branch.number === activeNumber)
		|| branches.some((branch, index) => !branch.sha || index > 0 && branch.base !== branches[index - 1].head)) {
		throw new Error('Pull request stack branches do not form a chain.');
	}

	report('Fetching stack branches');
	const refs = [branches[0].base, ...branches.map(branch => branch.head)];
	for (const ref of refs) {
		await repository.fetch(remote, `+refs/heads/${ref}:refs/remotes/${remote}/${ref}`);
	}
	const original = new Map<string, string>();
	for (const ref of refs) {
		const branch = await repository.getBranch(`refs/remotes/${remote}/${ref}`);
		if (!branch.commit) {
			throw new Error(`Could not resolve remote stack branch ${ref}.`);
		}
		original.set(ref, branch.commit);
	}
	for (const branch of branches) {
		if (original.get(branch.head) !== branch.sha) {
			throw new Error(`Pull request #${branch.number} changed on GitHub. Refresh and try again.`);
		}
	}

	const activeName = repository.state.HEAD?.name;
	const active = branches.find(branch => branch.number === activeNumber)!;
	if (!activeName || (await repository.getBranch(activeName)).commit !== active.sha) {
		throw new Error(`Checked-out branch has local commits that differ from pull request #${activeNumber}.`);
	}
	await ensureClean(repository);
	await removeOrphanedStackWorktrees(repository);
	const heads = await localBranches(repository);
	for (const branch of branches) {
		const sha = heads.get(branch.head);
		if (sha && sha !== branch.sha) {
			throw new Error(`Local branch ${branch.head} differs from pull request #${branch.number}. Preserve those commits before updating the stack.`);
		}
		if (checkedOutElsewhere(repository, branch.head, activeName)) {
			throw new Error(`Branch ${branch.head} is checked out in another worktree. Close that worktree before updating the stack.`);
		}
	}
	const existingNames = [...heads.keys()].map(name => name.toLowerCase());
	for (const branch of branches) {
		const name = branch.head.toLowerCase();
		if (!heads.has(branch.head) && existingNames.some(existing =>
			existing === name || existing.startsWith(`${name}/`) || name.startsWith(`${existing}/`))) {
			throw new Error(`Local branch ${branch.head} cannot be created because its name conflicts with another branch.`);
		}
	}

	const forks: string[] = [];
	let startIndex = branches.length;
	for (const [index, branch] of branches.entries()) {
		const base = original.get(branch.base)!;
		const fork = await repository.getMergeBase(base, branch.sha);
		if (!fork) {
			throw new Error(`Could not find a common ancestor for pull request #${branch.number}.`);
		}
		forks.push(fork);
		if (startIndex === branches.length && fork !== base) {
			startIndex = index;
		}
	}
	const branchesToRebase = branches.slice(startIndex);
	if (!branchesToRebase.length) {
		await verifyBases(repository, remote, branches, original, startIndex);
		return [];
	}

	let worktreePath: string | undefined;
	const updated: number[] = [];
	let failure: Error | undefined;
	// Registered before creation so a concurrent update in this process never treats it as orphaned.
	const requestedWorktreeName = `${STACK_WORKTREE_PREFIX}${process.pid}-${generateUuid()}`.toLowerCase();
	const requestedWorktreePath = path.join(tmpdir(), requestedWorktreeName);
	activeStackWorktrees.add(requestedWorktreeName);
	try {
		worktreePath = await repository.createWorktree({
			path: requestedWorktreePath,
			commitish: original.get(branchesToRebase[0].head)!,
		});
		const opened = await openWorktree(worktreePath);
		if (!opened || !supportsStackGitOperations(opened)) {
			throw new Error('The Git extension could not open the temporary stack worktree.');
		}
		const rebased = new Map<string, string>();
		for (const [index, branch] of branchesToRebase.entries()) {
			const oldHead = original.get(branch.head)!;
			const oldBase = original.get(branch.base)!;
			const newBase = rebased.get(branch.base) ?? oldBase;
			report(`Rebasing #${branch.number} (${branch.head}) onto ${branch.base}`);
			await opened.checkout(oldHead);
			try {
				await opened.rebase(forks[startIndex + index], { onto: newBase, rebaseMerges: true });
			} catch (error) {
				if (!resolveConflicts || !await isStoppedAtConflict(opened)) {
					await opened.rebaseAbort();
					throw new Error(`Rebasing #${branch.number} (${branch.head}) caused a conflict or failed: ${error}`);
				}
				await resolveRebaseConflicts(opened, branch, newBase, resolveConflicts);
			}
			rebased.set(branch.head, (await opened.getCommit('HEAD')).hash);
		}

		report('Checking stack branches before pushing');
		await verifyBases(repository, remote, branches, original, startIndex);
		await ensureClean(repository);
		if (repository.state.HEAD?.name !== activeName || (await repository.getBranch(activeName)).commit !== active.sha) {
			throw new Error('The checked-out branch changed during the update. No branches were pushed.');
		}
		const beforePush = await localBranches(repository);
		for (const branch of branchesToRebase) {
			if (beforePush.get(branch.head) !== heads.get(branch.head)) {
				throw new Error(`Local branch ${branch.head} changed during the update. No branches were pushed.`);
			}
		}
		for (const branch of branchesToRebase) {
			await repository.status();
			if (repository.state.HEAD?.name !== activeName) {
				throw new Error(`Checked-out branch changed during the update; already updated: ${updated.length ? updated.map(number => `#${number}`).join(', ') : 'none'}.`);
			}
			const newHead = rebased.get(branch.head)!;
			if (newHead !== branch.sha) {
				report(`Pushing #${branch.number} (${branch.head})`);
				try {
					await repository.pushRefWithLease(remote, branch.head, newHead, branch.sha);
				} catch (error) {
					throw new Error(`Could not push #${branch.number} (${branch.head}); already updated: ${updated.length ? updated.map(number => `#${number}`).join(', ') : 'none'}. ${error}`);
				}
				updated.push(branch.number);
			}
			report(`Updating local branch ${branch.head}`);
			try {
				await repository.status();
				if (repository.state.HEAD?.name !== activeName) {
					throw new Error('The checked-out branch changed during the push.');
				}
				if (branch.number === activeNumber) {
					if ((await repository.getBranch(activeName)).commit !== active.sha) {
						throw new Error(`Checked-out branch ${activeName} changed while updating the stack.`);
					}
					await ensureClean(repository);
					if (activeName !== branch.head) {
						if (checkedOutElsewhere(repository, branch.head, activeName)) {
							throw new Error(`Branch ${branch.head} was checked out in another worktree during the update.`);
						}
						await repository.updateRef(`refs/heads/${branch.head}`, newHead, heads.get(branch.head) ?? '0'.repeat(40));
					}
					if (newHead !== active.sha) {
						await repository.resetKeep(newHead);
					}
				} else {
					if (checkedOutElsewhere(repository, branch.head, activeName)) {
						throw new Error(`Branch ${branch.head} was checked out in another worktree during the update.`);
					}
					await repository.updateRef(`refs/heads/${branch.head}`, newHead, heads.get(branch.head) ?? '0'.repeat(40));
				}
				if (!heads.has(branch.head)) {
					await repository.setBranchUpstream(branch.head, `refs/remotes/${remote}/${branch.head}`);
				}
			} catch (error) {
				throw new Error(`Pull request #${branch.number} was pushed${newHead === branch.sha ? ' previously' : ''} but local branch ${branch.head} could not be updated. Reconcile the local branch before retrying: ${error}`);
			}
		}
	} catch (error) {
		failure = error instanceof Error ? error : new Error(String(error));
	} finally {
		if (worktreePath) {
			await removeTemporaryWorktree(repository, worktreePath);
		}
		activeStackWorktrees.delete(requestedWorktreeName);
	}
	if (failure) {
		throw failure;
	}
	return updated;
}
