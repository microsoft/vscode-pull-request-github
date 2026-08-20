/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { NetworkStatus } from 'apollo-boost';
import { SinonSandbox, createSandbox } from 'sinon';
import { CredentialStore } from '../../github/credentials';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { GitHubRemote, Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { GitHubRepository } from '../../github/githubRepository';
import { Uri } from 'vscode';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { GitHubManager } from '../../authentication/githubServer';
import { GitHubServerType } from '../../common/authentication';
import { CheckState, PullRequestCheckStatus } from '../../github/interface';
import { PullRequestBuilder as GraphQLPullRequestBuilder } from '../builders/graphql/pullRequestBuilder';
import Logger from '../../common/logger';
import { LoggingApolloClient, LoggingOctokit } from '../../github/loggingOctokit';

describe('GitHubRepository', function () {
	let sinon: SinonSandbox;
	let credentialStore: CredentialStore;
	let telemetry: MockTelemetry;
	let context: MockExtensionContext;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		telemetry = new MockTelemetry();
		context = new MockExtensionContext();
		credentialStore = new CredentialStore(telemetry, context);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('query', function () {
		for (const replacement of [undefined, { owner: 'other', name: 'repo', number: 2, first: 20 }]) {
			it(`uses ${replacement ? 'replacement' : 'original'} variables for a legacy fallback`, async function () {
				const url = 'https://github.com/some/repo';
				const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
				const repo = new GitHubRepository(1, remote, Uri.file('/workspaces/repo'), credentialStore, telemetry, true);
				const graphql = sinon.createStubInstance(LoggingApolloClient);
				sinon.stub(credentialStore, 'isAuthenticated').returns(true);
				sinon.stub(repo, 'hub').get(() => ({ graphql, octokit: sinon.createStubInstance(LoggingOctokit) }));
				const variables = { owner: 'some', name: 'repo', number: 1, first: 20, after: 'cursor' };
				const response = { data: {}, loading: false, stale: false, networkStatus: NetworkStatus.ready };
				graphql.query.onFirstCall().rejects(new Error('Bad Gateway'));
				graphql.query.onSecondCall().resolves(response);

				try {
					const result = await repo.query({ query: repo.schema.PullRequestComments, variables }, false, {
						query: repo.schema.LegacyPullRequestComments,
						variables: replacement,
					});

					assert.strictEqual(result, response);
					assert.strictEqual(graphql.query.callCount, 2);
					assert.strictEqual(graphql.query.secondCall.args[0].query, repo.schema.LegacyPullRequestComments);
					assert.deepStrictEqual(graphql.query.secondCall.args[0].variables, replacement ?? variables);
				} finally {
					repo.dispose();
				}
			});
		}
	});

	describe('isGitHubDotCom', function () {
		it('detects when the remote is pointing to github.com', function () {
			const url = 'https://github.com/some/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const rootUri = Uri.file('C:\\users\\test\\repo');
			const dotcomRepository = new GitHubRepository(1, remote, rootUri, credentialStore, telemetry);
			assert(GitHubManager.isGithubDotCom(Uri.parse(remote.url).authority));
		});

		it('detects when the remote is pointing somewhere other than github.com', function () {
			const url = 'https://github.enterprise.horse/some/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const rootUri = Uri.file('C:\\users\\test\\repo');
			const dotcomRepository = new GitHubRepository(1, remote, rootUri, credentialStore, telemetry);
			// assert(! dotcomRepository.isGitHubDotCom);
		});
	});

	describe('resolveRemote', function () {
		beforeEach(function () {
			sinon.stub(credentialStore, 'isAuthenticated').returns(true);
		});

		it('logs and caches an inaccessible repository after a 404', async function () {
			const url = 'https://github.com/some/missing-repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const rootUri = Uri.file('/workspaces/missing-repo');
			const repo = new GitHubRepository(1, remote, rootUri, credentialStore, telemetry, true);
			const metadata = sinon.stub(repo as any, 'getMetadataForRepo').rejects(Object.assign(new Error('Not Found'), { status: 404 }));
			const warn = sinon.stub(Logger, 'warn');

			assert.strictEqual(await repo.resolveRemote(), false);
			assert.strictEqual(await repo.resolveRemote(), false);

			assert.strictEqual(repo.isInaccessible, true);
			assert.strictEqual(metadata.calledOnce, true);
			assert.strictEqual(warn.calledOnce, true);
			assert.strictEqual(
				warn.firstCall.args[0],
				`Repository some/missing-repo from remote origin in workspace folder ${rootUri.fsPath} returned HTTP 404 and will be skipped for this session.`,
			);
		});

		it('does not cache a SAML 404 as inaccessible', async function () {
			const url = 'https://github.com/some/saml-repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const repo = new GitHubRepository(1, remote, Uri.file('/workspaces/saml-repo'), credentialStore, telemetry, true);
			sinon.stub(repo as any, 'getMetadataForRepo').rejects(Object.assign(
				new Error('Resource protected by organization SAML enforcement.'),
				{ status: 404 },
			));

			assert.strictEqual(await repo.resolveRemote(), false);
			assert.strictEqual(repo.isInaccessible, false);
		});
	});

	describe('deduplicateStatusChecks', function () {
		function createStatus(overrides: Partial<PullRequestCheckStatus> & { id: string; context: string }): PullRequestCheckStatus {
			return {
				databaseId: undefined,
				url: undefined,
				avatarUrl: undefined,
				state: CheckState.Success,
				description: null,
				targetUrl: null,
				workflowName: undefined,
				event: undefined,
				isRequired: false,
				isCheckRun: true,
				...overrides,
			};
		}

		function callDeduplicateStatusChecks(repo: GitHubRepository, statuses: PullRequestCheckStatus[]): PullRequestCheckStatus[] {
			return (repo as any).deduplicateStatusChecks(statuses);
		}

		let repo: GitHubRepository;

		beforeEach(function () {
			const url = 'https://github.com/some/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const rootUri = Uri.file('C:\\users\\test\\repo');
			repo = new GitHubRepository(1, remote, rootUri, credentialStore, telemetry);
		});

		it('keeps checks with different events as separate entries', function () {
			const statuses = [
				createStatus({ id: '1', context: 'Build Linux / x86-64', event: 'push', workflowName: 'Build Linux' }),
				createStatus({ id: '2', context: 'Build Linux / x86-64', event: 'pull_request', workflowName: 'Build Linux' }),
			];
			const result = callDeduplicateStatusChecks(repo, statuses);
			assert.strictEqual(result.length, 2);
		});

		it('deduplicates checks with the same name, event, and workflow', function () {
			const statuses = [
				createStatus({ id: '1', context: 'Build Linux / x86-64', event: 'push', workflowName: 'Build Linux', state: CheckState.Success }),
				createStatus({ id: '2', context: 'Build Linux / x86-64', event: 'push', workflowName: 'Build Linux', state: CheckState.Success }),
			];
			const result = callDeduplicateStatusChecks(repo, statuses);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].id, '2'); // higher ID preferred
		});

		it('keeps checks from different workflows as separate entries', function () {
			const statuses = [
				createStatus({ id: '1', context: 'build', event: 'push', workflowName: 'CI' }),
				createStatus({ id: '2', context: 'build', event: 'push', workflowName: 'Nightly' }),
			];
			const result = callDeduplicateStatusChecks(repo, statuses);
			assert.strictEqual(result.length, 2);
		});

		it('prefers pending checks over completed ones during deduplication', function () {
			const statuses = [
				createStatus({ id: '1', context: 'test', event: 'push', workflowName: 'CI', state: CheckState.Success }),
				createStatus({ id: '2', context: 'test', event: 'push', workflowName: 'CI', state: CheckState.Pending }),
			];
			const result = callDeduplicateStatusChecks(repo, statuses);
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].state, CheckState.Pending);
		});

		it('handles status contexts without event or workflowName', function () {
			const statuses = [
				createStatus({ id: '1', context: 'ci/jenkins', isCheckRun: false }),
				createStatus({ id: '2', context: 'ci/travis', isCheckRun: false }),
			];
			const result = callDeduplicateStatusChecks(repo, statuses);
			assert.strictEqual(result.length, 2);
		});
	});

	describe('getPullRequestForBranch', function () {
		it('prefers an open pull request over newer merged pull requests', async function () {
			const url = 'https://github.com/some/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const rootUri = Uri.file('C:\\users\\test\\repo');
			const repo = new GitHubRepository(1, remote, rootUri, credentialStore, telemetry, true);
			const openPullRequest = new GraphQLPullRequestBuilder()
				.repository(repository => repository.pullRequest(pullRequest => pullRequest
					.number(7231)
					.state('OPEN')))
				.build().repository!.pullRequest!;
			const mergedPullRequest = new GraphQLPullRequestBuilder()
				.repository(repository => repository.pullRequest(pullRequest => pullRequest
					.number(7492)
					.state('MERGED')
					.merged(true)))
				.build().repository!.pullRequest!;
			sinon.stub(repo, 'ensure').resolves(repo);
			sinon.stub(repo, 'query').resolves({
				data: {
					repository: {
						openPullRequests: {
							nodes: [openPullRequest],
						},
						pullRequests: {
							nodes: [mergedPullRequest],
						},
					},
				},
			} as never);

			const pullRequest = await repo.getPullRequestForBranch('feature', 'me');

			assert.strictEqual(pullRequest?.number, 7231);
		});
	});

	describe('computeAwaitingApprovalStatuses', function () {
		function callComputeAwaitingApprovalStatuses(
			repo: GitHubRepository,
			checkSuites: any[] | undefined,
			existingStatuses: PullRequestCheckStatus[],
			prUrl: string,
		): PullRequestCheckStatus[] {
			return (repo as any).computeAwaitingApprovalStatuses(checkSuites, existingStatuses, prUrl);
		}

		function createSuite(overrides: Partial<{ status: string; conclusion: string | null; workflowName: string; event: string }>) {
			const { status = 'WAITING', conclusion = null, workflowName, event } = overrides;
			return {
				status,
				conclusion,
				workflowRun: workflowName ? { event: event ?? 'pull_request', workflow: { name: workflowName } } : null,
				app: null,
			};
		}

		let repo: GitHubRepository;

		beforeEach(function () {
			const url = 'https://github.com/some/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const rootUri = Uri.file('C:\\users\\test\\repo');
			repo = new GitHubRepository(1, remote, rootUri, credentialStore, telemetry);
		});

		it('returns nothing when there are no check suites', function () {
			assert.strictEqual(callComputeAwaitingApprovalStatuses(repo, undefined, [], 'url').length, 0);
			assert.strictEqual(callComputeAwaitingApprovalStatuses(repo, [], [], 'url').length, 0);
		});

		it('surfaces a pending status for a waiting workflow', function () {
			const suites = [createSuite({ status: 'WAITING', workflowName: 'CI' })];
			const result = callComputeAwaitingApprovalStatuses(repo, suites, [], 'https://github.com/some/repo/pull/1');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].state, CheckState.Pending);
			assert.strictEqual(result[0].context, 'CI');
			assert.strictEqual(result[0].workflowName, 'CI');
			assert.strictEqual(result[0].targetUrl, 'https://github.com/some/repo/pull/1');
		});

		it('surfaces a pending status for a requested workflow', function () {
			const suites = [createSuite({ status: 'REQUESTED', workflowName: 'CI' })];
			const result = callComputeAwaitingApprovalStatuses(repo, suites, [], 'url');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].state, CheckState.Pending);
		});

		it('ignores suites that have already concluded', function () {
			const suites = [createSuite({ status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI' })];
			assert.strictEqual(callComputeAwaitingApprovalStatuses(repo, suites, [], 'url').length, 0);
		});

		it('ignores suites that are in progress', function () {
			const suites = [createSuite({ status: 'IN_PROGRESS', workflowName: 'CI' })];
			assert.strictEqual(callComputeAwaitingApprovalStatuses(repo, suites, [], 'url').length, 0);
		});

		it('does not duplicate a workflow already represented by an existing status', function () {
			const suites = [createSuite({ status: 'WAITING', workflowName: 'CI' })];
			const existing = [{
				id: '1',
				databaseId: undefined,
				url: undefined,
				avatarUrl: undefined,
				state: CheckState.Success,
				description: null,
				targetUrl: null,
				context: 'CI / build',
				workflowName: 'CI',
				event: 'pull_request',
				isRequired: false,
				isCheckRun: true,
			} as PullRequestCheckStatus];
			assert.strictEqual(callComputeAwaitingApprovalStatuses(repo, suites, existing, 'url').length, 0);
		});

		it('falls back to a generic context when the workflow name is unknown', function () {
			const suites = [createSuite({ status: 'WAITING' })];
			const result = callComputeAwaitingApprovalStatuses(repo, suites, [], 'url');
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].workflowName, undefined);
			assert.ok(result[0].context.length > 0);
		});
	});
});
