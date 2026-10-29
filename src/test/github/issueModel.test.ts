/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { SinonSandbox, createSandbox } from 'sinon';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { GitHubServerType } from '../../common/authentication';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { OctokitCommon } from '../../github/common';
import { CredentialStore } from '../../github/credentials';
import { GithubItemStateEnum } from '../../github/interface';
import { IssueModel } from '../../github/issueModel';
import { convertRESTPullRequestToRawPullRequest, convertRESTSubIssue } from '../../github/utils';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { MockGitHubRepository } from '../mocks/mockGitHubRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';

const telemetry = new MockTelemetry();
const protocol = new Protocol('https://github.com/github/test.git');
const remote = new GitHubRemote('test', 'github/test', protocol, GitHubServerType.GitHubDotCom);

const restSubIssueSameRepo = {
	id: 101,
	number: 7,
	title: 'open child',
	state: 'open',
	html_url: 'https://github.com/github/test/issues/7',
	repository_url: 'https://api.github.com/repos/github/test',
	assignees: [
		{
			login: 'alice',
			id: 1,
			node_id: 'MDQ6VXNlcjE=',
			avatar_url: 'https://avatars.githubusercontent.com/u/1',
			html_url: 'https://github.com/alice',
			type: 'User',
		},
	],
};

const restSubIssueOtherRepo = {
	id: 102,
	number: 9,
	title: 'closed child',
	state: 'closed',
	html_url: 'https://github.com/other/thing/issues/9',
	repository_url: 'https://api.github.com/repos/other/thing',
	assignees: null,
};

const restParentIssue = {
	id: 99, number: 42, title: 'parent', state: 'open',
	html_url: 'https://github.com/other/thing/issues/42',
	repository_url: 'https://api.github.com/repos/other/thing',
	assignees: [],
};

describe('IssueModel sub-issues', function () {
	let sinon: SinonSandbox;
	let credentials: CredentialStore;
	let repo: MockGitHubRepository;
	let context: MockExtensionContext;
	let issue: IssueModel;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		context = new MockExtensionContext();
		credentials = new CredentialStore(telemetry, context);
		repo = new MockGitHubRepository(remote, credentials, telemetry, sinon);
		issue = new IssueModel(telemetry, repo, remote, convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().number(1000).build(), repo));
	});

	afterEach(function () {
		repo.dispose();
		context.dispose();
		credentials.dispose();
		sinon.restore();
	});

	it('getSubIssues maps the REST response', async function () {
		repo.queryProvider.expectOctokitRequest(
			['issues', 'listSubIssues'],
			[{ owner: 'github', repo: 'test', issue_number: 1000, per_page: 100, page: 1 }],
			[restSubIssueSameRepo, restSubIssueOtherRepo],
		);

		const subIssues = await issue.getSubIssues();

		assert.strictEqual(subIssues.length, 2);
		assert.strictEqual(subIssues[0].number, 7);
		assert.strictEqual(subIssues[0].title, 'open child');
		assert.strictEqual(subIssues[0].state, GithubItemStateEnum.Open);
		assert.strictEqual(subIssues[0].url, 'https://github.com/github/test/issues/7');
		assert.strictEqual(subIssues[0].owner, 'github');
		assert.strictEqual(subIssues[0].repo, 'test');
		assert.deepStrictEqual(subIssues[0].assignees.map(a => a.login), ['alice']);

		assert.strictEqual(subIssues[1].number, 9);
		assert.strictEqual(subIssues[1].state, GithubItemStateEnum.Closed);
		assert.strictEqual(subIssues[1].url, 'https://github.com/other/thing/issues/9');
		assert.strictEqual(subIssues[1].owner, 'other');
		assert.strictEqual(subIssues[1].repo, 'thing');
		assert.deepStrictEqual(subIssues[1].assignees, []);
	});

	it('getSubIssues returns [] when the endpoint is unavailable', async function () {
		repo.queryProvider.expectOctokitError(
			['issues', 'listSubIssues'],
			[{ owner: 'github', repo: 'test', issue_number: 1000, per_page: 100, page: 1 }],
			Object.assign(new Error('Not Found'), { status: 404 }),
		);

		assert.deepStrictEqual(await issue.getSubIssues(), []);
	});

	it('getParentIssue maps the REST response', async function () {
		repo.queryProvider.expectOctokitRequest(
			['request'],
			['GET /repos/{owner}/{repo}/issues/{issue_number}/parent', { owner: 'github', repo: 'test', issue_number: 1000 }],
			restParentIssue,
		);

		const result = await issue.getParentIssue();

		assert.strictEqual(result?.number, 42);
		assert.strictEqual(result?.owner, 'other');
		assert.strictEqual(result?.repo, 'thing');
		assert.strictEqual(result?.state, GithubItemStateEnum.Open);
	});

	it('getParentIssue returns undefined when issue has no parent', async function () {
		repo.queryProvider.expectOctokitError(
			['request'],
			['GET /repos/{owner}/{repo}/issues/{issue_number}/parent', { owner: 'github', repo: 'test', issue_number: 1000 }],
			Object.assign(new Error('No parent issue found'), { status: 404 }),
		);

		const result = await issue.getParentIssue();

		assert.strictEqual(result, undefined);
	});

	it('convertRESTSubIssue parses GHES repository_url', function () {
		const subIssue = convertRESTSubIssue({
			...restSubIssueSameRepo,
			repository_url: 'https://ghe.example.com/api/v3/repos/o/r',
		} as OctokitCommon.IssuesListSubIssuesResponseData[number], repo);

		assert.strictEqual(subIssue.owner, 'o');
		assert.strictEqual(subIssue.repo, 'r');
	});
});
