/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { tmpdir } from 'os';
import * as path from 'path';
import { Repository } from '../api/api';
import { generateUuid } from '../common/uuid';

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

async function verifyBases(repository: StackGitRepository, remote: string, branches: readonly StackBranch[],
	original: Map<string, string>, skipped: number): Promise<void> {
	const remoteRefs = await repository.getRemoteRefs(remote, { heads: true });
	for (const ref of [branches[0].base, ...branches.slice(0, skipped).map(branch => branch.head)]) {
		if (remoteRefs.find(branch => branch.name === ref)?.commit !== original.get(ref)) {
			throw new Error(`Base branch ${ref} changed on GitHub. Refresh and try again.`);
		}
	}
}

export async function updateStackBranches(
	repository: StackGitRepository,
	openWorktree: (worktreePath: string) => Promise<Repository | null>,
	remote: string,
	branches: readonly StackBranch[],
	activeNumber: number,
	report: (message: string) => void,
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
	try {
		worktreePath = await repository.createWorktree({
			path: path.join(tmpdir(), `vscode-pr-stack-${generateUuid()}`),
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
				await opened.rebaseAbort();
				throw new Error(`Rebasing #${branch.number} (${branch.head}) caused a conflict or failed: ${error}`);
			}
			rebased.set(branch.head, (await opened.getCommit('HEAD')).hash);
		}

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
			try {
				await repository.deleteWorktree(worktreePath, { force: true });
			} catch (error) {
				failure = new Error(`${failure ? `${failure.message} ` : ''}Could not remove temporary stack worktree ${worktreePath}: ${error}`);
			}
		}
	}
	if (failure) {
		throw failure;
	}
	return updated;
}
