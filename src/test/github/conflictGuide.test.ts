/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'assert';
import { SinonSandbox, SinonStub, createSandbox } from 'sinon';
import * as vscode from 'vscode';
import { Change, Repository } from '../../api/api';
import { RefType, Status } from '../../api/api1';
import { ConflictModel, guideRebaseConflicts } from '../../github/conflictGuide';

const conflict: Change = {
	uri: vscode.Uri.file('/worktree/file.txt'), originalUri: vscode.Uri.file('/worktree/file.txt'),
	renameUri: undefined, status: Status.BOTH_MODIFIED,
};

class ConflictedRepository {
	readonly calls: string[] = [];
	readonly inputBox = { value: '' };
	private readonly changed = new vscode.EventEmitter<void>();
	readonly state = {
		HEAD: { type: RefType.Head, name: 'feature', commit: 'before' },
		remotes: [], submodules: [], worktrees: [],
		rebaseCommit: { hash: 'stop-1', message: 'Feature', parents: [] } as { hash: string; message: string; parents: string[] } | undefined,
		mergeChanges: [conflict], indexChanges: [] as Change[], workingTreeChanges: [] as Change[],
		onDidChange: this.changed.event,
	};
	continueRebase: () => void = () => this.update({ rebaseCommit: undefined });

	update(state: Partial<ConflictedRepository['state']>): void {
		Object.assign(this.state, state);
		this.changed.fire();
	}

	async status(): Promise<void> { }

	async rebaseContinue(): Promise<void> {
		this.calls.push('continue rebase');
		this.continueRebase();
	}

	async rebaseAbort(): Promise<void> {
		this.calls.push('abort rebase');
		this.update({ rebaseCommit: undefined, mergeChanges: [] });
	}

	async commit(message: string): Promise<void> {
		this.calls.push(`commit ${message}`);
		this.update({ HEAD: { ...this.state.HEAD, commit: 'after' } });
	}

	async mergeAbort(): Promise<void> {
		this.calls.push('abort merge');
		this.update({ mergeChanges: [] });
	}

	async push(): Promise<void> {
		this.calls.push('push');
	}

	get api(): Repository {
		return this as unknown as Repository;
	}
}

describe('Conflict guide', function () {
	let sinon: SinonSandbox;
	let repository: ConflictedRepository;
	let cancellation: vscode.CancellationTokenSource;
	let showInformationMessage: SinonStub;
	let showErrorMessage: SinonStub;
	let executeCommand: SinonStub;
	let progressMessages: (string | undefined)[];

	beforeEach(function () {
		sinon = createSandbox();
		repository = new ConflictedRepository();
		cancellation = new vscode.CancellationTokenSource();
		progressMessages = [];
		sinon.stub(vscode.window, 'withProgress').callsFake((_options, task) =>
			task({ report: ({ message }: { message?: string }) => progressMessages.push(message) }, cancellation.token));
		showInformationMessage = sinon.stub(vscode.window, 'showInformationMessage');
		showErrorMessage = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
		executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves(undefined);
	});

	afterEach(function () {
		cancellation.dispose();
		sinon.restore();
	});

	function resolveAllConflicts(): void {
		repository.update({ mergeChanges: [] });
	}

	describe('rebase', function () {
		it('opens the conflicts, continues the rebase once they are resolved, and finishes when the rebase moves on', async function () {
			showInformationMessage.resolves('Continue Rebase');
			const finished = guideRebaseConflicts(repository.api);
			await new Promise<void>(resolve => setImmediate(resolve));
			resolveAllConflicts();

			assert.equal(await finished, true);
			assert.deepEqual(repository.calls, ['continue rebase']);
			assert(executeCommand.calledWith('git.openMergeEditor', conflict.uri));
			assert.equal(repository.inputBox.value, '', 'the rebase keeps the commit message chosen by Git');
		});

		it('names what the rebase is updating in its notifications', async function () {
			showInformationMessage.resolves('Continue Rebase');
			const finished = guideRebaseConflicts(repository.api, '#793 (alexr00/D1)');
			resolveAllConflicts();

			assert.equal(await finished, true);
			assert.deepEqual({
				progress: progressMessages,
				prompt: showInformationMessage.firstCall.args,
			}, {
				progress: [
					'Resolve the conflicts in #793 (alexr00/D1) using the Source Control view, 1 of 1 remaining',
					'Resolve the conflicts in #793 (alexr00/D1) using the Source Control view, 0 of 1 remaining',
				],
				prompt: ['All conflicts in #793 (alexr00/D1) resolved. Continue the rebase to proceed.', 'Continue Rebase', 'Abort Rebase'],
			});
		});

		it('hands off to the next stop without reporting an error when continuing hits another conflict', async function () {
			showInformationMessage.resolves('Continue Rebase');
			repository.continueRebase = () => {
				repository.update({ rebaseCommit: { hash: 'stop-2', message: 'Next', parents: [] }, mergeChanges: [conflict] });
				throw new Error('Conflict');
			};
			const finished = guideRebaseConflicts(repository.api);
			resolveAllConflicts();

			assert.equal(await finished, true);
			assert(showErrorMessage.notCalled);
		});

		it('reports a failure to continue and keeps waiting at the same stop', async function () {
			showInformationMessage.resolves('Continue Rebase');
			const errorShown = new Promise<void>(resolve => showErrorMessage.callsFake(async () => resolve()));
			repository.continueRebase = () => {
				throw new Error('nothing to commit');
			};
			let settled = false;
			const finished = guideRebaseConflicts(repository.api).finally(() => {
				settled = true;
			});
			resolveAllConflicts();
			await errorShown;
			assert.equal(settled, false);

			repository.update({ rebaseCommit: undefined });
			assert.equal(await finished, true);
			assert.match(showErrorMessage.firstCall.args[0], /Unable to continue the rebase: .*nothing to commit/);
		});

		it('aborts the rebase when the conflict notification is cancelled', async function () {
			const finished = guideRebaseConflicts(repository.api);
			cancellation.cancel();

			assert.equal(await finished, false);
			assert.deepEqual(repository.calls, ['abort rebase']);
		});

		it('aborts the rebase when the user chooses to abort after resolving', async function () {
			showInformationMessage.resolves('Abort Rebase');
			const finished = guideRebaseConflicts(repository.api);
			resolveAllConflicts();

			assert.equal(await finished, false);
			assert.deepEqual(repository.calls, ['abort rebase']);
		});

		it('does not act on a stale prompt after the rebase was continued from Source Control', async function () {
			let answer!: (choice: string) => void;
			showInformationMessage.returns(new Promise(resolve => {
				answer = resolve;
			}));
			const finished = guideRebaseConflicts(repository.api);
			resolveAllConflicts();
			await new Promise<void>(resolve => setImmediate(resolve));
			repository.update({ rebaseCommit: undefined });
			assert.equal(await finished, true);

			answer('Continue Rebase');
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual(repository.calls, []);
		});
	});

	describe('merge', function () {
		it('still commits and pushes the merge resolution', async function () {
			repository.state.rebaseCommit = undefined;
			showInformationMessage.resolves('Commit');
			const model = await ConflictModel.begin(repository.api, 'main', 'feature', true);
			assert(model);
			assert.equal(repository.inputBox.value, `Merge branch 'main' into feature`);
			const finished = model.finished();
			resolveAllConflicts();

			assert.equal(await finished, true);
			assert.deepEqual(repository.calls, [`commit Merge branch 'main' into feature`, 'push']);
			model.dispose();
		});
	});
});
