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
import { GithubItemStateEnum, PullRequestMergeability } from '../../github/interface';
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
