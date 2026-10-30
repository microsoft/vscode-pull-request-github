/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { Status } from '../../api/api1';
import { GitChangeType, SlimFileChange } from '../../common/file';
import { EventType } from '../../common/timelineEvent';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { getStackMergeAllTarget, GithubItemStateEnum, isStackMergeable, isStackUpdatable, MergeMethod, MergeQueueState, PullRequestStack, PullRequestMergeability } from '../../github/interface';
import { Protocol } from '../../common/protocol';
import { GitHubRemote, Remote } from '../../common/remote';
import { convertRESTPullRequestToRawPullRequest, parseGraphQLPullRequest } from '../../github/utils';
import { SinonSandbox, SinonStub, createSandbox } from 'sinon';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { PullRequestBuilder as GraphQLPullRequestBuilder } from '../builders/graphql/pullRequestBuilder';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockRepository } from '../mocks/mockRepository';
import { NetworkStatus } from 'apollo-client';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { GitHubServerType } from '../../common/authentication';
import { mergeQuerySchemaWithShared } from '../../github/common';
import { GitHubRepository } from '../../github/githubRepository';
import { LoggingApolloClient, LoggingOctokit } from '../../github/loggingOctokit';
import Logger from '../../common/logger';
import { GraphQLError } from 'graphql';
const queries = mergeQuerySchemaWithShared(require('../../github/queries.gql'), require('../../github/queriesShared.gql')) as any;

const telemetry = new MockTelemetry();
const protocol = new Protocol('https://github.com/github/test.git');
const remote = new GitHubRemote('test', 'github/test', protocol, GitHubServerType.GitHubDotCom);

const reviewThreadResponse = {
	id: '1',
	isResolved: false,
	viewerCanResolve: true,
	path: 'README.md',
	diffSide: 'RIGHT',
	startLine: null,
	line: 4,
	originalStartLine: null,
	originalLine: 4,
	isOutdated: false,
	comments: {
		nodes: [
			{
				id: 1,
				body: "the world's largest frog weighs up to 7.2 lbs",
				graphNodeId: '1',
				diffHunk: '',
				commit: {
					oid: ''
				},
				reactionGroups: []
			},
		],
	},
};

