/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';

import { FolderRepositoryManager, titleAndBodyFrom } from '../../github/folderRepositoryManager';
import { MockRepository } from '../mocks/mockRepository';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { MockCommandRegistry } from '../mocks/mockCommandRegistry';
import { PullRequestModel } from '../../github/pullRequestModel';
import { GitHubRemote, Remote } from '../../common/remote';
import { Protocol } from '../../common/protocol';
import { GitHubRepository } from '../../github/githubRepository';
import { PullRequestBuilder } from '../builders/rest/pullRequestBuilder';
import { convertRESTPullRequestToRawPullRequest } from '../../github/utils';
import { GitApiImpl } from '../../api/api1';
import { CredentialStore } from '../../github/credentials';
import { MockExtensionContext } from '../mocks/mockExtensionContext';
import { Uri } from 'vscode';
import { GitHubServerType } from '../../common/authentication';

describe('PullRequestManager', function () {
	let sinon: SinonSandbox;
	let manager: FolderRepositoryManager;
	let telemetry: MockTelemetry;

	beforeEach(function () {
		sinon = createSandbox();
		MockCommandRegistry.install(sinon);

		telemetry = new MockTelemetry();
		const repository = new MockRepository();
		const context = new MockExtensionContext();
		const credentialStore = new CredentialStore(telemetry, context);
		manager = new FolderRepositoryManager(0, context, repository, telemetry, new GitApiImpl(), credentialStore);
	});

	afterEach(function () {
		sinon.restore();
	});

	describe('activePullRequest', function () {
		it('gets and sets the active pull request', function () {
			assert.strictEqual(manager.activePullRequest, undefined);

			const changeFired = sinon.spy();
			manager.onDidChangeActivePullRequest(changeFired);

			const url = 'https://github.com/aaa/bbb.git';
			const protocol = new Protocol(url);
			const remote = new GitHubRemote('origin', url, protocol, GitHubServerType.GitHubDotCom);
			const rootUri = Uri.file('C:\\users\\test\\repo');
			const repository = new GitHubRepository(remote, rootUri, manager.credentialStore, telemetry);
			const prItem = convertRESTPullRequestToRawPullRequest(new PullRequestBuilder().build(), repository);
			const pr = new PullRequestModel(manager.credentialStore, telemetry, repository, remote, prItem);

			manager.activePullRequest = pr;
			assert(changeFired.called);
			assert.deepStrictEqual(manager.activePullRequest, pr);
		});
	});
});

describe('titleAndBodyFrom', function () {
	it('separates title and body', async function () {
		const message = Promise.resolve('title\n\ndescription 1\n\ndescription 2\n');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, 'description 1\n\ndescription 2');
	});

	it('returns only title with no body', async function () {
		const message = Promise.resolve('title');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '');
	});

	it('returns only title when body contains only whitespace', async function () {
		const message = Promise.resolve('title\n\n');

		const result = await titleAndBodyFrom(message);
		assert.strictEqual(result?.title, 'title');
		assert.strictEqual(result?.body, '');
	});
});
