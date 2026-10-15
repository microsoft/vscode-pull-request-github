/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'assert';
import { tmpdir } from 'os';
import * as path from 'path';
import { Uri } from 'vscode';
import { Branch, BranchQuery, Commit, FetchOptions, Ref, Repository, RepositoryState } from '../../api/api';
import { RefType, Status } from '../../api/api1';
import { removeOrphanedStackWorktrees, StackBranch, StackConflictResolver, StackGitRepository, StackUpdateCancelledError, updateStackBranches } from '../../github/updateStackBranches';
import { MockRepository } from '../mocks/mockRepository';

class StackRepository extends MockRepository implements StackGitRepository {
	readonly local = new Map([['D1', 'd1-old'], ['D2', 'd2-old']]);
	readonly remote = new Map([['main', 'main-new'], ['D1', 'd1-old'], ['D2', 'd2-old']]);
	readonly calls: string[] = [];
	readonly upstream = new Map<string, string>();
	failRebase = false;
	/** Number of conflicting commits the next rebase of D1 stops at. */
	conflictingStops = 0;
	failPush?: string;
	switchCheckoutOnPush?: string;
	private head = 'd2-old';
	private readonly isWorktree: boolean;

	constructor(isWorktree = false) {
		super();
		this.isWorktree = isWorktree;
		this.state = {
			HEAD: { type: RefType.Head, name: isWorktree ? undefined : 'D2', commit: this.head },
			remotes: [], submodules: [], worktrees: [],
			rebaseCommit: undefined, mergeChanges: [], indexChanges: [], workingTreeChanges: [],
			onDidChange: () => ({ dispose() { } }),
		} satisfies RepositoryState;
	}

	override async fetch(_remote?: string | FetchOptions, ref?: string): Promise<void> {
		this.calls.push(`fetch ${ref}`);
	}

	override async getBranch(name: string): Promise<Branch> {
		const remote = name.startsWith('refs/remotes/origin/');
		const branch = remote ? name.substring('refs/remotes/origin/'.length) : name;
		const commit = (remote ? this.remote : this.local).get(branch);
		if (!commit) {
			throw new Error(`Missing branch ${name}`);
		}
		return { type: RefType.Head, name: branch, commit };
	}

	override async getBranches(_query: BranchQuery): Promise<Ref[]> {
		return [...this.local].map(([name, commit]) => ({ type: RefType.Head, name, commit }));
	}

	override async getMergeBase(base: string, head: string): Promise<string> {
		if (head === 'HEAD') {
			return this.head.endsWith('-new') ? base : 'main-old';
		}
		return head === 'd1-old' || head === 'd1-new' ? 'main-old' : 'd1-old';
	}

	override async status(): Promise<void> { }

	override async checkout(ref: string): Promise<void> {
		this.head = ref;
		this.state = { ...this.state, HEAD: { type: RefType.Head, commit: ref } };
		this.calls.push(`checkout ${ref}`);
	}

	override async getCommit(_ref: string): Promise<Commit> {
		return { hash: this.head, message: '', parents: [] };
	}

	override async createBranch(name: string, _checkout: boolean, ref: string): Promise<void> {
		this.local.set(name, ref);
		this.calls.push(`create ${name} ${ref}`);
	}

	override async setBranchUpstream(name: string, upstream: string): Promise<void> {
		this.upstream.set(name, upstream);
	}

	async getRemoteRefs(): Promise<Ref[]> {
		return [...this.remote].map(([name, commit]) => ({ type: RefType.Head, name, commit }));
	}

	readonly createdWorktrees: string[] = [];
	readonly deletedWorktrees: string[] = [];

	async createWorktree(options?: { path?: string }): Promise<string> {
		this.calls.push('create worktree');
		this.createdWorktrees.push(options!.path!);
		return options!.path!;
	}

	async deleteWorktree(worktreePath: string): Promise<void> {
		this.calls.push('delete worktree');
		this.deletedWorktrees.push(worktreePath);
	}