describe('PullRequestModel', function () {
	let sinon: SinonSandbox;
	let credentials: CredentialStore;
	let repo: MockGitHubRepository;
	let context: MockExtensionContext;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		context = new MockExtensionContext();
		credentials = new CredentialStore(telemetry, context);
		repo = new MockGitHubRepository(remote, credentials, telemetry, sinon);
	});

	afterEach(function () {
		repo.dispose();
		context.dispose();
		credentials.dispose();
		sinon.restore();
	});

	it('should return `state` properly as `open`', function () {
		const pr = new PullRequestBuilder().state('open').build();
		const open = new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));

		assert.strictEqual(open.state, GithubItemStateEnum.Open);
	});

	it('should return `state` properly as `closed`', function () {
		const pr = new PullRequestBuilder().state('closed').build();
		const open = new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));

		assert.strictEqual(open.state, GithubItemStateEnum.Closed);
	});

	it('should return `state` properly as `merged`', function () {
		const pr = new PullRequestBuilder().merged(true).state('closed').build();
		const open = new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));

		assert.strictEqual(open.state, GithubItemStateEnum.Merged);
	});

	it('emits specific changes when head commits or mergeability change', function () {
		const pr = new PullRequestBuilder().number(794).build();
		const model = repo.createOrUpdatePullRequestModel(convertRESTPullRequestToRawPullRequest(pr, repo));
		const changes = sinon.spy();
		repo.onDidChangePullRequests(changes);

		model.update({ ...model.item, head: { ...model.item.head!, sha: 'updated-head' } });
		assert.deepStrictEqual(changes.lastCall.args[0][0].event, { head: true });
		model.update({ ...model.item, mergeable: PullRequestMergeability.NotMergeable });
		assert.deepStrictEqual(changes.lastCall.args[0][0].event, { mergeability: true });
	});

	it('emits a draft change separately from head and mergeability changes', function () {
		const model = repo.createOrUpdatePullRequestModel(
			convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(794).build(), repo));
		const changes = sinon.spy();
		repo.onDidChangePullRequests(changes);

		model.update({ ...model.item, isDraft: !model.isDraft });

		assert(changes.calledOnce);
		assert.deepStrictEqual(changes.firstCall.args[0][0].event, { draft: true });
	});

	it('compares merge queue fields explicitly and preserves omitted queue entries', function () {
		const model = repo.createOrUpdatePullRequestModel(
			convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(794).build(), repo));
		const changes = sinon.spy();
		repo.onDidChangePullRequests(changes);
		const entry = { position: 1, state: MergeQueueState.Queued, url: 'https://github.com/github/test/queue' };

		model.update({ ...model.item, mergeQueueEntry: entry });
		assert.deepStrictEqual(changes.lastCall.args[0][0].event, { mergeQueue: true });
		changes.resetHistory();
		model.update({ ...model.item, mergeQueueEntry: { url: entry.url, state: entry.state, position: entry.position } });
		model.update({ ...model.item, mergeQueueEntry: undefined });
		assert(changes.notCalled);
		assert.deepStrictEqual(model.mergeQueueEntry, entry);

		for (const updated of [
			{ ...entry, position: 2 },
			{ ...entry, position: 2, state: MergeQueueState.AwaitingChecks },
			{ ...entry, position: 2, state: MergeQueueState.AwaitingChecks, url: `${entry.url}/updated` },
			null,
		]) {
			changes.resetHistory();
			model.update({ ...model.item, mergeQueueEntry: updated });
			assert(changes.calledOnce);
			assert.deepStrictEqual(changes.firstCall.args[0][0].event, { mergeQueue: true });
		}
		assert.strictEqual(model.mergeQueueEntry, undefined);
	});

	it('emits a base change when the base branch or commit changes', function () {
		const model = repo.createOrUpdatePullRequestModel(
			convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(794).build(), repo));
		const changes = sinon.spy();
		repo.onDidChangePullRequests(changes);
		const base = model.item.base;
		assert(base);

		model.update({ ...model.item, base: { ...base, ref: 'updated-base' } });
		assert(changes.lastCall.args[0][0].event.base);
	});

	it('emits a mergeability change when fetching mergeability changes the model in place', async function () {
		const model = repo.createOrUpdatePullRequestModel(
			convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(794).build(), repo));
		model.item.mergeable = PullRequestMergeability.Mergeable;
		const changes = sinon.spy();
		repo.onDidChangePullRequests(changes);
		repo.queryProvider.expectGraphQLQuery({
			query: queries.PullRequestMergeability,
			variables: { owner: 'github', name: 'test', number: 794 },
		}, {
			data: { repository: { pullRequest: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' } } },
			loading: false, stale: false, networkStatus: NetworkStatus.ready,
		});

		const result = await model.getMergeability();

		assert.strictEqual(result.mergeability, PullRequestMergeability.NotMergeable);
		assert(changes.calledOnce);
		assert.deepStrictEqual(changes.firstCall.args[0][0].event, { mergeability: true });
	});

	describe('viewerCanMergeAsAdmin', function () {
		for (const capability of [true, false, undefined]) {
			it(`parses GraphQL admin merge capability ${capability}`, async function () {
				const pr = new GraphQLPullRequestBuilder().build().repository!.pullRequest;
				if (capability === undefined) {
					delete pr.viewerCanMergeAsAdmin;
				} else {
					pr.viewerCanMergeAsAdmin = capability;
				}

				const parsed = await parseGraphQLPullRequest(pr, repo);

				assert.strictEqual(parsed.viewerCanMergeAsAdmin, capability === true);
			});
		}

		for (const capability of [true, false, undefined]) {
			it(`refreshes admin merge capability to ${capability} and emits only when changed`, async function () {
				const model = repo.createOrUpdatePullRequestModel({
					...convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(794).build(), repo),
					mergeable: PullRequestMergeability.Mergeable,
					viewerCanMergeAsAdmin: capability !== true,
				});
				const changes = sinon.spy();
				repo.onDidChangePullRequests(changes);

				for (let attempt = 0; attempt < 2; attempt++) {
					changes.resetHistory();
					repo.queryProvider.expectGraphQLQuery({
						query: queries.PullRequestMergeability,
						variables: { owner: 'github', name: 'test', number: 794 },
					}, {
						data: { repository: { pullRequest: {
							mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
							...(capability === undefined ? {} : { viewerCanMergeAsAdmin: capability }),
						} } },
						loading: false, stale: false, networkStatus: NetworkStatus.ready,
					});

					const result = await model.getMergeability();

					assert.strictEqual(result.mergeability, PullRequestMergeability.Mergeable);
					assert.strictEqual(result.viewerCanMergeAsAdmin, capability === true);
					assert.strictEqual(model.item.viewerCanMergeAsAdmin, capability === true);
					if (attempt === 0) {
						assert(changes.calledOnce);
						assert.deepStrictEqual(changes.firstCall.args[0][0].event, { mergeability: true });
					} else {
						assert(changes.notCalled);
					}
				}
			});
		}

		it('preserves admin merge capability on REST updates but accepts explicit revocation', function () {
			const pr = new PullRequestBuilder().number(794).build();
			const model = repo.createOrUpdatePullRequestModel({
				...convertRESTPullRequestToRawPullRequest(pr, repo),
				viewerCanMergeAsAdmin: true,
			});
			const changes = sinon.spy();
			repo.onDidChangePullRequests(changes);

			model.update(convertRESTPullRequestToRawPullRequest(pr, repo));

			assert.strictEqual(model.item.viewerCanMergeAsAdmin, true);
			assert(changes.notCalled);

			model.update({ ...model.item, viewerCanMergeAsAdmin: false });

			assert.strictEqual(model.item.viewerCanMergeAsAdmin, false);
			assert(changes.calledOnce);
			assert.deepStrictEqual(changes.firstCall.args[0][0].event, { mergeability: true });
		});
	});

	it('skips the timeline items that the activity query does not select', async function () {
		const model = repo.createOrUpdatePullRequestModel(
			convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(794).build(), repo));
		repo.queryProvider.expectGraphQLQuery({
			query: queries.PullRequestActivityTimelineEvents,
			variables: { owner: 'github', name: 'test', number: 794 },
		}, {
			data: {
				repository: {
					pullRequest: {
						timelineItems: {
							nodes: [
								{ __typename: 'LabeledEvent' },
								{ __typename: 'HeadRefForcePushedEvent' },
								{ __typename: 'HeadRefRestoredEvent' },
								{ __typename: 'ClosedEvent', id: 'closed', actor: null, createdAt: '2026-10-28T10:00:00Z' },
							],
						},
					},
				},
			},
			loading: false, stale: false, networkStatus: NetworkStatus.ready,
		});

		const events = await model.getActivityTimelineEvents();

		assert.deepStrictEqual(events.map(event => event.event), [EventType.Closed]);
	});

	describe('getStack', function () {
		let branchStatus: SinonStub<Parameters<GitHubRepository['getStackBranchStatus']>, ReturnType<GitHubRepository['getStackBranchStatus']>>;

		/** Reports how far behind its base each head branch is, and the merge queue of the stack's base. */
		function stubBranchStatus(stub: typeof branchStatus, behindBy: (head: string) => number | undefined, mergeQueueMethod?: MergeMethod) {
			stub.callsFake(async comparisons => ({ behindBy: comparisons.map(({ head }) => behindBy(head)), mergeQueueMethod }));
		}

		/** The branches that were compared, as `base...head`. */
		function comparedBranches(): string[] {
			assert(branchStatus.calledOnce);
			return branchStatus.firstCall.args[0].map(({ base, head }) => `${base}...${head}`);
		}

		beforeEach(function () {
			branchStatus = sinon.stub(repo, 'getStackBranchStatus');
			stubBranchStatus(branchStatus, () => 0);
		});

		function createModel(number = 794) {
			const pr = new PullRequestBuilder().number(number).build();
			return new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
		}

		function createEnterpriseModel() {
			const enterpriseRemote = new GitHubRemote('enterprise', 'https://enterprise.example.com/github/test', new Protocol('https://enterprise.example.com/github/test'), GitHubServerType.Enterprise);
			const enterpriseRepo = new MockGitHubRepository(enterpriseRemote, credentials, telemetry, sinon);
			stubBranchStatus(sinon.stub(enterpriseRepo, 'getStackBranchStatus'), () => 0);
			const pr = new PullRequestBuilder().number(794).build();
			const model = new PullRequestModel(credentials, telemetry, enterpriseRepo, enterpriseRemote, convertRESTPullRequestToRawPullRequest(pr, enterpriseRepo));
			return { enterpriseRepo, model };
		}

		function stackPage(entries: {
			position: number;
			number: number;
			mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
			mergeStateStatus?: 'CLEAN' | 'BLOCKED' | 'BEHIND' | 'DIRTY' | 'UNKNOWN';
			queued?: boolean;
			state?: GithubItemStateEnum;
			headOwner?: string;
		}[], endCursor: string | null, position = 2, size = 3) {
			return {
				data: {
					repository: {
						pullRequest: {
							stackEntry: { position },
							stack: {
								size,
								baseRefName: 'main',
								entries: {
									nodes: entries.map(entry => ({
										position: entry.position,
										pullRequest: {
											number: entry.number,
											title: `Change ${entry.number}`,
											url: `https://github.com/github/test/pull/${entry.number}`,
											state: entry.state ?? GithubItemStateEnum.Open,
											isDraft: false,
											baseRefName: entry.position === 1 ? 'main' : `D${entry.position - 1}`,
											headRefName: `D${entry.position}`,
											headRepository: entry.state && entry.state !== GithubItemStateEnum.Open ? null : { owner: { login: entry.headOwner ?? 'github' } },
											mergeable: entry.mergeable ?? 'MERGEABLE',
											mergeStateStatus: entry.mergeStateStatus ?? 'CLEAN',
											mergeQueueEntry: entry.queued ? { state: 'QUEUED' } : null,
										},
									})),
									pageInfo: { hasNextPage: endCursor !== null, endCursor },
								},
							},
						},
					},
				},
				loading: false,
				stale: false,
				networkStatus: NetworkStatus.ready,
			};
		}

		it('loads every page and orders entries by position', async function () {
			const model = createModel();
			const variables = { owner: 'github', name: 'test', number: 794 };
			repo.queryProvider.expectGraphQLQuery({ query: queries.PullRequestStack, variables: { ...variables, after: null } }, stackPage([
				{ position: 3, number: 795 },
				{ position: 2, number: 794 },
			], 'next'));
			repo.queryProvider.expectGraphQLQuery({ query: queries.PullRequestStack, variables: { ...variables, after: 'next' } }, stackPage([
				{ position: 1, number: 793 },
			], null));

			const stack = await model.getStack();
			assert.strictEqual(stack?.position, 2);
			assert.strictEqual(stack?.size, 3);
			assert.strictEqual(stack?.base, 'main');
			assert.strictEqual(stack?.needsUpdate, false);
			assert.strictEqual(stack?.mergeQueueMethod, undefined);
			assert.strictEqual(isStackUpdatable(stack!), false);
			assert.deepStrictEqual(stack?.pullRequests.map(entry => entry.number), [793, 794, 795]);
			assert.strictEqual(stack?.pullRequests[0].url, 'https://github.com/github/test/pull/793');
			assert.deepStrictEqual(stack?.pullRequests.map(entry => entry.mergeable), [
				PullRequestMergeability.Mergeable,
				PullRequestMergeability.Mergeable,
				PullRequestMergeability.Mergeable,
			]);
		});

		it('uses merge conflicts and merge requirements to classify stack readiness', async function () {
			const model = createModel();
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 794, after: null },
			}, stackPage([
				{ position: 1, number: 793, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
				{ position: 2, number: 794, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
				{ position: 3, number: 795, mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' },
			], null));

			const stack = await model.getStack();
			assert.deepStrictEqual(stack?.pullRequests.map(entry => entry.mergeable), [
				PullRequestMergeability.Conflict,
				PullRequestMergeability.NotMergeable,
				PullRequestMergeability.Behind,
			]);
			assert.deepStrictEqual(comparedBranches(), ['D1...github:D2', 'D2...github:D3']);
		});

		it('offers to update a stack with conflicts so they can be resolved by rebasing', async function () {
			const model = createModel();
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 794, after: null },
			}, stackPage([
				{ position: 1, number: 793 },
				{ position: 2, number: 794, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
				{ position: 3, number: 795, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
			], null));

			const stack = await model.getStack();
			assert.deepStrictEqual({
				needsUpdate: stack?.needsUpdate,
				canUpdate: isStackUpdatable(stack!),
				compared: comparedBranches(),
			}, { needsUpdate: true, canUpdate: true, compared: ['main...github:D1', 'D2...github:D3'] });
		});

		it('marks a PR without conflicts that is behind the PR below it as behind and blocks stack merge', async function () {
			const model = createModel();
			stubBranchStatus(branchStatus, head => head === 'github:D2' ? 1 : 0);
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 794, after: null },
			}, stackPage([
				{ position: 1, number: 793 },
				{ position: 2, number: 794 },
				{ position: 3, number: 795 },
			], null));

			const stack = await model.getStack();
			assert.deepStrictEqual({
				readiness: stack?.pullRequests.map(entry => entry.mergeable),
				canMerge: isStackMergeable(stack!, 794),
				canUpdate: isStackUpdatable(stack!),
				needsUpdate: stack?.needsUpdate,
				compared: comparedBranches(),
			}, {
				readiness: [PullRequestMergeability.Mergeable, PullRequestMergeability.Behind, PullRequestMergeability.Mergeable],
				canMerge: false,
				canUpdate: true,
				needsUpdate: true,
				compared: ['main...github:D1', 'D1...github:D2', 'D2...github:D3'],
			});
		});

		it('offers an update but allows merging when only the bottom branch is behind the stack base', async function () {
			const model = createModel();
			stubBranchStatus(branchStatus, head => head === 'github:D1' ? 1 : 0);
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 794, after: null },
			}, stackPage([
				{ position: 1, number: 793 },
				{ position: 2, number: 794 },
				{ position: 3, number: 795 },
			], null));

			const stack = await model.getStack();
			assert.deepStrictEqual({
				readiness: stack?.pullRequests.map(entry => entry.mergeable),
				canMerge: isStackMergeable(stack!, 794),
				canUpdate: isStackUpdatable(stack!),
			}, {
				readiness: [PullRequestMergeability.Mergeable, PullRequestMergeability.Mergeable, PullRequestMergeability.Mergeable],
				canMerge: true,
				canUpdate: true,
			});
			assert.deepStrictEqual(comparedBranches(), ['main...github:D1', 'D1...github:D2', 'D2...github:D3']);
		});

		it('allows merging when GitHub reports only the bottom PR as behind its target branch', async function () {
			const model = createModel(795);
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 795, after: null },
			}, stackPage([
				{ position: 1, number: 793, mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' },
				{ position: 2, number: 794 },
				{ position: 3, number: 795 },
			], null, 3));

			const stack = await model.getStack();
			assert.deepStrictEqual(stack?.pullRequests.map(entry => entry.mergeable), [
				PullRequestMergeability.Mergeable,
				PullRequestMergeability.Mergeable,
				PullRequestMergeability.Mergeable,
			]);
			assert.strictEqual(isStackMergeable(stack!, 795), true);
		});

		it('treats the lowest open PR above merged PRs as the bottom of the stack', async function () {
			const model = createModel(795);
			stubBranchStatus(branchStatus, head => head === 'github:D2' ? 1 : 0);
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 795, after: null },
			}, stackPage([
				{ position: 1, number: 793, state: GithubItemStateEnum.Merged },
				{ position: 2, number: 794 },
				{ position: 3, number: 795 },
			], null, 3));

			const stack = await model.getStack();
			assert.deepStrictEqual({ second: stack?.pullRequests[1].mergeable, canMerge: isStackMergeable(stack!, 795), needsUpdate: stack?.needsUpdate },
				{ second: PullRequestMergeability.Mergeable, canMerge: true, needsUpdate: true });
		});

		it('still blocks stack merging when the bottom PR conflicts with the target branch', async function () {
			const model = createModel(795);
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 795, after: null },
			}, stackPage([
				{ position: 1, number: 793, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
				{ position: 2, number: 794 },
				{ position: 3, number: 795 },
			], null, 3));

			const stack = await model.getStack();
			assert.strictEqual(stack?.pullRequests[0].mergeable, PullRequestMergeability.Conflict);
			assert.strictEqual(isStackMergeable(stack!, 795), false);
		});

		it('offers an update when a changed middle PR has not been propagated to the top', async function () {
			const model = createModel(795);
			stubBranchStatus(branchStatus, head => head === 'github:D3' ? 1 : 0);
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 795, after: null },
			}, stackPage([
				{ position: 1, number: 793 },
				{ position: 2, number: 794 },
				{ position: 3, number: 795 },
			], null, 3));

			const stack = await model.getStack();
			assert.deepStrictEqual(stack?.pullRequests.map(entry => entry.mergeable), [
				PullRequestMergeability.Mergeable,
				PullRequestMergeability.Mergeable,
				PullRequestMergeability.Behind,
			]);
			assert.strictEqual(stack?.needsUpdate, true);
			assert.strictEqual(isStackUpdatable(stack!), true);
			assert.deepStrictEqual(comparedBranches(), ['main...github:D1', 'D1...github:D2', 'D2...github:D3']);
		});

		it('keeps unknown mergeability and unmet requirements visible for a PR behind its base', async function () {
			const model = createModel();
			stubBranchStatus(branchStatus, () => 1);
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 794, after: null },
			}, stackPage([
				{ position: 1, number: 793 },
				{ position: 2, number: 794, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
				{ position: 3, number: 795, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
			], null));

			const stack = await model.getStack();
			assert.deepStrictEqual({
				readiness: stack?.pullRequests.map(entry => entry.mergeable),
				needsUpdate: stack?.needsUpdate,
			}, {
				readiness: [PullRequestMergeability.Mergeable, PullRequestMergeability.Unknown, PullRequestMergeability.NotMergeable],
				needsUpdate: true,
			});
		});

		it('blocks merging an up-to-date PR above a behind PR with a closed top', async function () {
			const model = createModel(795);
			stubBranchStatus(branchStatus, head => head === 'github:D2' ? 1 : 0);
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 795, after: null },
			}, stackPage([
				{ position: 1, number: 793 },
				{ position: 2, number: 794 },
				{ position: 3, number: 795 },
				{ position: 4, number: 798, state: GithubItemStateEnum.Closed },
			], null, 3, 4));

			const stack = await model.getStack();
			assert.deepStrictEqual(stack?.pullRequests.map(entry => entry.mergeable), [
				PullRequestMergeability.Mergeable,
				PullRequestMergeability.Behind,
				PullRequestMergeability.Mergeable,
				PullRequestMergeability.Mergeable,
			]);
			assert.strictEqual(isStackMergeable(stack!, 795), false);
			assert.strictEqual(isStackUpdatable(stack!), true);
			assert.deepStrictEqual(comparedBranches(), ['main...github:D1', 'D1...github:D2', 'D2...github:D3']);
		});

		it('does not report a stack merge-ready when the base comparison fails', async function () {
			const model = createModel();
			stubBranchStatus(branchStatus, () => undefined);
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 794, after: null },
			}, stackPage([{ position: 2, number: 794 }], null));

			await assert.rejects(model.getStack(), /Unable to check whether pull request #794 is behind its stack base/);
		});

		it('compares fork branches by owner and skips closed entries without branch information', async function () {
			const model = createModel();
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 794, after: null },
			}, stackPage([
				{ position: 1, number: 793, state: GithubItemStateEnum.Merged },
				{ position: 2, number: 794, headOwner: 'fork-owner' },
				{ position: 3, number: 795, state: GithubItemStateEnum.Closed },
			], null));

			const stack = await model.getStack();
			assert.deepStrictEqual(stack?.pullRequests.map(entry => entry.state), [
				GithubItemStateEnum.Merged, GithubItemStateEnum.Open, GithubItemStateEnum.Closed,
			]);
			assert.deepStrictEqual(comparedBranches(), ['D1...fork-owner:D2']);
		});

		it('looks up the merge queue of the stack base with the branches', async function () {
			const model = createModel();
			stubBranchStatus(branchStatus, () => 0, 'squash');
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 794, after: null },
			}, stackPage([{ position: 2, number: 794 }], null));

			const stack = await model.getStack();
			assert.strictEqual(stack?.mergeQueueMethod, 'squash');
			assert(branchStatus.calledOnceWithExactly([{ base: 'D1', head: 'github:D2' }], 'main'));
		});

		it('does not offer a stack update when a pull request is queued', async function () {
			const model = createModel();
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 794, after: null },
			}, stackPage([
				{ position: 1, number: 793 },
				{ position: 2, number: 794, queued: true },
				{ position: 3, number: 795 },
			], null));

			const stack = await model.getStack();
			assert.deepStrictEqual(stack?.pullRequests.map(entry => entry.isQueued), [false, true, false]);
			assert.strictEqual(isStackUpdatable(stack!), false);
		});

		describe('mergeStack', function () {
			const route = '/repos/{owner}/{repo}/pulls/{pull_number}/merge-async';
			const stack: PullRequestStack = {
				position: 2,
				size: 2,
				base: 'main',
				pullRequests: [
					{ position: 1, number: 793, title: 'First', url: '', head: 'D1', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
					{ position: 2, number: 794, title: 'Second', url: '', head: 'D2', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
				],
			};

			function createModel(): PullRequestModel {
				const pr = new PullRequestBuilder().number(794).build();
				return new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
			}

			function requestParams(model: PullRequestModel) {
				return {
					owner: 'github',
					repo: 'test',
					pull_number: 794,
					headers: { 'X-GitHub-Api-Version': '2026-03-10' },
					sha: model.head?.sha,
					merge_action: 'direct_merge',
					merge_method: 'squash',
				};
			}

			it('requests a direct stack merge with the selected method and head SHA', async function () {
				const model = createModel();
				const changed = sinon.spy();
				repo.onDidChangeStack(changed);
				repo.queryProvider.expectOctokitRequest(['request'], [`PUT ${route}`, requestParams(model)], {
					status: 'merged',
					details: { message: 'Merged', sha: 'merge-sha' },
				});

				assert.strictEqual(await model.mergeStack(new MockRepository(), stack, 'squash', 'direct_merge'), 'merged');
				assert(changed.calledOnceWithExactly([793, 794]));
			});

			it('queues a stack without supplying a direct merge method', async function () {
				const model = createModel();
				const { merge_method, ...params } = requestParams(model);
				repo.queryProvider.expectOctokitRequest(['request'], [`PUT ${route}`, { ...params, merge_action: 'merge_queue' }], {
					status: 'enqueued',
					details: { message: 'Added to merge queue' },
				});

				assert.strictEqual(await model.mergeStack(new MockRepository(), stack, 'squash', 'merge_queue'), 'enqueued');
			});

			it('polls an accepted merge request until it completes', async function () {
				this.timeout(8000);
				const model = createModel();
				repo.queryProvider.expectOctokitRequest(['request'], [`PUT ${route}`, requestParams(model)], {
					status: 'pending',
					details: { message: 'Processing', uuid: 'request-uuid' },
				});
				repo.queryProvider.expectOctokitRequest(['request'], [`GET ${route}/{uuid}`, {
					owner: 'github', repo: 'test', pull_number: 794,
					headers: { 'X-GitHub-Api-Version': '2026-03-10' }, uuid: 'request-uuid',
				}], {
					status: 'merged',
					details: { message: 'Merged', sha: 'merge-sha' },
				});

				assert.strictEqual(await model.mergeStack(new MockRepository(), stack, 'squash', 'direct_merge'), 'merged');
			});

			it('reports a merge that remains pending after the polling timeout', async function () {
				const model = createModel();
				const now = sinon.stub(Date, 'now');
				now.onFirstCall().returns(0);
				now.onSecondCall().returns(5 * 60 * 1000);
				repo.queryProvider.expectOctokitRequest(['request'], [`PUT ${route}`, requestParams(model)], {
					status: 'pending',
					details: { message: 'Processing', uuid: 'request-uuid' },
				});

				assert.strictEqual(await model.mergeStack(new MockRepository(), stack, 'squash', 'direct_merge'), 'pending');
				assert(now.calledTwice);
			});

			it('polls an already-running merge request returned by GitHub', async function () {
				this.timeout(8000);
				const model = createModel();
				const parameters = requestParams(model);
				repo.queryProvider.expectOctokitError(['request'], [`PUT ${route}`, parameters], Object.assign(new Error('Merge already requested'), {
					status: 409,
					response: { data: { status: 'pending', details: { message: 'Processing', uuid: 'existing-uuid' } } },
				}));
				repo.queryProvider.expectOctokitRequest(['request'], [`GET ${route}/{uuid}`, {
					owner: 'github', repo: 'test', pull_number: 794,
					headers: { 'X-GitHub-Api-Version': '2026-03-10' }, uuid: 'existing-uuid',
				}], {
					status: 'enqueued',
					details: { message: 'Added to merge queue' },
				});

				assert.strictEqual(await model.mergeStack(new MockRepository(), stack, 'squash', 'direct_merge'), 'enqueued');
			});

			it('surfaces a failed background merge instead of reporting success', async function () {
				const model = createModel();
				repo.queryProvider.expectOctokitRequest(['request'], [`PUT ${route}`, requestParams(model)], {
					status: 'failed',
					details: { message: 'Required checks failed' },
				});

				await assert.rejects(model.mergeStack(new MockRepository(), stack, 'squash', 'direct_merge'), /Required checks failed/);
			});

			it('refuses to merge a pull request that is no longer open in the stack', async function () {
				const model = createModel();
				const invalidStack: PullRequestStack = { ...stack, pullRequests: [{ ...stack.pullRequests[1], state: GithubItemStateEnum.Merged }] };
				await assert.rejects(model.mergeStack(new MockRepository(), invalidStack, 'squash', 'direct_merge'), /not open in this stack/);
			});

			it('does not submit a merge when the current or a downstack PR is blocked', async function () {
				const model = createModel();
				const blocked = [
					{ ...stack, pullRequests: [stack.pullRequests[0], { ...stack.pullRequests[1], mergeable: PullRequestMergeability.NotMergeable }] },
					...[
						{ mergeable: PullRequestMergeability.Conflict },
						{ mergeable: PullRequestMergeability.Behind },
						{ mergeable: PullRequestMergeability.Unknown },
						{ isDraft: true },
						{ state: GithubItemStateEnum.Closed },
					].map(change => ({
						...stack,
						pullRequests: [{ ...stack.pullRequests[0], ...change }, stack.pullRequests[1]],
					})),
				];

				for (const candidate of blocked) {
					await assert.rejects(model.mergeStack(new MockRepository(), candidate, 'squash', 'direct_merge'), /not ready to merge/);
				}
			});

			it('permits merging when a downstack PR is already merged', async function () {
				const model = createModel();
				const withMergedBelow = {
					...stack,
					pullRequests: [{ ...stack.pullRequests[0], state: GithubItemStateEnum.Merged, mergeable: PullRequestMergeability.Unknown }, stack.pullRequests[1]],
				};
				repo.queryProvider.expectOctokitRequest(['request'], [`PUT ${route}`, requestParams(model)], {
					status: 'merged',
					details: { message: 'Merged', sha: 'merge-sha' },
				});

				assert.strictEqual(await model.mergeStack(new MockRepository(), withMergedBelow, 'squash', 'direct_merge'), 'merged');
			});

			describe('up to a pull request above', function () {
				const wholeStack: PullRequestStack = {
					...stack,
					size: 3,
					pullRequests: [
						...stack.pullRequests,
						{ position: 3, number: 795, title: 'Third', url: '', head: 'D3', state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable },
					],
				};

				function createTopModel(): PullRequestModel {
					const pr = new PullRequestBuilder().number(795).head(head => head.sha('top-head-sha')).build();
					return new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
				}

				it('merges the stack through the top pull request with its head SHA', async function () {
					const model = createModel();
					const top = createTopModel();
					const getPullRequest = sinon.stub(repo, 'getPullRequest').resolves(top);
					const changed = sinon.spy();
					repo.onDidChangeStack(changed);
					repo.queryProvider.expectOctokitRequest(['request'], [`PUT ${route}`, { ...requestParams(model), pull_number: 795, sha: 'top-head-sha' }], {
						status: 'merged',
						details: { message: 'Merged', sha: 'merge-sha' },
					});

					assert.strictEqual(await model.mergeStack(new MockRepository(), wholeStack, 'squash', 'direct_merge', 795), 'merged');
					assert(getPullRequest.calledOnce);
					assert.strictEqual(getPullRequest.firstCall.args[0], 795);
					assert(changed.calledOnceWithExactly([793, 794, 795]));
				});

				it('refuses to merge up to a pull request below this one or outside the stack', async function () {
					const model = createModel();
					for (const upTo of [793, 999]) {
						await assert.rejects(model.mergeStack(new MockRepository(), wholeStack, 'squash', 'direct_merge', upTo), /is not at or above #794/);
					}
				});

				it('does not merge up to a pull request above that is not ready to merge', async function () {
					const model = createModel();
					const getPullRequest = sinon.stub(repo, 'getPullRequest');
					for (const change of [
						{ mergeable: PullRequestMergeability.NotMergeable },
						{ mergeable: PullRequestMergeability.Behind },
						{ isDraft: true },
					]) {
						const candidate = { ...wholeStack, pullRequests: [...stack.pullRequests, { ...wholeStack.pullRequests[2], ...change }] };
						await assert.rejects(model.mergeStack(new MockRepository(), candidate, 'squash', 'direct_merge', 795), /not ready to merge/);
					}
					assert(getPullRequest.notCalled);
				});

				it('asks about local changes when a pull request above is the one checked out', async function () {
					const model = createModel();
					const top = createTopModel();
					top.isActive = true;
					sinon.stub(repo, 'getPullRequest').resolves(top);
					const repository = new MockRepository();
					repository.state.workingTreeChanges.push({
						uri: vscode.Uri.file('/root/file'), originalUri: vscode.Uri.file('/root/file'), renameUri: undefined, status: Status.MODIFIED,
					});
					const warning = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);

					assert.strictEqual(await model.mergeStack(repository, wholeStack, 'squash', 'direct_merge', 795), 'cancelled');
					assert(warning.calledOnce);
				});
			});
		});

		describe('getStackMergeAllTarget', function () {
			const entry = (position: number, change: Partial<PullRequestStack['pullRequests'][number]> = {}): PullRequestStack['pullRequests'][number] => ({
				position, number: 792 + position, title: `Change ${position}`, url: '', head: `D${position}`,
				state: GithubItemStateEnum.Open, isDraft: false, mergeable: PullRequestMergeability.Mergeable, ...change,
			});
			const stackOf = (...pullRequests: PullRequestStack['pullRequests']): PullRequestStack =>
				({ position: 2, size: pullRequests.length, base: 'main', pullRequests });

			it('is the open pull request at the top when every open pull request is ready', function () {
				assert.strictEqual(getStackMergeAllTarget(stackOf(entry(1), entry(2), entry(3), entry(4)), 794)?.number, 796);
				assert.strictEqual(getStackMergeAllTarget(stackOf(entry(1, { state: GithubItemStateEnum.Merged }), entry(2), entry(3)), 794)?.number, 795,
					'merged pull requests below do not block');
				assert.strictEqual(getStackMergeAllTarget(stackOf(entry(1), entry(2), entry(3), entry(4, { state: GithubItemStateEnum.Closed })), 794)?.number, 795,
					'closed pull requests above the top open one are not merged');
			});

			it('is nothing when this is the top or a pull request in the stack is not ready', function () {
				assert.strictEqual(getStackMergeAllTarget(stackOf(entry(1), entry(2)), 794), undefined);
				for (const change of [
					{ isDraft: true },
					{ mergeable: PullRequestMergeability.NotMergeable },
					{ mergeable: PullRequestMergeability.Behind },
					{ mergeable: PullRequestMergeability.Conflict },
					{ state: GithubItemStateEnum.Closed },
				]) {
					assert.strictEqual(getStackMergeAllTarget(stackOf(entry(1), entry(2), entry(3, change), entry(4)), 794), undefined, JSON.stringify(change));
				}
			});
		});

		it('returns no stack when the pull request is not stacked', async function () {
			const model = createModel();
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 794, after: null },
			}, {
				data: { repository: { pullRequest: { stack: null, stackEntry: null } } },
				loading: false,
				stale: false,
				networkStatus: NetworkStatus.ready,
			});

			assert.strictEqual(await model.getStack(), undefined);
		});

		it('reports an incomplete stack page rather than showing a partial stack', async function () {
			const model = createModel();
			const response = stackPage([{ position: 2, number: 794 }], null);
			response.data.repository.pullRequest.stack.entries.pageInfo.hasNextPage = true;
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestStack,
				variables: { owner: 'github', name: 'test', number: 794, after: null },
			}, response);

			await assert.rejects(model.getStack(), /Missing next page of stack/);
		});

		it('loads stacks from GitHub Enterprise when supported', async function () {
			const { enterpriseRepo, model } = createEnterpriseModel();
			try {
				enterpriseRepo.queryProvider.expectGraphQLQuery({
					query: queries.PullRequestStack,
					variables: { owner: 'github', name: 'test', number: 794, after: null },
				}, stackPage([{ position: 2, number: 794 }], null));

				assert.strictEqual((await model.getStack())?.pullRequests[0].number, 794);
			} finally {
				enterpriseRepo.dispose();
			}
		});

		it('uses the normal pull request flow on Enterprise without stack fields, then detects support on retry', async function () {
			const { enterpriseRepo, model } = createEnterpriseModel();
			try {
				const query = sinon.stub(enterpriseRepo, 'query');
				const unsupported = Object.assign(new Error("Field 'stack' doesn't exist on type 'PullRequest'"), {
					graphQLErrors: [{
						extensions: { code: 'undefinedField', typeName: 'PullRequest', fieldName: 'stack' },
					}],
				});
				query.onFirstCall().rejects(unsupported);
				query.onSecondCall().resolves(stackPage([{ position: 2, number: 794 }], null));

				assert.strictEqual(await model.getStack(), undefined);
				assert.strictEqual((await model.getStack())?.pullRequests[0].number, 794);
				assert(query.calledTwice);
			} finally {
				enterpriseRepo.dispose();
			}
		});

		it('does not hide other GraphQL errors while fetching the stack', async function () {
			const { enterpriseRepo, model } = createEnterpriseModel();
			try {
				const error = Object.assign(new Error("Field 'mergeable' doesn't exist on type 'PullRequest'"), {
					graphQLErrors: [{
						extensions: { code: 'undefinedField', typeName: 'PullRequest', fieldName: 'mergeable' },
					}],
				});
				sinon.stub(enterpriseRepo, 'query').rejects(error);

				await assert.rejects(model.getStack(), error);
			} finally {
				enterpriseRepo.dispose();
			}
		});
	});

	describe('stack creation', function () {
		function parentModel() {
			const pr = new PullRequestBuilder().number(795).head(head => head.ref('D3')).build();
			pr.html_url = 'https://github.com/github/test/pull/795';
			pr.head.repo.name = 'test';
			pr.head.repo.owner.login = 'github';
			pr.head.repo.clone_url = 'https://github.com/github/test.git';
			return new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
		}

		const listRoute = 'GET /repos/{owner}/{repo}/stacks';
		const listParams = {
			owner: 'github',
			repo: 'test',
			pull_request: 795,
			per_page: 1,
			headers: { 'X-GitHub-Api-Version': '2026-03-10' },
		};

		it('detects an unstacked parent and creates a new stack with both PRs', async function () {
			const changed = sinon.spy();
			repo.onDidChangeStack(changed);
			sinon.stub(repo, 'getPullRequestForBranch').resolves(parentModel());
			repo.queryProvider.expectOctokitRequest(['request'], [listRoute, listParams], []);
			repo.queryProvider.expectOctokitRequest(['request'], ['POST /repos/{owner}/{repo}/stacks', {
				owner: 'github',
				repo: 'test',
				headers: listParams.headers,
				pull_requests: [795, 796],
			}], { pull_requests: [{ number: 795 }, { number: 796 }] });

			const candidate = await repo.getStackCandidate('D3');
			assert.deepStrictEqual(candidate, { parentPullRequestNumber: 795, size: 1, url: 'https://github.com/github/test/pull/795' });
			assert(candidate);
			assert.deepStrictEqual(await repo.addPullRequestToStack(candidate, 796), [795, 796]);
			assert(changed.calledOnceWithExactly([795, 796]));
		});

		it('creates a stack from multiple existing pull requests in branch order', async function () {
			const candidate = { parentPullRequestNumber: 795, size: 1, url: 'https://github.com/github/test/pull/795' };
			repo.queryProvider.expectOctokitRequest(['request'], ['POST /repos/{owner}/{repo}/stacks', {
				owner: 'github', repo: 'test', headers: listParams.headers, pull_requests: [795, 796, 797],
			}], { pull_requests: [{ number: 795 }, { number: 796 }, { number: 797 }] });

			assert.deepStrictEqual(await repo.addPullRequestsToStack(candidate, [796, 797]), [795, 796, 797]);
		});

		it('extends a stack with multiple existing pull requests in branch order', async function () {
			const changed = sinon.spy();
			repo.onDidChangeStack(changed);
			const candidate = { parentPullRequestNumber: 795, stackNumber: 12, size: 2, url: 'https://github.com/github/test/pull/795' };
			repo.queryProvider.expectOctokitRequest(['request'], ['POST /repos/{owner}/{repo}/stacks/{stack_number}/add', {
				owner: 'github', repo: 'test', headers: listParams.headers, stack_number: 12, pull_requests: [796, 797],
			}], { pull_requests: [{ number: 793 }, { number: 795 }, { number: 796 }, { number: 797 }] });

			assert.deepStrictEqual(await repo.addPullRequestsToStack(candidate, [796, 797]), [793, 795, 796, 797]);
			assert(changed.calledOnceWithExactly([793, 795, 796, 797]));
		});

		it('rejects malformed stack mutation responses instead of returning incomplete membership', async function () {
			const changed = sinon.spy();
			repo.onDidChangeStack(changed);
			const candidate = { parentPullRequestNumber: 795, size: 1, url: 'https://github.com/github/test/pull/795' };
			for (const response of [null, {}, { pull_requests: [] }, { pull_requests: [{ number: 795 }, { number: '796' }] }]) {
				repo.queryProvider.expectOctokitRequest(['request'], ['POST /repos/{owner}/{repo}/stacks', {
					owner: 'github', repo: 'test', headers: listParams.headers, pull_requests: [795, 796],
				}], response);

				await assert.rejects(repo.addPullRequestToStack(candidate, 796), /GitHub returned an invalid/);
			}
			assert(changed.notCalled);
		});

		it('finds the parent from its GraphQL head branch before offering a stack', async function () {
			const parent = new GraphQLPullRequestBuilder().build().repository!.pullRequest;
			parent.number = 795;
			parent.url = 'https://github.com/github/test/pull/795';
			parent.headRefName = 'D3';
			parent.headRef!.name = 'D3';
			parent.headRef!.repository.owner.login = 'github';
			parent.headRef!.repository.url = 'https://github.com/github/test';
			parent.headRepository!.owner.login = 'github';
			parent.headRepository!.url = 'https://github.com/github/test';
			repo.queryProvider.expectGraphQLQuery({
				query: queries.PullRequestForHead,
				variables: { owner: 'github', name: 'test', headRefName: 'D3' },
			}, {
				data: {
					repository: {
						openPullRequests: { nodes: [parent] },
						pullRequests: { nodes: [] },
					},
				},
				loading: false,
				stale: false,
				networkStatus: NetworkStatus.ready,
			});
			repo.queryProvider.expectOctokitRequest(['request'], [listRoute, listParams], []);

			assert.deepStrictEqual(await repo.getStackCandidate('D3'), { parentPullRequestNumber: 795, size: 1, url: 'https://github.com/github/test/pull/795' });
		});

		it('surfaces a failed GraphQL parent lookup rather than treating the branch as unstackable', async function () {
			const error = new Error('GraphQL unavailable');
			sinon.stub(repo, 'query').rejects(error);

			await assert.rejects(repo.getStackCandidate('D3'), candidate => candidate === error);
		});

		it('only offers an existing stack when the parent is at its top', async function () {
			sinon.stub(repo, 'getPullRequestForBranch').resolves(parentModel());
			repo.queryProvider.expectOctokitRequest(['request'], [listRoute, listParams], [{
				number: 12,
				pull_requests: [{ number: 793 }, { number: 795 }],
			}]);
			repo.queryProvider.expectOctokitRequest(['request'], ['POST /repos/{owner}/{repo}/stacks/{stack_number}/add', {
				owner: 'github',
				repo: 'test',
				headers: listParams.headers,
				stack_number: 12,
				pull_requests: [796],
			}], { pull_requests: [{ number: 793 }, { number: 795 }, { number: 796 }] });

			const candidate = await repo.getStackCandidate('D3');
			assert.deepStrictEqual(candidate, { parentPullRequestNumber: 795, stackNumber: 12, size: 2, url: 'https://github.com/github/test/pull/795' });
			assert(candidate);
			assert.deepStrictEqual(await repo.addPullRequestToStack(candidate, 796), [793, 795, 796]);
		});

		it('does not offer a stack when the matching PR is not the top', async function () {
			sinon.stub(repo, 'getPullRequestForBranch').resolves(parentModel());
			repo.queryProvider.expectOctokitRequest(['request'], [listRoute, listParams], [{
				number: 12,
				pull_requests: [{ number: 795 }, { number: 797 }],
			}]);

			assert.strictEqual(await repo.getStackCandidate('D3'), undefined);
		});

		it('does not offer stack creation on servers without the Stacks API', async function () {
			sinon.stub(repo, 'getPullRequestForBranch').resolves(parentModel());
			repo.queryProvider.expectOctokitError(['request'], [listRoute, listParams], Object.assign(new Error('Not Found'), { status: 404 }));

			assert.strictEqual(await repo.getStackCandidate('D3'), undefined);
		});

		it('does not offer stack creation when the requested API version is unsupported', async function () {
			sinon.stub(repo, 'getPullRequestForBranch').resolves(parentModel());
			repo.queryProvider.expectOctokitError(['request'], [listRoute, listParams], Object.assign(new Error('Bad Request'), {
				status: 400,
				response: {
					data: {
						message: 'Bad Request',
						errors: 'The version you specified in the "X-GitHub-API-Version" request header, "2026-03-10", is not a supported version.',
					},
				},
			}));

			assert.strictEqual(await repo.getStackCandidate('D3'), undefined);
		});

		it('recognizes the Enterprise unsupported API version response', async function () {
			sinon.stub(repo, 'getPullRequestForBranch').resolves(parentModel());
			repo.queryProvider.expectOctokitError(['request'], [listRoute, listParams], Object.assign(new Error('Bad Request'), {
				status: 400,
				response: { data: { message: 'The requested API version is not supported' } },
			}));

			assert.strictEqual(await repo.getStackCandidate('D3'), undefined);
		});

		it('does not hide unrelated validation errors as unsupported API versions', async function () {
			sinon.stub(repo, 'getPullRequestForBranch').resolves(parentModel());
			repo.queryProvider.expectOctokitError(['request'], [listRoute, listParams], Object.assign(new Error('Bad Request'), {
				status: 400,
				response: { data: { message: 'Validation failed', errors: 'pull_request must be an integer' } },
			}));

			await assert.rejects(repo.getStackCandidate('D3'), /Bad Request/);
		});

		it('reports failures other than unsupported Stacks API', async function () {
			sinon.stub(repo, 'getPullRequestForBranch').resolves(parentModel());
			repo.queryProvider.expectOctokitError(['request'], [listRoute, listParams], Object.assign(new Error('Forbidden'), { status: 403 }));

			await assert.rejects(repo.getStackCandidate('D3'), /Forbidden/);
		});

		it('does not mistake a pull request from another repository for the base head', async function () {
			const pr = new PullRequestBuilder().number(795).head(head => head.ref('D3')).build();
			pr.head.repo.name = 'other';
			pr.head.repo.owner.login = 'github';
			pr.head.repo.clone_url = 'https://github.com/github/other.git';
			const parent = new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
			sinon.stub(repo, 'getPullRequestForBranch').resolves(parent);

			assert.strictEqual(await repo.getStackCandidate('D3'), undefined);
		});
	});

	describe('unstackAll', function () {
		const headers = { 'X-GitHub-Api-Version': '2026-03-10' };
		const params = { owner: 'github', repo: 'test', headers };
		const listRoute = 'GET /repos/{owner}/{repo}/stacks';
		const unstackRoute = 'POST /repos/{owner}/{repo}/stacks/{stack_number}/unstack';
		const listArgs = [listRoute, { ...params, pull_request: 795, per_page: 1 }];
		const unstackArgs = [unstackRoute, { ...params, stack_number: 12 }];

		it('dissolves a stack when GitHub returns 204', async function () {
			const changed = sinon.spy();
			repo.onDidChangeStack(changed);
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, [{
				number: 12, pull_requests: [{ number: 794 }, { number: 795 }],
			}]);
			repo.queryProvider.expectOctokitRequest(['request'], unstackArgs, undefined, 204);

			assert.deepStrictEqual(await repo.unstackAll(795, [794, 795]), []);
			assert(changed.calledOnceWithExactly([794, 795]));
		});

		it('reports locked PRs remaining after unstacking', async function () {
			const changed = sinon.spy();
			repo.onDidChangeStack(changed);
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, [{
				number: 12, pull_requests: [{ number: 794 }, { number: 795 }],
			}]);
			repo.queryProvider.expectOctokitRequest(['request'], unstackArgs, {
				number: 12, pull_requests: [{ number: 794 }],
			}, 200);

			assert.deepStrictEqual(await repo.unstackAll(795, [794, 795]), [794]);
			assert(changed.calledOnceWithExactly([794, 795]));
		});

		it('does not unstack a different or missing stack', async function () {
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, [{
				number: 12, pull_requests: [{ number: 794 }],
			}]);
			await assert.rejects(repo.unstackAll(795, [794, 795]), /Could not find the stack/);
		});

		for (const { description, numbers } of [
			{ description: 'a different stack', numbers: [796, 795] },
			{ description: 'an added PR', numbers: [794, 795, 796] },
			{ description: 'a removed PR', numbers: [795] },
			{ description: 'reordered PRs', numbers: [795, 794] },
		]) {
			it(`rejects ${description} after confirmation before unstacking`, async function () {
				repo.queryProvider.expectOctokitRequest(['request'], listArgs, [{
					number: 13, pull_requests: numbers.map(number => ({ number })),
				}]);

				await assert.rejects(repo.unstackAll(795, [794, 795]), /stack has changed/);
			});
		}

		it('reports an invalid successful response rather than assuming the stack dissolved', async function () {
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, [{
				number: 12, pull_requests: [{ number: 795 }],
			}]);
			repo.queryProvider.expectOctokitRequest(['request'], unstackArgs, { pull_requests: null }, 200);
			await assert.rejects(repo.unstackAll(795, [795]), /invalid result/);
		});

		it('surfaces an unstack failure rather than reporting success', async function () {
			const changed = sinon.spy();
			repo.onDidChangeStack(changed);
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, [{
				number: 12, pull_requests: [{ number: 795 }],
			}]);
			repo.queryProvider.expectOctokitError(['request'], unstackArgs, new Error('Stack is locked'));

			await assert.rejects(repo.unstackAll(795, [795]), /Stack is locked/);
			assert(changed.notCalled);
		});
	});

	for (const [method, mutationName, responseField, eventName, isDraft] of [
		['convertToDraft', 'ConvertToDraft', 'convertPullRequestToDraft', 'pr.convertToDraft', true],
		['setReadyForReview', 'ReadyForReview', 'markPullRequestReadyForReview', 'pr.readyForReview', false],
	] as const) {
		describe(method, function () {
			let model: PullRequestModel;

			beforeEach(function () {
				const pr = new PullRequestBuilder().draft!(!isDraft).build();
				model = new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
			});

			afterEach(function () {
				model.dispose();
			});

			it('updates state and notifies listeners after a successful mutation', async function () {
				const mutate = sinon.stub(repo, 'mutate').resolves({
					data: {
						[responseField]: {
							pullRequest: {
								isDraft,
								mergeable: 'CONFLICTING',
								mergeStateStatus: 'DIRTY',
								viewerCanEnableAutoMerge: true,
								viewerCanDisableAutoMerge: false,
							},
						},
					},
				});
				const onDidChange = sinon.spy();
				context.subscriptions.push(model.onDidChange(onDidChange));
				const success = sinon.spy(telemetry, 'sendTelemetryEvent');
				const failure = sinon.spy(telemetry, 'sendTelemetryErrorEvent');

				const result = await model[method]();

				assert.deepStrictEqual(mutate.firstCall.args[0], {
					mutation: repo.schema[mutationName],
					variables: { input: { pullRequestId: model.graphNodeId } },
				});
				assert.strictEqual(result.isDraft, isDraft);
				assert.strictEqual(model.isDraft, isDraft);
				assert.strictEqual(result.mergeable, PullRequestMergeability.Conflict);
				assert.strictEqual(model.item.mergeable, result.mergeable);
				if (method === 'setReadyForReview') {
					assert.strictEqual(model.allowAutoMerge, true);
				}
				assert(onDidChange.calledOnceWithExactly({ draft: true }));
				assert(success.calledOnceWithExactly(`${eventName}.success`));
				assert(failure.notCalled);
			});

			for (const [name, response, message] of [
				['missing data', {}, 'GitHub did not return the updated pull request. Please try again.'],
				['null data', { data: null }, 'GitHub did not return the updated pull request. Please try again.'],
				['missing payload', { data: {} }, 'GitHub did not return the updated pull request. Please try again.'],
				['null payload', { data: { [responseField]: null } }, 'GitHub did not return the updated pull request. Please try again.'],
				['null pull request', { data: { [responseField]: { pullRequest: null } } }, 'GitHub did not return the updated pull request. Please try again.'],
				['GraphQL error', {
					data: { [responseField]: null },
					errors: [new GraphQLError('Resource not accessible by integration')],
				}, 'Resource not accessible by integration'],
			] as const) {
				it(`rejects ${name} without changing state or reporting success`, async function () {
					sinon.stub(repo, 'mutate').resolves(response);
					const mergeable = model.item.mergeable;
					const onDidChange = sinon.spy();
					context.subscriptions.push(model.onDidChange(onDidChange));
					const success = sinon.spy(telemetry, 'sendTelemetryEvent');
					const failure = sinon.spy(telemetry, 'sendTelemetryErrorEvent');

					await assert.rejects(model[method](), { message });

					assert.strictEqual(model.isDraft, !isDraft);
					assert.strictEqual(model.item.mergeable, mergeable);
					assert(onDidChange.notCalled);
					assert(success.notCalled);
					assert(failure.calledOnceWithExactly(`${eventName}.failure`));
				});
			}

			it('preserves a rejected mutation error', async function () {
				const error = new Error('Network request failed');
				sinon.stub(repo, 'mutate').rejects(error);

				await assert.rejects(model[method](), candidate => candidate === error);
				assert.strictEqual(model.isDraft, !isDraft);
			});
		});
	}

	describe('REST and GraphQL-only fields', function () {
		it('keeps the known edit permission and mergeability when a REST list response updates the model', function () {
			const pr = new PullRequestBuilder().build();
			const model = new PullRequestModel(credentials, telemetry, repo, remote, {
				...convertRESTPullRequestToRawPullRequest(pr, repo),
				viewerCanUpdate: true,
				mergeable: PullRequestMergeability.Behind,
			});
			context.subscriptions.push(model);
			const onDidChange = sinon.spy();
			context.subscriptions.push(model.onDidChange(onDidChange));

			const { mergeable: _mergeable, ...listItem } = pr;
			model.update(convertRESTPullRequestToRawPullRequest(listItem as unknown as Parameters<typeof convertRESTPullRequestToRawPullRequest>[0], repo));

			assert.strictEqual(model.item.viewerCanUpdate, true);
			assert.strictEqual(model.item.mergeable, PullRequestMergeability.Behind);
			assert(onDidChange.neverCalledWithMatch({ mergeability: true }));
		});

		it('refreshes the edit permission with mergeability', async function () {
			const pr = new PullRequestBuilder().build();
			const model = new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
			context.subscriptions.push(model);
			assert.strictEqual(model.item.viewerCanUpdate, undefined);
			sinon.stub(repo, 'query').resolves({
				data: { repository: { pullRequest: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', viewerCanUpdate: true } } },
			} as any);

			const result = await model.getMergeability();

			assert.strictEqual(result.mergeability, PullRequestMergeability.Mergeable);
			assert.strictEqual(model.item.viewerCanUpdate, true);
		});
	});

	describe('rebaseStack', function () {
		const headers = { 'X-GitHub-Api-Version': '2026-03-10' };
		const listArgs = ['GET /repos/{owner}/{repo}/stacks', { owner: 'github', repo: 'test', headers, pull_request: 795, per_page: 1 }];
		const route = '/repositories/{repository_id}/stacks/{stack_number}/rebase';
		const rebaseParams = { repository_id: 4242, stack_number: 12, headers };
		const putArgs = [`PUT ${route}`, { ...rebaseParams, expected_head_oid_by_pr_number: { 794: 'd1-old', 795: 'd2-old' } }];
		const getArgs = [`GET ${route}`, rebaseParams];
		const stacks = [{
			number: 12,
			pull_requests: [{ number: 794, head: { ref: 'D1', sha: 'd1-old' } }, { number: 795, head: { ref: 'D2', sha: 'd2-old' } }],
		}];
		const before = [{ number: 794, ref: 'D1', sha: 'd1-old' }, { number: 795, ref: 'D2', sha: 'd2-old' }];
		// The responses GitHub returned when rebasing a stack.
		const accepted = { status: 'pending', status_url: 'https://api.github.com/repos/github/test/stacks/12/rebase' };
		const done = (...results: { number: number; status: string; before: string; after: string }[]) => ({
			job_state: 'done',
			pull_requests: results.map(({ number, ...result }) => ({ pull_request_number: number, ...result })),
		});
		const rebasedBoth = done(
			{ number: 794, status: 'succeeded', before: 'd1-old', after: 'd1-new' },
			{ number: 795, status: 'succeeded', before: 'd2-old', after: 'd2-new' },
		);

		beforeEach(function () {
			repo.buildMetadata(repository => repository.id(4242));
		});

		/** Starts a rebase, then lets it poll once. */
		async function rebaseAfterOnePoll() {
			const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
			const rebasing = repo.rebaseStack(795, [794, 795]);
			// Let the request settle so the poll is scheduled, then run it.
			await new Promise(resolve => setImmediate(resolve));
			clock.tick(3000);
			return rebasing;
		}

		it('starts a rebase, polls until it is done, and reports the rebased pull requests', async function () {
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, stacks);
			repo.queryProvider.expectOctokitRequest(['request'], putArgs, accepted, 202);
			repo.queryProvider.expectOctokitRequest(['request'], getArgs, rebasedBoth, 200);

			assert.deepStrictEqual(await rebaseAfterOnePoll(), { status: 'rebased', before, rebasedPullRequests: [794, 795] });
		});

		it('does not report a pull request whose head GitHub did not change', async function () {
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, stacks);
			repo.queryProvider.expectOctokitRequest(['request'], putArgs, accepted, 202);
			repo.queryProvider.expectOctokitRequest(['request'], getArgs, done(
				{ number: 794, status: 'succeeded', before: 'd1-old', after: 'd1-old' },
				{ number: 795, status: 'succeeded', before: 'd2-old', after: 'd2-new' },
			), 200);

			assert.deepStrictEqual((await rebaseAfterOnePoll()).rebasedPullRequests, [795]);
		});

		it('polls a rebase that is already running on GitHub', async function () {
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, stacks);
			repo.queryProvider.expectOctokitError(['request'], putArgs, Object.assign(new Error('Rebase already requested'), {
				status: 409,
				response: { data: accepted },
			}));
			repo.queryProvider.expectOctokitRequest(['request'], getArgs, rebasedBoth, 200);

			assert.deepStrictEqual(await rebaseAfterOnePoll(), { status: 'rebased', before, rebasedPullRequests: [794, 795] });
		});

		it('reports a rebase that is still running after the polling timeout', async function () {
			const now = sinon.stub(Date, 'now');
			now.onFirstCall().returns(0);
			now.onSecondCall().returns(5 * 60 * 1000);
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, stacks);
			repo.queryProvider.expectOctokitRequest(['request'], putArgs, accepted, 202);

			assert.deepStrictEqual(await repo.rebaseStack(795, [794, 795]), { status: 'pending', before });
		});

		it('reports the pull requests GitHub could not rebase instead of reporting success', async function () {
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, stacks);
			repo.queryProvider.expectOctokitRequest(['request'], putArgs, accepted, 202);
			repo.queryProvider.expectOctokitRequest(['request'], getArgs, done(
				{ number: 794, status: 'succeeded', before: 'd1-old', after: 'd1-new' },
				{ number: 795, status: 'conflict', before: 'd2-old', after: 'd2-old' },
			), 200);

			await assert.rejects(rebaseAfterOnePoll(), /could not rebase every pull request in the stack: #795 \(conflict\)\./);
		});

		it('reports an unknown job state instead of assuming the rebase succeeded', async function () {
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, stacks);
			repo.queryProvider.expectOctokitRequest(['request'], putArgs, accepted, 202);
			repo.queryProvider.expectOctokitRequest(['request'], getArgs, { job_state: 'paused', pull_requests: [] }, 200);

			await assert.rejects(rebaseAfterOnePoll(), /unknown stack rebase state: paused/);
		});

		it('reports a finished job without pull request results instead of assuming the rebase succeeded', async function () {
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, stacks);
			repo.queryProvider.expectOctokitRequest(['request'], putArgs, accepted, 202);
			repo.queryProvider.expectOctokitRequest(['request'], getArgs, { job_state: 'done' }, 200);

			await assert.rejects(rebaseAfterOnePoll(), /invalid stack rebase result/);
		});

		it('does not rebase a stack that changed after the user confirmed', async function () {
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, [{ ...stacks[0], pull_requests: [...stacks[0].pull_requests, { number: 796, head: { ref: 'D3', sha: 'd3' } }] }]);

			await assert.rejects(repo.rebaseStack(795, [794, 795]), /stack has changed/);
		});
	});
	describe('openReadonlyChanges', function () {
		const baseCommit = '1111111111111111111111111111111111111111';
		const mergeBase = '2222222222222222222222222222222222222222';
		const headCommit = '3333333333333333333333333333333333333333';

		function createPullRequestModel(): PullRequestModel {
			const pr = new PullRequestBuilder()
				.base(base => base.sha(baseCommit))
				.head(head => head.sha(headCommit))
				.build();
			return new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
		}

		it('uses the git filesystem when the commit range is available locally', async function () {
			const model = createPullRequestModel();
			const oldUri = vscode.Uri.file('C:\\users\\test\\repo\\old.ts');
			const newUri = vscode.Uri.file('C:\\users\\test\\repo\\new.ts');
			const getCommit = sinon.stub().resolves({ hash: '', message: '', parents: [] });
			const getMergeBase = sinon.stub().resolves(mergeBase);
			const diffBetween = sinon.stub().resolves([{
				uri: newUri,
				originalUri: oldUri,
				renameUri: newUri,
				status: Status.INDEX_RENAMED,
			}]);
			const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves();
			const folderManager = {
				repository: { getCommit, getMergeBase, diffBetween },
				telemetry,
			} as unknown as FolderRepositoryManager;

			await PullRequestModel.openReadonlyChanges(folderManager, model, '#1 Readonly changes');

			assert(getMergeBase.calledOnceWithExactly(baseCommit, headCommit));
			assert(diffBetween.calledOnceWithExactly(mergeBase, headCommit));
			const [command, title, entries] = executeCommand.firstCall.args;
			assert.strictEqual(command, 'vscode.changes');
			assert.strictEqual(title, '#1 Readonly changes');
			assert.strictEqual(entries.length, 1);
			const [resourceUri, originalUri, modifiedUri] = entries[0];
			assert.strictEqual(resourceUri.scheme, 'git');
			assert.strictEqual(originalUri.scheme, 'git');
			assert.strictEqual(modifiedUri.scheme, 'git');
			assert.deepStrictEqual(JSON.parse(originalUri.query), { path: oldUri.fsPath, ref: mergeBase });
			assert.deepStrictEqual(JSON.parse(modifiedUri.query), { path: newUri.fsPath, ref: headCommit });
		});

		it('uses GitHub when the commit range is not available locally', async function () {
			const model = createPullRequestModel();
			const getCommit = sinon.stub().rejects(new Error('Unknown commit'));
			const getAllFileChangesInfo = sinon.stub(model, 'getAllFileChangesInfo').resolves({
				changes: [new SlimFileChange(mergeBase, '', GitChangeType.RENAME, 'new.ts', 'old.ts')],
				mergeBase,
			});
			const executeCommand = sinon.stub(vscode.commands, 'executeCommand').resolves();
			const folderManager = {
				repository: { getCommit },
				telemetry,
			} as unknown as FolderRepositoryManager;

			await PullRequestModel.openReadonlyChanges(folderManager, model, '#1 Readonly changes');

			assert(getAllFileChangesInfo.calledOnce);
			const [, title, entries] = executeCommand.firstCall.args;
			assert.strictEqual(title, '#1 Readonly changes');
			const [resourceUri, originalUri, modifiedUri] = entries[0];
			assert.strictEqual(resourceUri.scheme, 'githubcommit');
			assert.strictEqual(originalUri.scheme, 'githubcommit');
			assert.strictEqual(modifiedUri.scheme, 'githubcommit');
			assert.deepStrictEqual(JSON.parse(originalUri.query), {
				commit: mergeBase,
				owner: repo.remote.owner,
				repo: repo.remote.repositoryName,
			});
			assert.deepStrictEqual(JSON.parse(modifiedUri.query), {
				commit: headCommit,
				owner: repo.remote.owner,
				repo: repo.remote.repositoryName,
			});
		});
	});

	describe('reviewThreadCache', function () {
		function page(id: string, endCursor: string | null) {
			return {
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: [{ ...reviewThreadResponse, id }],
								pageInfo: { hasNextPage: endCursor !== null, endCursor },
							},
						},
					},
				},
				loading: false,
				stale: false,
				networkStatus: NetworkStatus.ready,
			};
		}

		it('passes review comment variables to every legacy page', async function () {
			const repository = new GitHubRepository(1, remote, repo.rootUri, credentials, telemetry, true);
			const graphql = sinon.createStubInstance(LoggingApolloClient);
			sinon.stub(credentials, 'isAuthenticated').returns(true);
			sinon.stub(repository, 'hub').get(() => ({ graphql, octokit: sinon.createStubInstance(LoggingOctokit) }));
			sinon.stub(repository, 'ensure').resolves(repository);
			graphql.query.onCall(0).rejects(new Error('Unsupported query'));
			graphql.query.onCall(1).resolves(page('1', 'first'));
			const gatewayError = Object.assign(new Error('Bad Gateway'), { networkError: { statusCode: 502 } });
			graphql.query.onCall(2).rejects(gatewayError);
			graphql.query.onCall(3).rejects(gatewayError);
			graphql.query.onCall(4).rejects(new Error('Unsupported query'));
			graphql.query.onCall(5).resolves(page('2', null));

			try {
				const pr = new PullRequestBuilder().build();
				const model = new PullRequestModel(credentials, telemetry, repository, remote, convertRESTPullRequestToRawPullRequest(pr, repository));
				const threads = await model.getReviewThreads();

				assert.deepStrictEqual(threads.map(thread => thread.id), ['1', '2']);
				assert.strictEqual(graphql.query.callCount, 6);
				for (const [call, after, first] of [[graphql.query.secondCall, null, 20], [graphql.query.lastCall, 'first', 5]] as const) {
					const [fallback] = call.args;
					assert.strictEqual(fallback.query, repository.schema.LegacyPullRequestComments);
					assert.deepStrictEqual(fallback.variables, {
						owner: remote.owner, name: remote.repositoryName, number: pr.number, first, after,
					});
				}
			} finally {
				repository.dispose();
			}
		});

		it('retries gateway failures with smaller pages without losing the cursor', async function () {
			const pr = new PullRequestBuilder().build();
			const model = new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
			const gatewayError = Object.assign(new Error('Bad Gateway'), { networkError: { statusCode: 502 } });
			const query = sinon.stub(repo, 'query');
			query.onCall(0).resolves(page('1', 'first'));
			query.onCall(1).rejects(gatewayError);
			query.onCall(2).rejects(gatewayError);
			query.onCall(3).resolves(page('2', 'second'));
			query.onCall(4).resolves(page('3', null));

			const threads = await model.getReviewThreads();

			assert.deepStrictEqual(threads.map(thread => thread.id), ['1', '2', '3']);
			assert.deepStrictEqual(query.getCalls().map(call => call.args[0].variables), [
				{ owner: remote.owner, name: remote.repositoryName, number: pr.number, first: 20, after: null },
				{ owner: remote.owner, name: remote.repositoryName, number: pr.number, first: 20, after: 'first' },
				{ owner: remote.owner, name: remote.repositoryName, number: pr.number, first: 5, after: 'first' },
				{ owner: remote.owner, name: remote.repositoryName, number: pr.number, first: 1, after: 'first' },
				{ owner: remote.owner, name: remote.repositoryName, number: pr.number, first: 1, after: 'second' },
			]);
		});

		for (const [statusCode, pageSizes] of [[502, [20, 5, 1]], [403, [20]]] as const) {
			it(`stops retrying review comments after HTTP ${statusCode}`, async function () {
				const pr = new PullRequestBuilder().build();
				const model = new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
				const query = sinon.stub(repo, 'query').rejects(Object.assign(new Error('Request failed'), {
					networkError: { statusCode },
				}));

				assert.deepStrictEqual(await model.getReviewThreads(), []);
				assert.deepStrictEqual(query.getCalls().map(call => call.args[0].variables?.first), [...pageSizes]);
			});
		}

		it('reports missing review data without retrying', async function () {
			const pr = new PullRequestBuilder().build();
			const model = new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
			const query = sinon.stub(repo, 'query').resolves({
				data: null, loading: false, stale: false, networkStatus: NetworkStatus.error,
			});
			const error = sinon.stub(Logger, 'error');

			assert.deepStrictEqual(await model.getReviewThreads(), []);
			assert.strictEqual(query.callCount, 1);
			assert.strictEqual(error.lastCall.args[0], 'Failed to get pull request review comments: Error: Review comments response did not include a repository.');
		});

		it('should update the cache when then cache is initialized', async function () {
			const pr = new PullRequestBuilder().build();
			const model = new PullRequestModel(
				credentials,
				telemetry,
				repo,
				remote,
				convertRESTPullRequestToRawPullRequest(pr, repo),
			);

			repo.queryProvider.expectGraphQLQuery(
				{
					query: queries.PullRequestComments,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						number: pr.number,
					},
				},
				{
					data: {
						repository: {
							pullRequest: {
								reviewThreads: {
									nodes: [
										reviewThreadResponse
									],
									pageInfo: {
										hasNextPage: false
									}
								},
							},
						},
					},
					loading: false,
					stale: false,
					networkStatus: NetworkStatus.ready,
				},
			);

			const onDidChangeReviewThreads = sinon.spy();
			model.onDidChangeReviewThreads(onDidChangeReviewThreads);

			await model.initializeReviewThreadCache();

			assert.strictEqual(Object.keys(model.reviewThreadsCache).length, 1);
			assert(onDidChangeReviewThreads.calledOnce);
			assert.strictEqual(onDidChangeReviewThreads.getCall(0).args[0]['added'].length, 1);
			assert.strictEqual(onDidChangeReviewThreads.getCall(0).args[0]['changed'].length, 0);
			assert.strictEqual(onDidChangeReviewThreads.getCall(0).args[0]['removed'].length, 0);
		});
	});
});
