/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { Status } from '../../api/api1';
import { GitChangeType, SlimFileChange } from '../../common/file';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { GithubItemStateEnum, PullRequestMergeability, PullRequestStack } from '../../github/interface';
import { Protocol } from '../../common/protocol';
import { GitHubRemote, Remote } from '../../common/remote';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { SinonSandbox, createSandbox } from 'sinon';
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

	describe('getStack', function () {
		function createModel() {
			const pr = new PullRequestBuilder().number(794).build();
			return new PullRequestModel(credentials, telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(pr, repo));
		}

		function createEnterpriseModel() {
			const enterpriseRemote = new GitHubRemote('enterprise', 'https://enterprise.example.com/github/test', new Protocol('https://enterprise.example.com/github/test'), GitHubServerType.Enterprise);
			const enterpriseRepo = new MockGitHubRepository(enterpriseRemote, credentials, telemetry, sinon);
			const pr = new PullRequestBuilder().number(794).build();
			const model = new PullRequestModel(credentials, telemetry, enterpriseRepo, enterpriseRemote, convertRESTPullRequestToRawPullRequest(pr, enterpriseRepo));
			return { enterpriseRepo, model };
		}

		function stackPage(entries: {
			position: number;
			number: number;
			mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
			mergeStateStatus?: 'CLEAN' | 'BLOCKED' | 'BEHIND' | 'DIRTY' | 'UNKNOWN';
		}[], endCursor: string | null, position = 2) {
			return {
				data: {
					repository: {
						pullRequest: {
							stackEntry: { position },
							stack: {
								size: 3,
								baseRefName: 'main',
								entries: {
									nodes: entries.map(entry => ({
										position: entry.position,
										pullRequest: {
											number: entry.number,
											title: `Change ${entry.number}`,
											url: `https://github.com/github/test/pull/${entry.number}`,
											state: GithubItemStateEnum.Open,
											isDraft: false,
											headRefName: `D${entry.position}`,
											mergeable: entry.mergeable ?? 'MERGEABLE',
											mergeStateStatus: entry.mergeStateStatus ?? 'CLEAN',
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
				repo.queryProvider.expectOctokitRequest(['request'], [`PUT ${route}`, requestParams(model)], {
					status: 'merged',
					details: { message: 'Merged', sha: 'merge-sha' },
				});

				assert.strictEqual(await model.mergeStack(new MockRepository(), stack, 'squash', 'direct_merge'), 'merged');
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
			sinon.stub(repo, 'getPullRequestForBranch').resolves(parentModel());
			repo.queryProvider.expectOctokitRequest(['request'], [listRoute, listParams], []);
			repo.queryProvider.expectOctokitRequest(['request'], ['POST /repos/{owner}/{repo}/stacks', {
				owner: 'github',
				repo: 'test',
				headers: listParams.headers,
				pull_requests: [795, 796],
			}], {});

			const candidate = await repo.getStackCandidate('D3');
			assert.deepStrictEqual(candidate, { parentPullRequestNumber: 795, size: 1, url: 'https://github.com/github/test/pull/795' });
			assert(candidate);
			await repo.addPullRequestToStack(candidate, 796);
		});

		it('creates a stack from multiple existing pull requests in branch order', async function () {
			const candidate = { parentPullRequestNumber: 795, size: 1, url: 'https://github.com/github/test/pull/795' };
			repo.queryProvider.expectOctokitRequest(['request'], ['POST /repos/{owner}/{repo}/stacks', {
				owner: 'github', repo: 'test', headers: listParams.headers, pull_requests: [795, 796, 797],
			}], {});

			await repo.addPullRequestsToStack(candidate, [796, 797]);
		});

		it('extends a stack with multiple existing pull requests in branch order', async function () {
			const candidate = { parentPullRequestNumber: 795, stackNumber: 12, size: 2, url: 'https://github.com/github/test/pull/795' };
			repo.queryProvider.expectOctokitRequest(['request'], ['POST /repos/{owner}/{repo}/stacks/{stack_number}/add', {
				owner: 'github', repo: 'test', headers: listParams.headers, stack_number: 12, pull_requests: [796, 797],
			}], {});

			await repo.addPullRequestsToStack(candidate, [796, 797]);
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
			}], {});

			const candidate = await repo.getStackCandidate('D3');
			assert.deepStrictEqual(candidate, { parentPullRequestNumber: 795, stackNumber: 12, size: 2, url: 'https://github.com/github/test/pull/795' });
			assert(candidate);
			await repo.addPullRequestToStack(candidate, 796);
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
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, [{
				number: 12, pull_requests: [{ number: 794 }, { number: 795 }],
			}]);
			repo.queryProvider.expectOctokitRequest(['request'], unstackArgs, undefined, 204);

			assert.deepStrictEqual(await repo.unstackAll(795, [794, 795]), []);
		});

		it('reports locked PRs remaining after unstacking', async function () {
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, [{
				number: 12, pull_requests: [{ number: 794 }, { number: 795 }],
			}]);
			repo.queryProvider.expectOctokitRequest(['request'], unstackArgs, {
				number: 12, pull_requests: [{ number: 794 }],
			}, 200);

			assert.deepStrictEqual(await repo.unstackAll(795, [794, 795]), [794]);
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
			repo.queryProvider.expectOctokitRequest(['request'], listArgs, [{
				number: 12, pull_requests: [{ number: 795 }],
			}]);
			repo.queryProvider.expectOctokitError(['request'], unstackArgs, new Error('Stack is locked'));

			await assert.rejects(repo.unstackAll(795, [795]), /Stack is locked/);
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

			await PullRequestModel.openReadonlyChanges(folderManager, model);

			assert(getMergeBase.calledOnceWithExactly(baseCommit, headCommit));
			assert(diffBetween.calledOnceWithExactly(mergeBase, headCommit));
			const [command, , entries] = executeCommand.firstCall.args;
			assert.strictEqual(command, 'vscode.changes');
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

			await PullRequestModel.openReadonlyChanges(folderManager, model);

			assert(getAllFileChangesInfo.calledOnce);
			const [, , entries] = executeCommand.firstCall.args;
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