	async rebase(upstream: string, options: { onto?: string; rebaseMerges?: boolean }): Promise<void> {
		this.calls.push(`rebase ${upstream} onto ${options.onto} preserving merges`);
		if (this.failRebase) {
			throw new Error('Conflict');
		}
		if (this.conflictingStops && this.head === 'd1-old') {
			this.stopAtConflict();
			throw new Error('Conflict');
		}
		if (options.onto !== upstream) {
			this.head = this.head === 'd1-old' ? 'd1-new' : 'd2-new';
		}
	}

	private stopAtConflict(): void {
		this.conflictingStops--;
		const conflict = { uri: Uri.file('/worktree/file'), originalUri: Uri.file('/worktree/file'), renameUri: undefined, status: Status.BOTH_MODIFIED };
		this.state = {
			...this.state,
			rebaseCommit: { hash: `stop-${this.conflictingStops}`, message: 'D1 commit', parents: [] },
			mergeChanges: [conflict],
		};
	}

	async rebaseContinue(): Promise<void> {
		this.calls.push('continue rebase');
		if (this.conflictingStops) {
			this.stopAtConflict();
			throw new Error('Conflict');
		}
		this.head = 'd1-new';
		this.state = { ...this.state, rebaseCommit: undefined, mergeChanges: [] };
	}

	async rebaseAbort(): Promise<void> {
		this.calls.push('abort rebase');
		this.state = { ...this.state, rebaseCommit: undefined, mergeChanges: [] };
	}

	async pushRefWithLease(_remote: string, branch: string, newSha: string, expectedSha: string): Promise<void> {
		this.calls.push(`push ${branch} ${newSha} if ${expectedSha}`);
		if (branch === this.failPush) {
			throw new Error('Stale remote branch');
		}
		assert.equal(this.remote.get(branch), expectedSha);
		this.remote.set(branch, newSha);
		if (branch === this.switchCheckoutOnPush) {
			this.state = { ...this.state, HEAD: { type: RefType.Head, name: 'main', commit: 'main-new' } };
		}
	}

