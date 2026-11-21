/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import { GitApiImpl } from '../../api/api1';
import { toGitHubCommitUri } from '../../common/uri';
import { CredentialStore } from '../../github/credentials';
import { GitHubRepository } from '../../github/githubRepository';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { GitHubCommitFileSystemProvider } from '../../view/githubFileContentProvider';

describe('GitHubCommitFileSystemProvider', function () {
	let sandbox: SinonSandbox;

	beforeEach(function () {
		sandbox = createSandbox();
	});

	afterEach(function () {
		sandbox.restore();
	});

	it('reads from a registered repository without a workspace repository manager', async function () {
		const credentialStore = {
			isAnyAuthenticated: () => true,
		} as unknown as CredentialStore;
		const provider = new GitHubCommitFileSystemProvider(
			{} as RepositoriesManager,
			{} as GitApiImpl,
			credentialStore,
		);
		const content = new TextEncoder().encode('content');
		const getFile = sandbox.stub().resolves(content);
		const repository = {
			remote: {
				owner: 'Owner',
				repositoryName: 'Repo',
			},
			getFile,
		} as unknown as GitHubRepository;
		provider.registerGitHubRepository(repository);

		const result = await provider.readFile(toGitHubCommitUri('file.ts', {
			commit: 'commit',
			owner: 'owner',
			repo: 'repo',
		}));

		assert.deepStrictEqual(result, content);
		assert.strictEqual(getFile.calledOnceWithExactly('/file.ts', 'commit'), true);
	});
});
