/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import { StackCandidate } from '../../../common/views';
import { Protocol } from '../../common/protocol';
import { GitHubServerType } from '../../common/authentication';
import { GitHubRemote } from '../../common/remote';
import { CredentialStore } from '../../github/credentials';
import { GithubItemStateEnum } from '../../github/interface';
import { PullRequestModel } from '../../github/pullRequestModel';
import { addPullRequestsToStack, isStackablePullRequest, orderStackablePullRequests } from '../../github/pullRequestStack';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { getAddToStackConfirmation } from '../../view/prsTreeDataProvider';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('Pull request stack selection', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let credentials: CredentialStore;
	let repository: MockGitHubRepository;
	let remote: GitHubRemote;
	let telemetry: MockTelemetry;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentials = new CredentialStore(telemetry, context);
		const url = 'https://github.com/owner/repo';
		remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		repository = new MockGitHubRepository(remote, credentials, telemetry, sinon);
	});

	afterEach(function () {
		repository.dispose();
		credentials.dispose();
		context.dispose();
		sinon.restore();
	});

	function pullRequest(number: number, base: string, head: string, state: 'open' | 'closed' = 'open', headOwner: string = remote.owner): PullRequestModel {
		const rest = new PullRequestBuilder().number(number).state(state)
			.base(ref => ref.ref(base))
			.head(ref => ref.ref(head)).build();
		for (const ref of [rest.base, rest.head]) {
			ref.repo.owner.login = remote.owner;
			ref.repo.name = remote.repositoryName;
			ref.repo.clone_url = `https://github.com/${remote.owner}/${remote.repositoryName}.git`;
		}
		rest.head.repo.owner.login = headOwner;
		rest.head.repo.clone_url = `https://github.com/${headOwner}/${remote.repositoryName}.git`;
		return new PullRequestModel(credentials, telemetry, repository, remote, convertRESTPullRequestToRawPullRequest(rest, repository));
	}

	it('orders a branch chain from the target base toward the top', function () {
		const bottom = pullRequest(1, 'main', 'D1');
		const middle = pullRequest(2, 'D1', 'D2');
		const top = pullRequest(3, 'D2', 'D3');
		assert.deepStrictEqual(orderStackablePullRequests([top, bottom, middle]), [bottom, middle, top]);
	});

	it('distinguishes creating a stack from adding PRs to an existing stack', function () {
		const bottom = pullRequest(1, 'main', 'D1');
		const middle = pullRequest(2, 'D1', 'D2');
		const top = pullRequest(3, 'D2', 'D3');
		assert.deepStrictEqual(getAddToStackConfirmation([bottom, middle], {
			parentPullRequestNumber: 1, size: 1, url: bottom.html_url,
		}), {
			message: 'Create a stack with 2 pull requests?',
			detail: '#1 New feature\n#2 New feature',
			action: 'Create Stack',
		});
		assert.deepStrictEqual(getAddToStackConfirmation([bottom, middle], {
			parentPullRequestNumber: 1, stackNumber: 10, size: 3, url: bottom.html_url,
		}), {
			message: 'Add 1 pull request to an existing stack?',
			detail: 'Adding #2 New feature\nto #1 New feature',
			action: 'Add to Stack',
		});
		assert.deepStrictEqual(getAddToStackConfirmation([bottom, middle, top], {
			parentPullRequestNumber: 1, stackNumber: 10, size: 3, url: bottom.html_url,
		}), {
			message: 'Add 2 pull requests to an existing stack?',
			detail: 'Adding #2 New feature\n#3 New feature\nto #1 New feature',
			action: 'Add to Stack',
		});
	});

	it('hides the action for unrelated, duplicate, closed and forked PRs', function () {
		const bottom = pullRequest(1, 'main', 'D1');
		const top = pullRequest(2, 'D1', 'D2');
		assert.strictEqual(orderStackablePullRequests([bottom]) === undefined, true, 'one PR is insufficient');
		assert.strictEqual(orderStackablePullRequests([bottom, bottom]) === undefined, true, 'duplicate PRs are invalid');
		assert.strictEqual(orderStackablePullRequests([bottom, pullRequest(3, 'other', 'D3')]) === undefined, true, 'disconnected branches are invalid');
		assert.strictEqual(orderStackablePullRequests([bottom, top, pullRequest(3, 'D1', 'D2')]) === undefined, true, 'duplicate head branches are invalid');
		assert.strictEqual(orderStackablePullRequests([bottom, pullRequest(3, 'D1', 'D3', 'closed')]) === undefined, true, 'closed PRs are invalid');
		const forked = pullRequest(4, 'D1', 'D4', 'open', 'another');
		assert.strictEqual(isStackablePullRequest(forked), false);
		assert.strictEqual(orderStackablePullRequests([bottom, forked]) === undefined, true, 'forked heads are invalid');
		assert.strictEqual(orderStackablePullRequests([bottom, top])?.map(pr => pr.number).join(','), '1,2');
	});

	for (const flag of ['isRemoteHeadDeleted', 'isRemoteBaseDeleted'] as const) {
		it(`hides the action when ${flag} is set despite retained ref metadata`, function () {
			const bottom = pullRequest(1, 'main', 'D1');
			const top = pullRequest(2, 'D1', 'D2');
			for (const pr of [bottom, top]) {
				pr[flag] = true;
				assert(pr.head && pr.base);
				assert.strictEqual(isStackablePullRequest(pr), false);
				assert.strictEqual(orderStackablePullRequests([bottom, top]), undefined);
				pr[flag] = false;
			}
			assert.deepStrictEqual(orderStackablePullRequests([top, bottom]), [bottom, top]);
		});

		for (const number of [1, 2]) {
			it(`rejects PR #${number} when ${flag} is set during refresh before writing`, async function () {
				const bottom = pullRequest(1, 'main', 'D1');
				const top = pullRequest(2, 'D1', 'D2');
				sinon.stub(repository, 'getPullRequest').callsFake(async prNumber => {
					const pr = prNumber === bottom.number ? bottom : top;
					if (prNumber === number) {
						pr[flag] = true;
					}
					return pr;
				});
				const candidate = { parentPullRequestNumber: 1, size: 1, url: bottom.html_url };
				const findCandidate = sinon.stub(repository, 'getStackCandidate').resolves(candidate);
				const add = sinon.stub(repository, 'addPullRequestsToStack').resolves();

				await assert.rejects(addPullRequestsToStack([bottom, top], candidate), /branches have changed/);
				assert(findCandidate.notCalled);
				assert(add.notCalled);
			});
		}
	}

	it('creates a new stack with selected PRs in branch order after refreshing them', async function () {
		const bottom = pullRequest(1, 'main', 'D1');
		const middle = pullRequest(2, 'D1', 'D2');
		const top = pullRequest(3, 'D2', 'D3');
		const refresh = sinon.stub(repository, 'getPullRequest').callsFake(async number => [bottom, middle, top].find(pr => pr.number === number));
		const candidate = { parentPullRequestNumber: 1, size: 1, url: bottom.html_url };
		sinon.stub(repository, 'getStackCandidate').resolves(candidate);
		sinon.stub(middle, 'getStack').resolves(undefined);
		sinon.stub(top, 'getStack').resolves(undefined);
		const add = sinon.stub(repository, 'addPullRequestsToStack').resolves();

		assert.deepStrictEqual(await addPullRequestsToStack([top, bottom, middle], candidate), [1, 2, 3]);
		assert(refresh.calledThrice);
		assert(add.calledOnceWithExactly({ parentPullRequestNumber: 1, size: 1, url: bottom.html_url }, [2, 3]));
	});

	it('appends to an existing stack only when the bottom PR is its top', async function () {
		const bottom = pullRequest(1, 'main', 'D1');
		const top = pullRequest(2, 'D1', 'D2');
		sinon.stub(repository, 'getPullRequest').callsFake(async number => [bottom, top].find(pr => pr.number === number));
		const candidate = { parentPullRequestNumber: 1, stackNumber: 10, size: 3, url: bottom.html_url };
		sinon.stub(repository, 'getStackCandidate').resolves(candidate);
		sinon.stub(top, 'getStack').resolves(undefined);
		const add = sinon.stub(repository, 'addPullRequestsToStack').resolves();

		assert.deepStrictEqual(await addPullRequestsToStack([top, bottom], candidate), [1, 2]);
		assert(add.calledOnceWithExactly(candidate, [2]));
	});

	for (const { confirmedStackNumber, currentStackNumber } of [
		{ confirmedStackNumber: undefined, currentStackNumber: 10 },
		{ confirmedStackNumber: 10, currentStackNumber: undefined },
		{ confirmedStackNumber: 10, currentStackNumber: 11 },
	]) {
		it(`rejects a stack changing from ${confirmedStackNumber} to ${currentStackNumber} after confirmation`, async function () {
			const bottom = pullRequest(1, 'main', 'D1');
			const top = pullRequest(2, 'D1', 'D2');
			sinon.stub(repository, 'getPullRequest').callsFake(async number => number === bottom.number ? bottom : top);
			const confirmedCandidate: StackCandidate = {
				parentPullRequestNumber: bottom.number, stackNumber: confirmedStackNumber, size: 1, url: bottom.html_url,
			};
			sinon.stub(repository, 'getStackCandidate').resolves({ ...confirmedCandidate, stackNumber: currentStackNumber });
			const add = sinon.stub(repository, 'addPullRequestsToStack').resolves();

			await assert.rejects(addPullRequestsToStack([bottom, top], confirmedCandidate), /stack has changed/);
			assert(add.notCalled);
		});
	}

	it('rejects stale branch chains and PRs already in another stack before writing', async function () {
		const bottom = pullRequest(1, 'main', 'D1');
		const top = pullRequest(2, 'D1', 'D2');
		const moved = pullRequest(2, 'other', 'D2');
		const refresh = sinon.stub(repository, 'getPullRequest').callsFake(async number => number === 1 ? bottom : moved);
		const add = sinon.stub(repository, 'addPullRequestsToStack').resolves();
		const candidate = { parentPullRequestNumber: 1, size: 1, url: bottom.html_url };
		await assert.rejects(addPullRequestsToStack([top, bottom], candidate), /branches have changed/);
		assert(add.notCalled);

		refresh.callsFake(async number => number === 1 ? bottom : top);
		sinon.stub(repository, 'getStackCandidate').resolves(candidate);
		sinon.stub(top, 'getStack').resolves({
			position: 1, size: 1, base: 'main', pullRequests: [{
				position: 1, number: 2, title: top.title, url: top.html_url, head: 'D2',
				state: GithubItemStateEnum.Open, isDraft: false, mergeable: top.item.mergeable!,
			}],
		});
		await assert.rejects(addPullRequestsToStack([bottom, top], candidate), /already in a stack/);
		assert(add.notCalled);
	});

	it('rejects a changed head branch when refreshing reuses the selected model', async function () {
		const bottom = pullRequest(1, 'main', 'D1');
		const top = pullRequest(2, 'D1', 'D2');
		sinon.stub(repository, 'getPullRequest').callsFake(async number => {
			if (number === top.number) {
				top.head!.ref = 'D3';
			}
			return number === bottom.number ? bottom : top;
		});
		const add = sinon.stub(repository, 'addPullRequestsToStack').resolves();
		const candidate = { parentPullRequestNumber: 1, size: 1, url: bottom.html_url };

		await assert.rejects(addPullRequestsToStack([bottom, top], candidate), /branches have changed/);
		assert(add.notCalled);
	});
});