	async updateRef(ref: string, newSha: string, expectedSha: string): Promise<void> {
		const branch = ref.replace(/^refs\/heads\//, '');
		assert.equal(this.local.get(branch) ?? '0'.repeat(40), expectedSha);
		this.local.set(branch, newSha);
		this.calls.push(`local ${branch} ${newSha}`);
	}

	async resetKeep(ref: string): Promise<void> {
		this.local.set(this.state.HEAD!.name!, ref);
		this.state = { ...this.state, HEAD: { ...this.state.HEAD!, commit: ref } };
		this.calls.push(`reset-keep ${ref}`);
	}
}

describe('Update pull request stack branches', function () {
	let repository: StackRepository;
	let temporary: StackRepository;
	const branches: StackBranch[] = [
		{ number: 1, base: 'main', head: 'D1', sha: 'd1-old' },
		{ number: 2, base: 'D1', head: 'D2', sha: 'd2-old' },
	];
	const open = async (_path: string): Promise<Repository> => temporary;
	const update = () => updateStackBranches(repository, open, 'origin', branches, 2, () => undefined);

	beforeEach(function () {
		repository = new StackRepository();
		temporary = new StackRepository(true);
	});

	it('rebases bottom-to-top and updates both the remote and local branches', async function () {
		const result = await update();
		assert.deepEqual(result, [1, 2]);
		assert.deepEqual({
			local: [...repository.local], remote: [...repository.remote],
			operations: repository.calls.filter(call => call.startsWith('push') || call.startsWith('reset-keep')),
			rebases: temporary.calls.filter(call => call.startsWith('rebase')),
		}, {
			local: [['D1', 'd1-new'], ['D2', 'd2-new']],
			remote: [['main', 'main-new'], ['D1', 'd1-new'], ['D2', 'd2-new']],
			operations: ['push D1 d1-new if d1-old', 'push D2 d2-new if d2-old', 'reset-keep d2-new'],
			rebases: ['rebase main-old onto main-new preserving merges', 'rebase d1-old onto d1-new preserving merges'],
		});
	});

	it('creates a missing local branch after its remote has been pushed', async function () {
		repository.local.delete('D1');
		await update();
		assert.equal(repository.local.get('D1'), 'd1-new');
		assert.equal(repository.upstream.get('D1'), 'refs/remotes/origin/D1');
	});

	it('does not push unchanged branches when the stack is already current', async function () {
		repository.remote.set('main', 'main-old');
		const updated = await update();
		assert.deepEqual(updated, []);
		assert.equal(repository.calls.some(call => call.startsWith('push')), false);
		assert.deepEqual([...repository.local], [['D1', 'd1-old'], ['D2', 'd2-old']]);
	});

	it('starts at the first outdated PR and does not rewrite its current parent', async function () {
		repository.remote.set('main', 'main-old');
		repository.remote.set('D1', 'd1-new');
		repository.local.set('D1', 'd1-new');
		const changedParent: StackBranch[] = [{ ...branches[0], sha: 'd1-new' }, branches[1]];

		const updated = await updateStackBranches(repository, open, 'origin', changedParent, 2, () => undefined);

		assert.deepEqual(updated, [2]);
		assert.deepEqual({
			rebases: temporary.calls.filter(call => call.startsWith('rebase')),
			pushes: repository.calls.filter(call => call.startsWith('push')),
			local: [...repository.local],
		}, {
			rebases: ['rebase d1-old onto d1-new preserving merges'],
			pushes: ['push D2 d2-new if d2-old'],
			local: [['D1', 'd1-new'], ['D2', 'd2-new']],
		});
	});

	it('refuses divergent local commits before pushing', async function () {
		repository.local.set('D1', 'unpublished');
		await assert.rejects(update(), /Local branch D1 differs/);
		assert.deepEqual([...repository.remote], [['main', 'main-new'], ['D1', 'd1-old'], ['D2', 'd2-old']]);
	});

	it('refuses dirty work before pushing', async function () {
		repository.state.workingTreeChanges.push({
			uri: Uri.file('/root/file'), originalUri: Uri.file('/root/file'),
			renameUri: undefined, status: Status.MODIFIED,
		});
		await assert.rejects(update(), /Commit or stash/);
		assert.equal(repository.calls.some(call => call.startsWith('push')), false);
	});

	it('aborts a conflicting preflight without pushing', async function () {
		temporary.failRebase = true;
		await assert.rejects(update(), /caused a conflict/);
		assert.deepEqual(temporary.calls.filter(call => call.includes('rebase')), [
			'rebase main-old onto main-new preserving merges', 'abort rebase',
		]);
		assert(repository.calls.includes('delete worktree'));
		assert.equal(repository.calls.some(call => call.startsWith('push')), false);
	});

	describe('conflict resolution', function () {
		const resolved: number[] = [];
		const continueRebase: StackConflictResolver = async (worktree, branch) => {
			resolved.push(branch.number);
			try {
				await worktree.rebaseContinue!();
			} catch {
				// Continuing stopped at the next conflicting commit.
			}
			return true;
		};
		const updateResolving = (resolveConflicts: StackConflictResolver) =>
			updateStackBranches(repository, open, 'origin', branches, 2, () => undefined, resolveConflicts);

		beforeEach(function () {
			resolved.length = 0;
		});

		it('pauses on a conflict, lets the user resolve it, and pushes only after the stack is rebased', async function () {
			temporary.conflictingStops = 1;
			let pushesWhileResolving: string[] | undefined;
			const updated = await updateResolving(async (worktree, branch) => {
				pushesWhileResolving = repository.calls.filter(call => call.startsWith('push'));
				return continueRebase(worktree, branch);
			});

			assert.deepEqual({
				updated, resolved, pushesWhileResolving,
				local: [...repository.local], remote: [...repository.remote],
				rebases: temporary.calls.filter(call => call.includes('rebase')),
			}, {
				updated: [1, 2], resolved: [1], pushesWhileResolving: [],
				local: [['D1', 'd1-new'], ['D2', 'd2-new']],
				remote: [['main', 'main-new'], ['D1', 'd1-new'], ['D2', 'd2-new']],
				rebases: ['rebase main-old onto main-new preserving merges', 'continue rebase', 'rebase d1-old onto d1-new preserving merges'],
			});
		});

		it('guides the user through every conflicting commit of a branch', async function () {
			temporary.conflictingStops = 2;
			const updated = await updateResolving(continueRebase);
			assert.deepEqual({ updated, resolved }, { updated: [1, 2], resolved: [1, 1] });
		});

		it('aborts the rebase and pushes nothing when the user cancels', async function () {
			temporary.conflictingStops = 1;
			await assert.rejects(updateResolving(async () => false), StackUpdateCancelledError);
			assert.deepEqual({
				rebases: temporary.calls.filter(call => call.includes('rebase')),
				removedWorktree: repository.calls.includes('delete worktree'),
				pushed: repository.calls.some(call => call.startsWith('push')),
				local: [...repository.local],
			}, {
				rebases: ['rebase main-old onto main-new preserving merges', 'abort rebase'],
				removedWorktree: true, pushed: false,
				local: [['D1', 'd1-old'], ['D2', 'd2-old']],
			});
		});

		it('does not abort again when the guide already aborted the rebase', async function () {
			temporary.conflictingStops = 1;
			await assert.rejects(updateResolving(async worktree => {
				await worktree.rebaseAbort!();
				return false;
			}), StackUpdateCancelledError);
			assert.deepEqual(temporary.calls.filter(call => call === 'abort rebase'), ['abort rebase']);
		});

		it('treats a rebase aborted from Source Control as cancelled', async function () {
			temporary.conflictingStops = 1;
			await assert.rejects(updateResolving(async worktree => {
				await worktree.rebaseAbort!();
				return true;
			}), StackUpdateCancelledError);
			assert.equal(repository.calls.some(call => call.startsWith('push')), false);
		});

		it('aborts when the rebase stops without conflicts to resolve', async function () {
			temporary.conflictingStops = 1;
			await assert.rejects(updateResolving(async worktree => {
				Object.assign(worktree.state, { mergeChanges: [], rebaseCommit: { hash: 'other-stop', message: '', parents: [] } });
				return true;
			}), /stopped without conflicts/);
			assert.deepEqual(resolved, []);
			assert(temporary.calls.includes('abort rebase'));
			assert.equal(repository.calls.some(call => call.startsWith('push')), false);
		});

		it('aborts on conflict when the Git extension cannot continue a rebase', async function () {
			temporary.conflictingStops = 1;
			Object.assign(temporary, { rebaseContinue: undefined });
			await assert.rejects(updateResolving(continueRebase), /caused a conflict/);
			assert.deepEqual(resolved, []);
			assert(temporary.calls.includes('abort rebase'));
		});
	});

	describe('orphaned temporary worktrees', function () {
		const temporaryWorktree = (name: string, directory = tmpdir()) => ({
			// Git reports worktree paths with forward slashes on Windows.
			name, path: path.join(directory, name).replace(/\\/g, '/'), ref: '', main: false, detached: true,
		});
		const orphanFromThisProcess = temporaryWorktree(`vscode-pr-stack-${process.pid}-1d6c4b1e-8a64-4c1e-9d8e-2f6a0c7b3e51`);

		it('removes leftovers from an earlier update before updating the stack', async function () {
			repository.state.worktrees!.push(orphanFromThisProcess);
			await update();
			assert.deepEqual(repository.deletedWorktrees, [orphanFromThisProcess.path, repository.createdWorktrees[0]]);
			assert.match(path.basename(repository.createdWorktrees[0]), new RegExp(`^vscode-pr-stack-${process.pid}-`));
		});

		it('only removes stack worktrees whose owning process has exited', async function () {
			const exited = temporaryWorktree('vscode-pr-stack-111-0b9f2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f');
			repository.state.worktrees!.push(
				{ ...temporaryWorktree('main-checkout'), main: true },
				exited,
				temporaryWorktree('vscode-pr-stack-222-5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b'),
				temporaryWorktree('vscode-pr-stack-333-7c6b5a4f-3e2d-4c1b-9a0f-8e7d6c5b4a3f', path.join(tmpdir(), 'nested')),
				temporaryWorktree('vscode-pr-stack-legacy-without-owner'),
				temporaryWorktree('my-feature-worktree'),
			);
			const running = new Set([222]);
			await removeOrphanedStackWorktrees(repository, pid => running.has(pid));
			assert.deepEqual(repository.deletedWorktrees, [exited.path]);
		});

		it('keeps the worktree of an update that is waiting for conflicts to be resolved', async function () {
			temporary.conflictingStops = 1;
			let deletedWhileResolving: string[] | undefined;
			await updateStackBranches(repository, open, 'origin', branches, 2, () => undefined, async worktree => {
				repository.state.worktrees!.push(temporaryWorktree(path.basename(repository.createdWorktrees[0])));
				await removeOrphanedStackWorktrees(repository);
				deletedWhileResolving = [...repository.deletedWorktrees];
				await worktree.rebaseContinue!();
				return true;
			});
			assert.deepEqual(deletedWhileResolving, []);
		});

		it('still updates the stack when a leftover cannot be removed', async function () {
			repository.state.worktrees!.push(orphanFromThisProcess);
			const deleteWorktree = repository.deleteWorktree.bind(repository);
			repository.deleteWorktree = async worktreePath => {
				if (worktreePath === orphanFromThisProcess.path) {
					throw new Error('Permission denied');
				}
				return deleteWorktree(worktreePath);
			};
			assert.deepEqual(await update(), [1, 2]);
		});
	});

	it('cleans up when the Git extension cannot open the temporary worktree', async function () {
		await assert.rejects(
			updateStackBranches(repository, async () => null, 'origin', branches, 2, () => undefined),
			/could not open the temporary stack worktree/,
		);
		assert(repository.calls.includes('delete worktree'));
		assert.equal(repository.calls.some(call => call.startsWith('push')), false);
	});

	it('refuses to rewrite a branch checked out in a different worktree', async function () {
		repository.state.worktrees?.push({ name: 'other', path: '/another', ref: 'refs/heads/D1', main: false, detached: false });
		await assert.rejects(update(), /another worktree/);
		assert.equal(repository.calls.some(call => call.startsWith('push')), false);
	});

	it('reports partial success while keeping pushed and local branches synchronized', async function () {
		repository.failPush = 'D2';
		await assert.rejects(update(), /already updated: #1/);
		assert.deepEqual({
			remote: [...repository.remote], local: [...repository.local],
		}, {
			remote: [['main', 'main-new'], ['D1', 'd1-new'], ['D2', 'd2-old']],
			local: [['D1', 'd1-new'], ['D2', 'd2-old']],
		});
	});

	it('never resets a different checkout when the branch changes during a push', async function () {
		repository.switchCheckoutOnPush = 'D2';
		await assert.rejects(update(), /#2 was pushed.*local branch D2 could not be updated/);
		assert.deepEqual({
			head: repository.state.HEAD,
			local: [...repository.local],
			remote: [...repository.remote],
		}, {
			head: { type: RefType.Head, name: 'main', commit: 'main-new' },
			local: [['D1', 'd1-new'], ['D2', 'd2-old']],
			remote: [['main', 'main-new'], ['D1', 'd1-new'], ['D2', 'd2-new']],
		});
	});
});
