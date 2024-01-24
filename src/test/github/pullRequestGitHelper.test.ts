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
});
