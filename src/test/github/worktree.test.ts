/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as path from 'path';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { Repository } from '../../api/api';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { checkoutPRInWorktree } from '../../github/worktree';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('checkoutPRInWorktree (direct)', () => {
	const root = path.join(path.sep, 'repos', 'benchmarks');
	const defaultPath = path.join(path.sep, 'repos', 'benchmarks.worktrees', 'pr-2084');
	let sandbox: SinonSandbox;
	let executeCommand: SinonStub;
	let saveDialog: SinonStub;
	let modal: SinonStub;

	beforeEach(() => {
		sandbox = createSandbox();
		executeCommand = sandbox.stub(vscode.commands, 'executeCommand').resolves(undefined);
		saveDialog = sandbox.stub(vscode.window, 'showSaveDialog').resolves(undefined);
		modal = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
	});

	afterEach(() => sandbox.restore());

	function fixture(worktrees: { path: string; ref: string; main: boolean }[], localBranch = false) {
		const createWorktree = sandbox.stub().resolves(defaultPath);
		const fetch = sandbox.stub().resolves();
		const repository = {
			rootUri: vscode.Uri.file(root),
			state: { worktrees: worktrees.map(worktree => ({ ...worktree, name: path.basename(worktree.path), detached: false })) },
			createWorktree, fetch,
			getBranch: localBranch ? sandbox.stub().resolves({}) : sandbox.stub().rejects(new Error('missing')),
		} as unknown as Repository;
		const pr = { number: 2084, head: { ref: 'l2-updated-tasks' }, remote: { remoteName: 'origin' } } as unknown as PullRequestModel;
		const manager = { repository } as unknown as FolderRepositoryManager;
		return { repository, pr, manager, createWorktree, fetch };
	}

	const openedFolders = () => executeCommand.getCalls().filter(call => call.args[0] === 'vscode.openFolder').map(call => [call.args[1].fsPath, call.args[2]]);

	it('creates the worktree in the default location and opens it in a new window without prompting', async () => {
		const { pr, manager, createWorktree, fetch } = fixture([{ path: root, ref: 'refs/heads/main', main: true }]);
		await checkoutPRInWorktree(new MockTelemetry(), manager, pr, undefined, { direct: true });
		sandbox.assert.notCalled(saveDialog);
		sandbox.assert.notCalled(modal);
		sandbox.assert.calledWith(fetch, { remote: 'origin', ref: 'l2-updated-tasks' });
		sandbox.assert.calledWith(createWorktree, { path: defaultPath, commitish: 'origin/l2-updated-tasks', branch: 'l2-updated-tasks' });
		assert.deepStrictEqual(openedFolders(), [[defaultPath, { forceNewWindow: true }]]);
	});

	it('reuses an existing worktree that already has the branch', async () => {
		const existing = path.join(path.sep, 'elsewhere', 'pr');
		const { pr, manager, createWorktree } = fixture([
			{ path: root, ref: 'refs/heads/main', main: true },
			{ path: existing, ref: 'refs/heads/l2-updated-tasks', main: false },
		]);
		await checkoutPRInWorktree(new MockTelemetry(), manager, pr, undefined, { direct: true });
		sandbox.assert.notCalled(createWorktree);
		assert.deepStrictEqual(openedFolders(), [[existing, { forceNewWindow: true }]]);
	});

	it('does not open another window when the branch is checked out in the main worktree', async () => {
		const { pr, manager, createWorktree } = fixture([{ path: root, ref: 'refs/heads/l2-updated-tasks', main: true }]);
		await checkoutPRInWorktree(new MockTelemetry(), manager, pr, undefined, { direct: true });
		sandbox.assert.notCalled(createWorktree);
		assert.deepStrictEqual(openedFolders(), []);
		sandbox.assert.calledOnce(modal);
	});

	it('keeps the original prompts when not direct', async () => {
		const { pr, manager, createWorktree } = fixture([]);
		await checkoutPRInWorktree(new MockTelemetry(), manager, pr, undefined);
		sandbox.assert.calledOnce(saveDialog);
		sandbox.assert.notCalled(createWorktree);
	});
});
