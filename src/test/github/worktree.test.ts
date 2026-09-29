/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { Repository } from '../../api/api';
import Logger from '../../common/logger';
import { Protocol } from '../../common/protocol';
import { Remote } from '../../common/remote';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { IResolvedPullRequestModel, PullRequestModel } from '../../github/pullRequestModel';
import { checkoutPRInWorktree } from '../../github/worktree';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('checkoutPRInWorktree', () => {
	let sandbox: SinonSandbox;
	let repository: MockRepository & Pick<Repository, 'createWorktree'>;
	let pullRequest: PullRequestModel & IResolvedPullRequestModel;
	let cancellation: vscode.CancellationTokenSource;
	let fetch: SinonStub;
	let createWorktree: SinonStub;
	let showError: SinonStub;
	const worktreeUri = vscode.Uri.file('/worktrees/pr-42');
	const baseUrl = 'git@github.com:upstream/repo.git';

	beforeEach(async () => {
		sandbox = createSandbox();
		cancellation = new vscode.CancellationTokenSource();
		createWorktree = sandbox.stub().resolves();
		repository = Object.assign(new MockRepository(), { createWorktree });
		await repository.addRemote('origin', baseUrl);
		pullRequest = {
			number: 42,
			author: { login: 'contributor' },
			head: {
				ref: 'feature',
				repositoryCloneUrl: new Protocol('https://github.com/contributor/repo.git'),
			},
			remote: new Remote('origin', baseUrl, new Protocol(baseUrl)),
		} as PullRequestModel & IResolvedPullRequestModel;
		fetch = sandbox.stub(repository, 'fetch').resolves();
		sandbox.stub(vscode.window, 'showSaveDialog').resolves(worktreeUri);
		sandbox.stub(vscode.window, 'withProgress').callsFake((_options, task) =>
			task({ report: () => undefined }, cancellation.token));
		sandbox.stub(vscode.window, 'showInformationMessage').resolves();
		showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves();
		sandbox.stub(Logger, 'error');
	});

	afterEach(() => {
		cancellation.dispose();
		sandbox.restore();
	});

	async function checkout(repositoryOverride?: Repository) {
		await checkoutPRInWorktree(
			new MockTelemetry(),
			{ repository } as unknown as FolderRepositoryManager,
			pullRequest,
			repositoryOverride,
		);
	}

	it('creates a fork remote using the base protocol and checks out its branch', async () => {
		await checkout();

		assert.ok(fetch.calledOnceWithExactly({ remote: 'contributor', ref: 'feature' }));
		assert.strictEqual(repository.state.remotes[1].fetchUrl, 'git@github.com:contributor/repo.git');
		assert.strictEqual(await repository.getConfig('remote.contributor.github-pr-remote'), 'true');
		assert.ok(createWorktree.calledOnceWithExactly({
			path: worktreeUri.fsPath,
			commitish: 'contributor/feature',
			branch: 'pr/contributor/42',
		}));
		assert.ok(showError.notCalled);
	});

	it('reuses an existing fork remote regardless of its name or protocol', async () => {
		await repository.addRemote('existing-fork', 'git@github.com:contributor/repo.git');
		const addRemote = sandbox.spy(repository, 'addRemote');

		await checkout();

		assert.ok(addRemote.notCalled);
		assert.ok(fetch.calledOnceWithExactly({ remote: 'existing-fork', ref: 'feature' }));
		assert.strictEqual(createWorktree.firstCall.args[0].commitish, 'existing-fork/feature');
		assert.ok(showError.notCalled);
	});

	it('avoids conflicting remote names', async () => {
		await repository.addRemote('contributor', 'https://github.com/someone-else/repo.git');

		await checkout();

		assert.ok(fetch.calledOnceWithExactly({ remote: 'contributor1', ref: 'feature' }));
		assert.strictEqual(createWorktree.firstCall.args[0].commitish, 'contributor1/feature');
		assert.ok(showError.notCalled);
	});

	it('does not reuse a local main branch for a fork PR from main', async () => {
		pullRequest.head.ref = 'main';
		await repository.createBranch('main', true, 'upstream-commit');
		await repository.createBranch('pr/contributor/42', false, 'existing-pr-commit');
		const originalHead = repository.state.HEAD;

		await checkout();

		assert.ok(fetch.calledOnceWithExactly({ remote: 'contributor', ref: 'main' }));
		assert.ok(createWorktree.calledOnceWithExactly({
			path: worktreeUri.fsPath,
			commitish: 'contributor/main',
			branch: 'pr/contributor/42-1',
		}));
		assert.strictEqual(repository.state.HEAD, originalHead);
		assert.strictEqual((await repository.getBranch('main')).commit, 'upstream-commit');
		assert.ok(showError.notCalled);
	});

	it('preserves same-repository checkout behavior for a new branch', async () => {
		pullRequest.head.repositoryCloneUrl = new Protocol('https://github.com/upstream/repo.git');
		const addRemote = sandbox.spy(repository, 'addRemote');

		await checkout();

		assert.ok(addRemote.notCalled);
		assert.ok(fetch.calledOnceWithExactly({ remote: 'origin', ref: 'feature' }));
		assert.ok(createWorktree.calledOnceWithExactly({
			path: worktreeUri.fsPath,
			commitish: 'origin/feature',
			branch: 'feature',
		}));
		assert.ok(showError.notCalled);
	});

	it('preserves same-repository checkout behavior for an existing branch', async () => {
		pullRequest.head.repositoryCloneUrl = new Protocol(baseUrl);
		await repository.createBranch('feature', false, 'local-commit');

		await checkout();

		assert.ok(createWorktree.calledOnceWithExactly({
			path: worktreeUri.fsPath,
			commitish: 'feature',
		}));
		assert.ok(showError.notCalled);
	});

	it('resolves the fork remote in the explicitly supplied repository', async () => {
		const otherCreateWorktree = sandbox.stub().resolves();
		const otherRepository = Object.assign(new MockRepository(), { createWorktree: otherCreateWorktree });
		await otherRepository.addRemote('other-fork', 'https://github.com/contributor/repo.git');
		const otherFetch = sandbox.stub(otherRepository, 'fetch').resolves();

		await checkout(otherRepository);

		assert.ok(otherFetch.calledOnceWithExactly({ remote: 'other-fork', ref: 'feature' }));
		assert.strictEqual(otherCreateWorktree.firstCall.args[0].commitish, 'other-fork/feature');
		assert.ok(fetch.notCalled);
		assert.ok(createWorktree.notCalled);
		assert.ok(showError.notCalled);
	});

	it('does not create a remote or fetch when the location dialog is cancelled', async () => {
		(vscode.window.showSaveDialog as SinonStub).resolves(undefined);
		const addRemote = sandbox.spy(repository, 'addRemote');

		await checkout();

		assert.ok(addRemote.notCalled);
		assert.ok(fetch.notCalled);
		assert.ok(createWorktree.notCalled);
	});

	for (const error of [
		Object.assign(new Error('Failed to execute git'), { stderr: 'fatal: could not read from remote repository\n' }),
		{ message: 'Failed to execute git', stderr: 'fatal: could not read from remote repository\n' },
	]) {
		it(`surfaces Git stderr from ${error instanceof Error ? 'Error instances' : 'plain objects'}`, async () => {
			fetch.callsFake(async () => { throw error; });

			await checkout();

			assert.ok(showError.calledOnceWithExactly('Failed to create worktree: fatal: could not read from remote repository'));
			assert.ok((Logger.error as SinonStub).calledOnceWithExactly(
				'Failed to create worktree: fatal: could not read from remote repository', 'Worktree'));
			assert.ok(createWorktree.notCalled);
		});
	}

	it('preserves ordinary error messages when Git stderr is empty', async () => {
		createWorktree.rejects(Object.assign(new Error('Worktree path already exists'), { stderr: ' \n' }));

		await checkout();

		assert.ok(showError.calledOnceWithExactly('Failed to create worktree: Worktree path already exists'));
	});
});
