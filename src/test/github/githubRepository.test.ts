/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
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
});
