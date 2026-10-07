/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'assert';
import { Uri } from 'vscode';
import { Branch, BranchQuery, Commit, FetchOptions, Ref, Repository, RepositoryState } from '../../api/api';
import { RefType, Status } from '../../api/api1';
import { StackBranch, StackGitRepository, updateStackBranches } from '../../github/updateStackBranches';
import { MockRepository } from '../mocks/mockRepository';

class StackRepository extends MockRepository implements StackGitRepository {
	readonly local = new Map([['D1', 'd1-old'], ['D2', 'd2-old']]);
	readonly remote = new Map([['main', 'main-new'], ['D1', 'd1-old'], ['D2', 'd2-old']]);
	readonly calls: string[] = [];
	readonly upstream = new Map<string, string>();
	failRebase = false;
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

	override async getMergeBase(_base: string, head: string): Promise<string> {
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

	async createWorktree(): Promise<string> {
		this.calls.push('create worktree');
		return 'temporary-worktree';
	}

	async deleteWorktree(): Promise<void> {
		this.calls.push('delete worktree');
	}

	async rebase(upstream: string, options: { onto?: string; rebaseMerges?: boolean }): Promise<void> {
		this.calls.push(`rebase ${upstream} onto ${options.onto} preserving merges`);
		if (this.failRebase) {
			throw new Error('Conflict');
		}
		if (options.onto !== upstream) {
			this.head = this.head === 'd1-old' ? 'd1-new' : 'd2-new';
		}
	}

	async rebaseAbort(): Promise<void> {
		this.calls.push('abort rebase');
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
