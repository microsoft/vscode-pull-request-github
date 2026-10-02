/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { NetworkStatus } from 'apollo-boost';
import { SinonSandbox, createSandbox, match } from 'sinon';
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
import { CheckState, GithubItemStateEnum, PullRequestCheckStatus } from '../../github/interface';
import { PullRequestBuilder as GraphQLPullRequestBuilder } from '../builders/graphql/pullRequestBuilder';
import Logger from '../../common/logger';
import { LoggingApolloClient, LoggingOctokit } from '../../github/loggingOctokit';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { PullRequestModel } from '../../github/pullRequestModel';
import { visit } from 'graphql';
import { parseAccount } from '../../github/utils';

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
		it('does not switch schemas for an unsupported optional stack query', async function () {
			const url = 'https://github.com/some/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const repo = new GitHubRepository(1, remote, Uri.file('/workspaces/repo'), credentialStore, telemetry, true);
			const graphql = sinon.createStubInstance(LoggingApolloClient);
			sinon.stub(credentialStore, 'isAuthenticated').returns(true);
			sinon.stub(repo, 'hub').get(() => ({ graphql, octokit: sinon.createStubInstance(LoggingOctokit) }));
			const error = Object.assign(new Error("Field 'stack' doesn't exist on type 'PullRequest'"), {
				graphQLErrors: [{ extensions: { code: 'undefinedField', typeName: 'PullRequest', fieldName: 'stack' } }],
			});
			graphql.query.rejects(error);

			try {
				await assert.rejects(repo.query({
					query: repo.schema.PullRequestStack,
					variables: { owner: 'some', name: 'repo', number: 1, after: null },
				}, false, undefined, false), candidate => candidate === error);

				assert.strictEqual(repo.areQueriesLimited, false);
				assert.strictEqual(graphql.query.callCount, 1);
			} finally {
				repo.dispose();
			}
		});

		it('replaces variables for a legacy query with different arguments', async function () {
			const url = 'https://github.com/some/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const repo = new GitHubRepository(1, remote, Uri.file('/workspaces/repo'), credentialStore, telemetry, true);
			const graphql = sinon.createStubInstance(LoggingApolloClient);
			sinon.stub(credentialStore, 'isAuthenticated').returns(true);
			sinon.stub(repo, 'hub').get(() => ({ graphql, octokit: sinon.createStubInstance(LoggingOctokit) }));
			const variables = { owner: 'some', name: 'repo', first: 100, after: 'cursor' };
			const response = { data: {}, loading: false, stale: false, networkStatus: NetworkStatus.ready };
			graphql.query.onFirstCall().rejects(new Error('Unsupported query'));
			graphql.query.onSecondCall().resolves(response);

			try {
				const result = await repo.query({
					query: repo.schema.GetSuggestedActors,
					variables: { ...variables, capabilities: ['CAN_BE_ASSIGNED'] },
				}, false, { query: repo.schema.GetAssignableUsers, variables });

				assert.strictEqual(result, response);
				assert.strictEqual(graphql.query.callCount, 2);
				const [fallback] = graphql.query.secondCall.args;
				assert.strictEqual(fallback.query, repo.schema.GetAssignableUsers);
				assert.deepStrictEqual(fallback.variables, variables);
			} finally {
				repo.dispose();
			}
		});
	});

	describe('getPullRequest', function () {
		let repo: MockGitHubRepository;

		beforeEach(function () {
			const url = 'https://github.com/owner/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			repo = new MockGitHubRepository(remote, credentialStore, telemetry, sinon);
		});

		afterEach(function () {
			repo.dispose();
		});

		it('loads a read-only preview without populating the PR model cache', async function () {
			const preview = {
				number: 1347, title: 'Preview', titleHTML: '<strong>Preview</strong>',
				body: 'Description', bodyHTML: '<p>Description</p>', url: 'https://github.com/owner/repo/pull/1347',
				state: GithubItemStateEnum.Open, isDraft: true, createdAt: '2026-10-01T10:00:00Z',
				author: { __typename: 'User', id: 'author', login: 'contributor', url: 'https://github.com/contributor', avatarUrl: '' },
				baseRefName: 'main', headRefName: 'feature',
				baseRepository: { owner: { login: 'owner' } }, headRepository: { owner: { login: 'contributor' } },
			};
			const query = sinon.stub(repo, 'query').resolves({
				data: { repository: { pullRequest: preview } },
				loading: false, stale: false, networkStatus: NetworkStatus.ready,
			});

			const { author, baseRefName, headRefName, baseRepository, headRepository, ...content } = preview;
			assert.deepStrictEqual(await repo.getPullRequestPreview(1347), {
				...content,
				author: parseAccount(author, repo),
				base: 'owner/repo:main',
				head: 'contributor/repo:feature',
			});
			assert.strictEqual(repo.getExistingPullRequestModel(1347), undefined);
			sinon.assert.calledOnce(query);
			assert.strictEqual(query.firstCall.args[0].query, repo.schema.PullRequestPreview);
			assert.deepStrictEqual(query.firstCall.args[0].variables, { owner: 'owner', name: 'repo', number: 1347 });
			const fields: string[] = [];
			visit(repo.schema.PullRequestPreview, { Field(node) { fields.push(node.name.value); } });
			assert.ok(fields.includes('titleHTML') && fields.includes('bodyHTML'));
			for (const field of ['commits', 'suggestedReviewers', 'mergeable', 'mergeStateStatus', 'reactionGroups', 'reviewThreads']) {
				assert.ok(!fields.includes(field), `Preview must not query ${field}`);
			}
			assert.ok(!fields.includes('email'), 'Preview must not require additional user scopes');

			query.resolves({
				data: { repository: { pullRequest: { ...preview, author: null, headRepository: null } } },
				loading: false, stale: false, networkStatus: NetworkStatus.ready,
			});
			const deletedAuthorPreview = await repo.getPullRequestPreview(1347);
			assert.deepStrictEqual(deletedAuthorPreview.author, parseAccount(null, repo));
			assert.strictEqual(deletedAuthorPreview.head, '');
		});

		it('rejects missing previews and invalid preview numbers', async function () {
			const query = sinon.stub(repo, 'query').resolves({
				data: { repository: { pullRequest: null } },
				loading: false, stale: false, networkStatus: NetworkStatus.ready,
			});
			for (const number of [0, -1, NaN, Infinity, 1.5]) {
				await assert.rejects(repo.getPullRequestPreview(number), /Invalid pull request number/);
			}
			sinon.assert.notCalled(query);
			await assert.rejects(repo.getPullRequestPreview(1347), /Unable to load pull request preview/);
			assert.strictEqual(repo.getExistingPullRequestModel(1347), undefined);
		});

		it('loads an overview with only the PR query and reuses its cached model', async function () {
			const data = new GraphQLPullRequestBuilder().build();
			const query = sinon.stub(repo, 'query').resolves({ data, loading: false, stale: false, networkStatus: NetworkStatus.ready });
			const updates = sinon.stub(PullRequestModel.prototype, 'getLastUpdateTime').resolves(new Date());

			const pr = await repo.getPullRequest(1347, 'test', false, false, 'overview');

			assert.ok(pr);
			assert.strictEqual(pr.title, data.repository!.pullRequest.title);
			assert.strictEqual(pr.bodyHTML, data.repository!.pullRequest.bodyHTML);
			sinon.assert.calledOnce(query);
			assert.strictEqual(query.firstCall.args[0].query, repo.schema.PullRequest);
			sinon.assert.notCalled(updates);
			assert.strictEqual(await repo.getPullRequest(1347, 'test', true, false, 'overview'), pr);
			sinon.assert.calledOnce(query);
		});

		it('preserves number validation and update checks for default loads', async function () {
			const query = sinon.stub(repo, 'query').resolves({
				data: new GraphQLPullRequestBuilder().build(),
				loading: false, stale: false, networkStatus: NetworkStatus.ready,
			});
			const maxItemResult = {
				data: { repository: { issues: { edges: [{ node: { number: 1347 } }] } } },
				loading: false, stale: false, networkStatus: NetworkStatus.ready,
			};
			query.withArgs(match.has('query', repo.schema.MaxIssue)).resolves(maxItemResult);
			query.withArgs(match.has('query', repo.schema.MaxPullRequest)).resolves(maxItemResult);
			const updates = sinon.stub(PullRequestModel.prototype, 'getLastUpdateTime').resolves(new Date());

			assert.ok(await repo.getPullRequest(1347, 'test'));

			assert.strictEqual(query.callCount, 3);
			sinon.assert.calledOnce(updates);
		});

		it('rejects invalid overview numbers without a network request', async function () {
			const query = sinon.spy(repo, 'query');
			for (const number of [0, -1, NaN, Infinity, 1.5]) {
				assert.strictEqual(await repo.getPullRequest(number, 'test', false, false, 'overview'), undefined);
			}
			sinon.assert.notCalled(query);
		});

		it('logs a failed overview fetch instead of returning a partial model', async function () {
			sinon.stub(repo, 'query').rejects(new Error('PR unavailable'));
			const logError = sinon.spy(Logger, 'error');

			assert.strictEqual(await repo.getPullRequest(1347, 'test', false, false, 'overview'), undefined);
			assert.strictEqual(logError.firstCall.args[0], 'Unable to fetch PR: Error: PR unavailable');
		});
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

	describe('getMetadata', function () {
		it('retries after a transient failure and caches the successful result', async function () {
			const url = 'https://github.com/some/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const repo = new GitHubRepository(1, remote, Uri.file('/workspaces/repo'), credentialStore, telemetry);
			sinon.stub(repo, 'ensure').resolves(repo);
			const fetchMetadata = sinon.stub(repo as any, 'getMetadataForRepo');
			const error = new Error('Connect Timeout Error');
			const metadata = { name: 'repo', owner: { login: 'some' } };
			fetchMetadata.onFirstCall().rejects(error);
			fetchMetadata.onSecondCall().resolves(metadata);

			await assert.rejects(repo.getMetadata(), candidate => candidate === error);
			assert.strictEqual(await repo.getMetadata(), metadata);
			assert.strictEqual(await repo.getMetadata(), metadata);
			assert.strictEqual(fetchMetadata.callCount, 2);
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
			assert.strictEqual((await repo.getPullRequestForBranch('feature', 'ME'))?.number, 7231);
		});

		it('preserves legacy behavior on lookup errors unless requested by the caller', async function () {
			const url = 'https://github.com/some/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const repo = new GitHubRepository(1, remote, Uri.file('/workspaces/repo'), credentialStore, telemetry, true);
			const error = new Error('GraphQL unavailable');
			sinon.stub(repo, 'ensure').resolves(repo);
			sinon.stub(repo, 'query').rejects(error);

			assert.strictEqual(await repo.getPullRequestForBranch('feature', 'some'), undefined);
			await assert.rejects(repo.getPullRequestForBranch('feature', 'some', true), candidate => candidate === error);
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
