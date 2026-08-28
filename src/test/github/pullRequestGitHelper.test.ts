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

		it('checks out and pulls an existing branch that is only behind the PR head', async function () {
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

			await repository.createBranch('my-branch', false, 'local-commit-hash');
			await repository.createBranch('refs/remotes/origin/my-branch', false, 'remote-commit-hash');
			await repository.setBranchUpstream('my-branch', 'refs/remotes/origin/my-branch');
			Object.assign(await repository.getBranch('my-branch'), { ahead: 0, behind: 1 });
			await repository.createBranch('other-branch', true, 'other-commit-hash');

			repository.expectFetch('origin', 'my-branch');
			repository.expectPull();
			const pull = sinon.spy(repository, 'pull');

			await PullRequestGitHelper.fetchAndCheckout(repository, [remote], pullRequest, { report: () => undefined });

			assert.strictEqual(repository.state.HEAD?.name, 'my-branch', 'Should check out the existing branch');
			assert.strictEqual(pull.calledOnce, true, 'Should fast-forward the existing branch');
			await assert.rejects(repository.getBranch('pr/me/100'), 'Should not create a unique branch');
			assert.strictEqual(await repository.getConfig('branch.my-branch.github-pr-owner-number'), 'owner#name#100');
		});

		it('pulls an already checked out branch that is only behind the PR head', async function () {
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

			await repository.createBranch('my-branch', true, 'local-commit-hash');
			await repository.createBranch('refs/remotes/origin/my-branch', false, 'remote-commit-hash');
			await repository.setBranchUpstream('my-branch', 'refs/remotes/origin/my-branch');
			Object.assign(await repository.getBranch('my-branch'), { ahead: 0, behind: 1 });

			repository.expectFetch('origin', 'my-branch');
			repository.expectPull();
			const checkout = sinon.spy(repository, 'checkout');
			const pull = sinon.spy(repository, 'pull');

			await PullRequestGitHelper.fetchAndCheckout(repository, [remote], pullRequest, { report: () => undefined });

			assert.strictEqual(checkout.called, false, 'Should not check out the current branch again');
			assert.strictEqual(pull.calledOnce, true, 'Should fast-forward the current branch');
			await assert.rejects(repository.getBranch('pr/me/100'), 'Should not create a unique branch');
			assert.strictEqual(await repository.getConfig('branch.my-branch.github-pr-owner-number'), 'owner#name#100');
		});

		it('creates a unique branch when the behind PR branch is checked out in another worktree', async function () {
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

			await repository.createBranch('my-branch', false, 'local-commit-hash');
			await repository.createBranch('refs/remotes/origin/my-branch', false, 'remote-commit-hash');
			await repository.setBranchUpstream('my-branch', 'refs/remotes/origin/my-branch');
			Object.assign(await repository.getBranch('my-branch'), { ahead: 0, behind: 1 });
			repository.setWorktrees([{
				name: 'my-branch-worktree',
				path: 'C:\\repo-worktrees\\my-branch',
				ref: 'refs/heads/my-branch',
				main: false,
				detached: false,
			}]);

			repository.expectFetch('origin', 'my-branch');
			const pull = sinon.spy(repository, 'pull');

			await PullRequestGitHelper.fetchAndCheckout(repository, [remote], pullRequest, { report: () => undefined });

			const originalBranch = await repository.getBranch('my-branch');
			assert.strictEqual(originalBranch.commit, 'local-commit-hash', 'Original branch should be preserved');
			const uniqueBranch = await repository.getBranch('pr/me/100');
			assert.strictEqual(uniqueBranch.commit, 'remote-commit-hash', 'Unique branch should have remote commit');
			assert.strictEqual(repository.state.HEAD?.name, 'pr/me/100', 'Should check out the unique branch');
			assert.strictEqual(pull.called, false, 'Should not pull a branch checked out in another worktree');
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

			repository.expectFetch('you', 'my-branch:pr/me/100');
			repository.expectPull(true);

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
				commit: undefined,
				upstream: {
					remote: 'you',
					name: 'my-branch',
				},
			});
			assert.strictEqual(await repository.getConfig('branch.pr/me/100.github-pr-owner-number'), 'owner#name#100');
		});
	});

	describe('associateBranchWithPullRequest', function () {
		const pullRequest = (number: number) => ({
			number,
			base: {
				repositoryCloneUrl: {
					owner: 'owner',
					repositoryName: 'name',
				},
			},
		}) as PullRequestModel;

		it('replaces pull request metadata instead of appending values', async function () {
			await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest(100), 'feature');
			await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest(100), 'feature');
			await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest(101), 'feature');

			const key = 'branch.feature.github-pr-owner-number';
			assert.deepStrictEqual((await repository.getConfigs()).filter(config => config.key === key), [
				{ key, value: 'owner#name#101' },
			]);
		});

		it('does not append metadata during concurrent associations', async function () {
			await Promise.all([
				PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest(100), 'feature'),
				PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest(100), 'feature'),
			]);

			const key = 'branch.feature.github-pr-owner-number';
			assert.deepStrictEqual((await repository.getConfigs()).filter(config => config.key === key), [
				{ key, value: 'owner#name#100' },
			]);
		});

		it('does not append to existing duplicate metadata', async function () {
			const key = 'branch.feature.github-pr-owner-number';
			await repository.setConfig(key, 'owner#name#100');
			await repository.setConfig(key, 'owner#name#100');

			await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest(100), 'feature');

			assert.strictEqual((await repository.getConfigs()).filter(config => config.key === key).length, 2);
		});
	});

	describe('associateBaseBranchWithBranch', function () {
		it('replaces base branch metadata instead of appending values', async function () {
			await PullRequestGitHelper.associateBaseBranchWithBranch(repository, 'feature', { owner: 'owner', repo: 'name', branch: 'main' });
			await PullRequestGitHelper.associateBaseBranchWithBranch(repository, 'feature', { owner: 'owner', repo: 'name', branch: 'main' });
			await PullRequestGitHelper.associateBaseBranchWithBranch(repository, 'feature', { owner: 'owner', repo: 'name', branch: 'next' });

			const key = 'branch.feature.github-pr-base-branch';
			assert.deepStrictEqual((await repository.getConfigs()).filter(config => config.key === key), [
				{ key, value: 'owner#name#next' },
			]);
		});
	});

	describe('getMatchingPullRequestMetadataForBranch', function () {
		it('returns the highest-numbered PR when duplicate config entries exist for the branch', async function () {
			// Simulate the case where a branch name has been associated with multiple
			// PRs over time and `git config --get-all` returns duplicate entries.
			// The helper should prefer the most recent association (highest PR
			// number for the same owner/repo), not the lowest.
			sinon.stub(repository, 'getConfigs').resolves([
				{ key: 'branch.feature.github-pr-owner-number', value: 'owner#name#5' },
				{ key: 'branch.feature.github-pr-owner-number', value: 'owner#name#42' },
				{ key: 'branch.feature.github-pr-owner-number', value: 'owner#name#17' },
				{ key: 'branch.other.github-pr-owner-number', value: 'owner#name#999' },
			]);

			const metadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(repository, 'feature');

			assert.deepStrictEqual(metadata, {
				owner: 'owner',
				repositoryName: 'name',
				prNumber: 42,
			});
		});

		it('ignores entries whose PR number is not a finite integer', async function () {
			// Malformed config values (e.g. `owner#name#abc`) parse to a metadata
			// object with `prNumber: NaN`. Such entries must be filtered out so
			// they do not poison the numeric sort and cause invalid metadata to
			// be returned in preference to a valid entry.
			sinon.stub(repository, 'getConfigs').resolves([
				{ key: 'branch.feature.github-pr-owner-number', value: 'owner#name#abc' },
				{ key: 'branch.feature.github-pr-owner-number', value: 'owner#name#7' },
			]);

			const metadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(repository, 'feature');

			assert.deepStrictEqual(metadata, {
				owner: 'owner',
				repositoryName: 'name',
				prNumber: 7,
			});
		});

		it('returns undefined when no config entries parse to valid metadata', async function () {
			sinon.stub(repository, 'getConfigs').resolves([
				{ key: 'branch.feature.github-pr-owner-number', value: 'owner#name#abc' },
				{ key: 'branch.feature.github-pr-owner-number', value: 'not-valid' },
			]);

			const metadata = await PullRequestGitHelper.getMatchingPullRequestMetadataForBranch(repository, 'feature');

			assert.strictEqual(metadata, undefined);
		});
	});
});
