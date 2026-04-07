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
import { AuthProvider, GitHubServerType } from '../../common/authentication';

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

	describe('query reauthentication', function () {
		it('recreates credentials and retries when a query returns 401 Unauthorized', async function () {
			const url = 'https://github.enterprise.horse/some/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.Enterprise);
			const rootUri = Uri.file('C:\\users\\test\\repo');
			const repository = new GitHubRepository(1, remote, rootUri, credentialStore, telemetry, true);
			const queryStub = sinon.stub();
			queryStub.onFirstCall().rejects(new Error('401 Unauthorized'));
			queryStub.onSecondCall().resolves({ data: { ok: true } });
			sinon.stub(credentialStore, 'isAuthenticated').callsFake((authProviderId: AuthProvider) => authProviderId === AuthProvider.githubEnterprise);
			const recreateStub = sinon.stub(credentialStore, 'recreate').resolves({ canceled: false });

			(repository as any)._hub = {
				graphql: {
					query: queryStub,
				},
			};

			const result = await repository.query({
				query: {
					definitions: [{ name: { value: 'RuntimeExpiryTest' } }],
				} as any,
				variables: {},
			} as any);

			assert.deepStrictEqual(result, { data: { ok: true } });
			assert.strictEqual(queryStub.calledTwice, true);
			assert.strictEqual(recreateStub.calledOnce, true);
			assert.strictEqual(recreateStub.firstCall.args[0], 'Your authentication session has lost authorization. You need to sign in again to regain authorization.');
		});
	});
});
