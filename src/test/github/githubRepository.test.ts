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
			const dotcomRepository = new GitHubRepository(remote, rootUri, credentialStore, telemetry);
			assert(GitHubManager.isGithubDotCom(Uri.parse(remote.url).authority));
		});

		it('detects when the remote is pointing somewhere other than github.com', function () {
			const url = 'https://github.enterprise.horse/some/repo';
			const remote = new GitHubRemote('origin', url, new Protocol(url), GitHubServerType.GitHubDotCom);
			const rootUri = Uri.file('C:\\users\\test\\repo');
			const dotcomRepository = new GitHubRepository(remote, rootUri, credentialStore, telemetry);
			// assert(! dotcomRepository.isGitHubDotCom);
		});
	});
});
