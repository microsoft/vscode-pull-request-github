/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { CredentialStore } from '../../github/credentials';
import { PullRequestModel } from '../../github/pullRequestModel';
import { GithubItemStateEnum } from '../../github/interface';
import { Protocol } from '../../common/protocol';
import { GitHubRemote, Remote } from '../../common/remote';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { SinonSandbox, createSandbox } from 'sinon';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { NetworkStatus } from 'apollo-client';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { GitHubServerType } from '../../common/authentication';
import { mergeQuerySchemaWithShared } from '../../github/common';
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
