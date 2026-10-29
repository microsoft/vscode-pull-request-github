/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { Repository } from '../../api/api';
import { GitHubServerType } from '../../common/authentication';
import Logger from '../../common/logger';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { CredentialStore } from '../../github/credentials';
import { PullRequestModel } from '../../github/pullRequestModel';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { checkoutPRInWorktree } from '../../github/worktree';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { RepositoryBuilder } from '../builders/rest/repoBuilder';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('checkoutPRInWorktree', () => {
	let sandbox: SinonSandbox;
	let telemetry: MockTelemetry;
	let context: MockExtensionContext;
	let credentialStore: CredentialStore;
	let gitHubRepository: MockGitHubRepository;
	let repository: MockRepository & Pick<Repository, 'createWorktree'>;
	let cancellation: vscode.CancellationTokenSource;
	let fetch: SinonStub;
	let createWorktree: SinonStub;
	let showSaveDialog: SinonStub;
	let showError: SinonStub;
	let logError: SinonStub;
	const worktreeUri = vscode.Uri.file('/worktrees/pr-42');
	const baseUrl = 'git@github.com:upstream/repo.git';
	const forkUrl = 'https://github.com/contributor/repo.git';
	const baseRemote = new GitHubRemote('origin', baseUrl, new Protocol(baseUrl), GitHubServerType.GitHubDotCom);

	beforeEach(async () => {
		sandbox = createSandbox();
		MockCommandRegistry.install(sandbox);
		telemetry = new MockTelemetry();
		context = new MockExtensionContext();
		credentialStore = new CredentialStore(telemetry, context);
		gitHubRepository = new MockGitHubRepository(baseRemote, credentialStore, telemetry, sandbox);
		cancellation = new vscode.CancellationTokenSource();
		createWorktree = sandbox.stub().resolves();
		repository = Object.assign(new MockRepository(), { createWorktree });
		await repository.addRemote('origin', baseUrl);
		fetch = sandbox.stub(repository, 'fetch').resolves();
		showSaveDialog = sandbox.stub(vscode.window, 'showSaveDialog').resolves(worktreeUri);
		sandbox.stub(vscode.window, 'withProgress').callsFake((_options, task) =>
			task({ report: () => undefined }, cancellation.token));
		sandbox.stub(vscode.window, 'showInformationMessage').resolves();
		showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves();
		logError = sandbox.stub(Logger, 'error');
	});

	afterEach(() => {
		cancellation.dispose();
		gitHubRepository.dispose();
		credentialStore.dispose();
		context.dispose();
		sandbox.restore();
	});

	function createPullRequest(headRef = 'feature', headCloneUrl = forkUrl): PullRequestModel {
		const item = convertRESTPullRequestToRawPullRequest(
			new PullRequestBuilder()
				.number(42)
				.user(u => u.login('contributor'))
				.base(b => b.repo((r: RepositoryBuilder) => r.clone_url(baseUrl)))
				.head(h => h.ref(headRef).repo((r: RepositoryBuilder) => r.clone_url(headCloneUrl)))
				.build(),
			gitHubRepository,
		);
		return new PullRequestModel(credentialStore, telemetry, gitHubRepository, baseRemote, item);
	}

	async function checkout(pullRequest: PullRequestModel = createPullRequest()) {
		await checkoutPRInWorktree(telemetry, repository, pullRequest);
	}

	function getAssociatedPullRequest(branchName: string): Promise<string> {
		return repository.getConfig(`branch.${branchName}.github-pr-owner-number`);
	}

	it('creates a fork remote using the base protocol and checks out its branch', async () => {
		await checkout();

		assert.ok(fetch.calledOnceWithExactly({ remote: 'contributor', ref: '+refs/heads/feature:refs/remotes/contributor/feature' }));
		assert.strictEqual(repository.state.remotes[1].fetchUrl, 'git@github.com:contributor/repo');
		assert.strictEqual(await repository.getConfig('remote.contributor.github-pr-remote'), 'true');
		assert.ok(createWorktree.calledOnceWithExactly({
			path: worktreeUri.fsPath,
			commitish: 'contributor/feature',
			branch: 'pr/contributor/42',
		}));
		assert.strictEqual(await getAssociatedPullRequest('pr/contributor/42'), 'upstream#repo#42');
		assert.ok(showError.notCalled);
	});

	it('reuses an existing fork remote regardless of its name or protocol', async () => {
		await repository.addRemote('existing-fork', 'git@github.com:contributor/repo.git');
		const addRemote = sandbox.spy(repository, 'addRemote');

		await checkout();

		assert.ok(addRemote.notCalled);
		// The explicit destination creates the start point even if the reused remote's refspec doesn't cover the branch
		assert.ok(fetch.calledOnceWithExactly({ remote: 'existing-fork', ref: '+refs/heads/feature:refs/remotes/existing-fork/feature' }));
		assert.strictEqual(createWorktree.firstCall.args[0].commitish, 'existing-fork/feature');
		assert.ok(showError.notCalled);
	});

	it('avoids conflicting remote names', async () => {
		await repository.addRemote('contributor', 'https://github.com/someone-else/repo.git');

		await checkout();

		assert.ok(fetch.calledOnceWithExactly({ remote: 'contributor1', ref: '+refs/heads/feature:refs/remotes/contributor1/feature' }));
		assert.strictEqual(createWorktree.firstCall.args[0].commitish, 'contributor1/feature');
		assert.ok(showError.notCalled);
	});

	it('does not reuse a local main branch for a fork PR from main', async () => {
		await repository.createBranch('main', true, 'upstream-commit');
		await repository.createBranch('pr/contributor/42', false, 'existing-pr-commit');
		const originalHead = repository.state.HEAD;

		await checkout(createPullRequest('main'));

		assert.ok(fetch.calledOnceWithExactly({ remote: 'contributor', ref: '+refs/heads/main:refs/remotes/contributor/main' }));
		assert.ok(createWorktree.calledOnceWithExactly({
			path: worktreeUri.fsPath,
			commitish: 'contributor/main',
			branch: 'pr/contributor/42-1',
		}));
		assert.strictEqual(repository.state.HEAD, originalHead);
		assert.strictEqual((await repository.getBranch('main')).commit, 'upstream-commit');
		assert.strictEqual(await getAssociatedPullRequest('pr/contributor/42-1'), 'upstream#repo#42');
		assert.strictEqual(await getAssociatedPullRequest('main'), '');
		assert.ok(showError.notCalled);
	});

	it('preserves same-repository checkout behavior for a new branch', async () => {
		const addRemote = sandbox.spy(repository, 'addRemote');

		await checkout(createPullRequest('feature', 'https://github.com/upstream/repo.git'));

		assert.ok(addRemote.notCalled);
		assert.ok(fetch.calledOnceWithExactly({ remote: 'origin', ref: '+refs/heads/feature:refs/remotes/origin/feature' }));
		assert.ok(createWorktree.calledOnceWithExactly({
			path: worktreeUri.fsPath,
			commitish: 'origin/feature',
			branch: 'feature',
		}));
		assert.strictEqual(await getAssociatedPullRequest('feature'), 'upstream#repo#42');
		assert.ok(showError.notCalled);
	});

	it('preserves same-repository checkout behavior for an existing branch', async () => {
		await repository.createBranch('feature', false, 'local-commit');

		await checkout(createPullRequest('feature', baseUrl));

		assert.ok(createWorktree.calledOnceWithExactly({
			path: worktreeUri.fsPath,
			commitish: 'feature',
		}));
		assert.strictEqual(await getAssociatedPullRequest('feature'), 'upstream#repo#42');
		assert.ok(showError.notCalled);
	});

	it('does not create a remote or fetch when the location dialog is cancelled', async () => {
		showSaveDialog.resolves(undefined);
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
			assert.ok(logError.calledOnceWithExactly(
				'Failed to create worktree: fatal: could not read from remote repository', 'Worktree'));
			assert.ok(createWorktree.notCalled);
		});
	}

	it('shows only Git error lines and logs the full Git output', async () => {
		const stderr = 'Preparing worktree (new branch \'pr/contributor/42\')\nfatal: \'/worktrees/pr-42\' already exists\n';
		createWorktree.rejects(Object.assign(new Error('Failed to execute git'), { stderr }));

		await checkout();

		assert.ok(showError.calledOnceWithExactly('Failed to create worktree: fatal: \'/worktrees/pr-42\' already exists'));
		assert.ok(logError.calledOnceWithExactly(`Failed to create worktree: ${stderr.trim()}`, 'Worktree'));
		assert.strictEqual(await getAssociatedPullRequest('pr/contributor/42'), '');
	});

	it('preserves ordinary error messages when Git stderr is empty', async () => {
		createWorktree.rejects(Object.assign(new Error('Worktree path already exists'), { stderr: ' \n' }));

		await checkout();

		assert.ok(showError.calledOnceWithExactly('Failed to create worktree: Worktree path already exists'));
	});
});
