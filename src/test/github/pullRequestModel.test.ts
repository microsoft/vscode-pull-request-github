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
import { Resource } from '../../common/resources';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { GitHubServerType } from '../../common/authentication';
import { mergeQuerySchemaWithShared } from '../../github/common';
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
		Resource.initialize(context);
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
