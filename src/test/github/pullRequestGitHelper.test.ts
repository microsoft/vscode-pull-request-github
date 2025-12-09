/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';

import { MockRepository } from '../mocks/mockRepository';
import { PullRequestGitHelper } from '../../github/pullRequestGitHelper';
import { PullRequestModel } from '../../github/pullRequestModel';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { GitHubRemote, Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { CredentialStore } from '../../github/credentials';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { SinonSandbox, createSandbox } from 'sinon';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { RefType } from '../../api/api1';
import { RepositoryBuilder } from '../builders/rest/repoBuilder';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { GitHubServerType } from '../../common/authentication';

describe('PullRequestGitHelper', function () {
	let sinon: SinonSandbox;
	let repository: MockRepository;
	let telemetry: MockTelemetry;
	let credentialStore: CredentialStore;
	let context: MockExtensionContext;

	beforeEach(function () {
		sinon = createSandbox();

		MockCommandRegistry.install(sinon);

		repository = new MockRepository();
		telemetry = new MockTelemetry();
		context = new MockExtensionContext();
		credentialStore = new CredentialStore(telemetry, context);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('fetchAndCheckout', function () {
		it('creates a unique branch when local branch exists with different commit to preserve user work', async function () {
			const url = 'git@github.com:owner/name.git';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const gitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);

			const prItem = convertRESTPullRequestToRawPullRequest(
				new PullRequestBuilder()
					.number(100)
					.user(u => u.login('me'))
					.base(b => {
						(b.repo)(r => (<RepositoryBuilder>r).clone_url('git@github.com:owner/name.git'));
					})
					.head(h => {
						h.repo(r => (<RepositoryBuilder>r).clone_url('git@github.com:owner/name.git'));
						h.ref('my-branch');
					})
					.build(),
				gitHubRepository,
			);

			const pullRequest = new PullRequestModel(credentialStore, telemetry, gitHubRepository, remote, prItem);

			// Setup: local branch exists with different commit than remote
			await repository.createBranch('my-branch', false, 'local-commit-hash');

			// Setup: remote branch has different commit
			await repository.createBranch('refs/remotes/origin/my-branch', false, 'remote-commit-hash');

			const remotes = [remote];

			// Expect fetch to be called
			repository.expectFetch('origin', 'my-branch');

			await PullRequestGitHelper.fetchAndCheckout(repository, remotes, pullRequest, { report: () => undefined });

			// Verify that the original local branch is preserved
			const originalBranch = await repository.getBranch('my-branch');
			assert.strictEqual(originalBranch.commit, 'local-commit-hash', 'Original branch should be preserved');

			// Verify that a unique branch was created with the correct commit
			const uniqueBranch = await repository.getBranch('pr/me/100');
			assert.strictEqual(uniqueBranch.commit, 'remote-commit-hash', 'Unique branch should have remote commit');
			assert.strictEqual(repository.state.HEAD?.name, 'pr/me/100', 'Should check out the unique branch');
		});

		it('creates a unique branch even when currently checked out on conflicting local branch', async function () {
			const url = 'git@github.com:owner/name.git';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const gitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);

			const prItem = convertRESTPullRequestToRawPullRequest(
				new PullRequestBuilder()
					.number(100)
					.user(u => u.login('me'))
					.base(b => {
						(b.repo)(r => (<RepositoryBuilder>r).clone_url('git@github.com:owner/name.git'));
					})
					.head(h => {
						h.repo(r => (<RepositoryBuilder>r).clone_url('git@github.com:owner/name.git'));
						h.ref('my-branch');
					})
					.build(),
				gitHubRepository,
			);

			const pullRequest = new PullRequestModel(credentialStore, telemetry, gitHubRepository, remote, prItem);

			// Setup: local branch exists with different commit than remote AND is currently checked out
			await repository.createBranch('my-branch', true, 'local-commit-hash'); // checkout = true

			// Setup: remote branch has different commit
			await repository.createBranch('refs/remotes/origin/my-branch', false, 'remote-commit-hash');

			const remotes = [remote];

			// Expect fetch to be called
			repository.expectFetch('origin', 'my-branch');

			await PullRequestGitHelper.fetchAndCheckout(repository, remotes, pullRequest, { report: () => undefined });

			// Verify that the original local branch is preserved with its commit
			const originalBranch = await repository.getBranch('my-branch');
			assert.strictEqual(originalBranch.commit, 'local-commit-hash', 'Original branch should be preserved');

			// Verify that a unique branch was created and checked out
			const uniqueBranch = await repository.getBranch('pr/me/100');
			assert.strictEqual(uniqueBranch.commit, 'remote-commit-hash', 'Unique branch should have remote commit');
			assert.strictEqual(repository.state.HEAD?.name, 'pr/me/100', 'Should check out the unique branch');
		});
	});

	describe('checkoutFromFork', function () {
		it('fetches, checks out, and configures a branch from a fork', async function () {
			const url = 'git@github.com:owner/name.git';
			const remote = new GitHubRemote('elsewhere', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const gitHubRepository = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);

			const prItem = convertRESTPullRequestToRawPullRequest(
				new PullRequestBuilder()
					.number(100)
					.user(u => u.login('me'))
					.base(b => {
						(b.repo)(r => (<RepositoryBuilder>r).clone_url('git@github.com:owner/name.git'));
					})
					.head(h => {
						h.repo(r => (<RepositoryBuilder>r).clone_url('git@github.com:you/name.git'));
						h.ref('my-branch');
					})
					.build(),
				gitHubRepository,
			);

			// Setup: Create remote tracking branch that will be created by fetch
			await repository.createBranch('refs/remotes/you/my-branch', false, 'remote-commit-hash');

			repository.expectFetch('you', 'my-branch');

			const pullRequest = new PullRequestModel(credentialStore, telemetry, gitHubRepository, remote, prItem);

			if (!pullRequest.isResolved()) {
				assert(false, 'pull request head not resolved successfully');
			}

			await PullRequestGitHelper.checkoutFromFork(repository, pullRequest, undefined, { report: () => undefined });

			assert.deepStrictEqual(repository.state.remotes, [
				{
					name: 'you',
					fetchUrl: 'git@github.com:you/name',
					pushUrl: 'git@github.com:you/name',
					isReadOnly: false,
				},
			]);
			assert.deepStrictEqual(repository.state.HEAD, {
				type: RefType.Head,
				name: 'pr/me/100',
				commit: 'remote-commit-hash',
				upstream: {
					remote: 'you',
					name: 'my-branch',
				},
			});
			assert.strictEqual(await repository.getConfig('branch.pr/me/100.github-pr-owner-number'), 'owner#name#100');
		});
	});
});
