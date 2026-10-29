/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import { GitHubServerType } from '../../common/authentication';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { CredentialStore } from '../../github/credentials';
import { GitHubRepository } from '../../github/githubRepository';
import { GithubItemStateEnum, PullRequestMergeability, PullRequestStack, StackablePullRequest } from '../../github/interface';
import { PullRequestModel } from '../../github/pullRequestModel';
import { getStackRecommendation } from '../../github/stackRecommendation';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';

describe('getStackRecommendation', function () {
	let sinon: SinonSandbox;
	let context: MockExtensionContext;
	let credentials: CredentialStore;
	let repository: MockGitHubRepository;
	let remote: GitHubRemote;
	let telemetry: MockTelemetry;
	let branchStatus: SinonStub<Parameters<GitHubRepository['getStackBranchStatus']>, ReturnType<GitHubRepository['getStackBranchStatus']>>;
	/** How many commits each `base...head` comparison is behind by, when it is behind. */
	let behindBy: Map<string, number>;
	/** The open pull requests created by `pullRequest`, which GitHub would also find. */
	let opened: StackablePullRequest[];

	beforeEach(function () {
		sinon = createSandbox();
		opened = [];
		behindBy = new Map();
		MockCommandRegistry.install(sinon);
		context = new MockExtensionContext();
		telemetry = new MockTelemetry();
		credentials = new CredentialStore(telemetry, context);
		const url = 'https://github.com/owner/repo';
		remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
		repository = new MockGitHubRepository(remote, credentials, telemetry, sinon);
		branchStatus = sinon.stub(repository, 'getStackBranchStatus').callsFake(async comparisons =>
			({ behindBy: comparisons.map(({ base, head }) => behindBy.get(`${base}...${head}`) ?? 0) }));
	});

	/** The branches that were compared, as `base...head`. */
	function comparedBranches(): string[] {
		return branchStatus.args.flatMap(([comparisons]) => comparisons.map(({ base, head }) => `${base}...${head}`)).sort();
	}

	afterEach(function () {
		repository.dispose();
		credentials.dispose();
		context.dispose();
		sinon.restore();
	});

	function createModel(number: number, base: string, head: string, headOwner: string = remote.owner): PullRequestModel {
		const rest = new PullRequestBuilder().number(number).base(ref => ref.ref(base)).head(ref => ref.ref(head)).build();
		for (const ref of [rest.base, rest.head]) {
			ref.repo.owner.login = remote.owner;
			ref.repo.name = remote.repositoryName;
			ref.repo.clone_url = `https://github.com/${remote.owner}/${remote.repositoryName}.git`;
		}
		rest.head.repo.owner.login = headOwner;
		rest.head.repo.clone_url = `https://github.com/${headOwner}/${remote.repositoryName}.git`;
		rest.title = `Change ${number}`;
		rest.html_url = `https://github.com/owner/repo/pull/${number}`;
		const model = new PullRequestModel(credentials, telemetry, repository, remote, convertRESTPullRequestToRawPullRequest(rest, repository));
		model.item.mergeable = PullRequestMergeability.Mergeable;
		return model;
	}

	/** The open pull request that a stack is recommended for, which GitHub also finds. */
	function pullRequest(number: number, base: string, head: string, headOwner: string = remote.owner): PullRequestModel {
		opened.push(stackable(number, base, head));
		return createModel(number, base, head, headOwner);
	}

	/** The top of a stack, as it is loaded to show the stack in the recommendation. */
	function stackTop(number: number, base: string, head: string, stack: PullRequestStack | undefined): SinonStub {
		const model = createModel(number, base, head);
		sinon.stub(model, 'getStack').resolves(stack);
		return sinon.stub(repository, 'getPullRequest').resolves(model);
	}

	function stackable(number: number, base: string, head: string, stackEntry?: { position: number; size: number }): StackablePullRequest {
		return {
			number,
			title: `Change ${number}`,
			url: `https://github.com/owner/repo/pull/${number}`,
			base,
			head,
			isDraft: false,
			isQueued: false,
			mergeable: PullRequestMergeability.Mergeable,
			stackEntry,
		};
	}

	/** Answers lookups from the given open pull requests, the way GitHub finds the only one that lines up. */
	function openPullRequests(pullRequests: StackablePullRequest[]): SinonStub {
		const only = (matches: StackablePullRequest[]) => matches.length === 1 ? matches[0] : undefined;
		return sinon.stub(repository, 'getStackablePullRequests').callsFake(async (base, head) => {
			const all = [...pullRequests, ...opened];
			return {
				below: base === undefined ? undefined : only(all.filter(pr => pr.head === base)),
				targetingBase: base === undefined ? undefined : only(all.filter(pr => pr.base === base))?.number,
				above: head === undefined ? undefined : only(all.filter(pr => pr.base === head)),
			};
		});
	}

	function entry(position: number, number: number, head: string, mergeable = PullRequestMergeability.Mergeable): PullRequestStack['pullRequests'][number] {
		return {
			position,
			number,
			title: `Change ${number}`,
			url: `https://github.com/owner/repo/pull/${number}`,
			head,
			state: GithubItemStateEnum.Open,
			isDraft: false,
			isQueued: false,
			mergeable,
		};
	}

	it('recommends nothing when no other pull request lines up, after one lookup', async function () {
		const lookups = openPullRequests([stackable(7, 'other', 'feature')]);

		assert.strictEqual(await getStackRecommendation(pullRequest(2, 'main', 'D2')), undefined);
		assert.deepStrictEqual(lookups.args, [['main', 'D2']]);
	});

	it('follows the chain down and up at the same time from a pull request in the middle', async function () {
		const lookups = openPullRequests([
			stackable(1, 'main', 'D1'),
			stackable(3, 'D2', 'D3'),
			stackable(4, 'D3', 'D4'),
		]);

		assert.deepStrictEqual(await getStackRecommendation(pullRequest(2, 'D1', 'D2')), {
			preview: {
				stack: {
					position: 2,
					size: 4,
					base: 'main',
					needsUpdate: false,
					pullRequests: [entry(1, 1, 'D1'), entry(2, 2, 'D2'), entry(3, 3, 'D3'), entry(4, 4, 'D4')],
				},
				existingStackSize: undefined,
			},
			pullRequestNumbers: [1, 2, 3, 4],
		});
		assert.deepStrictEqual(lookups.args, [['D1', 'D2'], ['main', 'D3'], [undefined, 'D4']]);
	});

	it('shows which pull requests are behind their base, like the stack section', async function () {
		openPullRequests([stackable(3, 'D2', 'D3')]);
		behindBy.set('D2...owner:D3', 1);

		const recommendation = await getStackRecommendation(pullRequest(2, 'D1', 'D2'));

		assert.deepStrictEqual(recommendation?.preview.stack.pullRequests.map(pr => pr.mergeable),
			[PullRequestMergeability.Mergeable, PullRequestMergeability.Behind]);
		assert.strictEqual(recommendation?.preview.stack.needsUpdate, true);
		assert.deepStrictEqual(comparedBranches(), ['D1...owner:D2', 'D2...owner:D3']);
	});

	it('does not mark the bottom of a new stack as behind its base, like the stack section', async function () {
		openPullRequests([stackable(3, 'D2', 'D3')]);
		behindBy.set('D1...owner:D2', 2);

		const recommendation = await getStackRecommendation(pullRequest(2, 'D1', 'D2'));

		assert.deepStrictEqual(recommendation?.preview.stack.pullRequests.map(pr => pr.mergeable),
			[PullRequestMergeability.Mergeable, PullRequestMergeability.Mergeable]);
		assert.strictEqual(recommendation?.preview.stack.needsUpdate, true, 'updating the stack is still offered');
	});

	it('marks pull requests added to an existing stack as behind, since the bottom of the stack is below them', async function () {
		openPullRequests([stackable(5, 'D4', 'D5', { position: 2, size: 2 })]);
		stackTop(5, 'D4', 'D5', {
			position: 2, size: 2, base: 'main', needsUpdate: false,
			pullRequests: [entry(1, 4, 'D4'), entry(2, 5, 'D5')],
		});
		behindBy.set('D5...owner:D6', 1);

		const recommendation = await getStackRecommendation(pullRequest(6, 'D5', 'D6'));

		assert.deepStrictEqual(recommendation?.preview.stack.pullRequests.map(pr => pr.mergeable),
			[PullRequestMergeability.Mergeable, PullRequestMergeability.Mergeable, PullRequestMergeability.Behind]);
		assert.strictEqual(recommendation?.preview.stack.needsUpdate, true);
	});

	it('extends the stack whose top is below the chain', async function () {
		openPullRequests([stackable(5, 'D4', 'D5', { position: 2, size: 2 }), stackable(7, 'D6', 'D7')]);
		const existing: PullRequestStack = {
			position: 2,
			size: 2,
			base: 'main',
			needsUpdate: true,
			pullRequests: [entry(1, 4, 'D4'), entry(2, 5, 'D5', PullRequestMergeability.Conflict)],
		};
		const getPullRequest = stackTop(5, 'D4', 'D5', existing);

		assert.deepStrictEqual(await getStackRecommendation(pullRequest(6, 'D5', 'D6')), {
			preview: {
				stack: {
					position: 3,
					size: 4,
					base: 'main',
					needsUpdate: true,
					pullRequests: [entry(1, 4, 'D4'), entry(2, 5, 'D5', PullRequestMergeability.Conflict), entry(3, 6, 'D6'), entry(4, 7, 'D7')],
				},
				existingStackSize: 2,
			},
			pullRequestNumbers: [5, 6, 7],
		});
		assert.strictEqual(getPullRequest.firstCall.args[0], 5);
		assert.deepStrictEqual(comparedBranches(), ['D5...owner:D6', 'D6...owner:D7'], 'the stack is not compared again');
	});

	it('does not recommend extending a stack that changed since it was found', async function () {
		openPullRequests([stackable(5, 'D4', 'D5', { position: 2, size: 2 })]);
		stackTop(5, 'D4', 'D5', undefined);

		assert.strictEqual(await getStackRecommendation(pullRequest(6, 'D5', 'D6')), undefined);
	});

	it('stops below the middle of a stack and below any stack above the chain', async function () {
		openPullRequests([
			stackable(1, 'main', 'D1', { position: 1, size: 2 }),
			stackable(3, 'D2', 'D3', { position: 1, size: 2 }),
		]);

		assert.strictEqual(await getStackRecommendation(pullRequest(2, 'D1', 'D2')), undefined);
	});

	it('stops where more than one pull request lines up', async function () {
		openPullRequests([stackable(1, 'main', 'D1'), stackable(3, 'D2', 'D3'), stackable(4, 'D2', 'D4')]);

		const recommendation = await getStackRecommendation(pullRequest(2, 'D1', 'D2'));

		assert.deepStrictEqual(recommendation?.pullRequestNumbers, [1, 2]);
	});

	it('does not stack on a pull request that another pull request also merges into', async function () {
		openPullRequests([stackable(1, 'main', 'D1'), stackable(2, 'D1', 'D2'), stackable(4, 'D2', 'D4')]);

		assert.strictEqual(await getStackRecommendation(pullRequest(3, 'D2', 'D3')), undefined);
	});

	it('does not extend a stack that another pull request also merges into', async function () {
		const lookups = openPullRequests([stackable(5, 'D4', 'D5', { position: 2, size: 2 }), stackable(7, 'D5', 'D7')]);
		const getPullRequest = sinon.stub(repository, 'getPullRequest');

		assert.strictEqual(await getStackRecommendation(pullRequest(6, 'D5', 'D6')), undefined);
		assert(lookups.calledOnce);
		assert(getPullRequest.notCalled);
	});

	it('recommends nothing when two pull requests loop back around', async function () {
		openPullRequests([stackable(3, 'D2', 'D1')]);

		assert.strictEqual(await getStackRecommendation(pullRequest(2, 'D1', 'D2')), undefined);
	});

	it('recommends nothing when a longer chain loops back around', async function () {
		const lookups = openPullRequests([stackable(1, 'D3', 'D1'), stackable(3, 'D2', 'D3')]);

		assert.strictEqual(await getStackRecommendation(pullRequest(2, 'D1', 'D2')), undefined);
		assert.strictEqual(lookups.callCount, 2);
	});

	it('recommends nothing when the GitHub server does not support stacks', async function () {
		sinon.stub(repository, 'getStackablePullRequests').resolves(undefined);

		assert.strictEqual(await getStackRecommendation(pullRequest(2, 'D1', 'D2')), undefined);
	});

	it('does not look for pull requests to stack with one from a fork', async function () {
		const lookups = openPullRequests([stackable(1, 'main', 'D1')]);

		assert.strictEqual(await getStackRecommendation(pullRequest(2, 'D1', 'D2', 'fork')), undefined);
		assert(lookups.notCalled);
	});
});
