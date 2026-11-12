/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { createSandbox } from 'sinon';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { GitHubRepository } from '../../github/githubRepository';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { InMemPRFileSystemProvider } from '../../view/inMemPRContentProvider';

describe('InMemPRFileSystemProvider', function () {
	it('keeps equal PR numbers in different repositories independent when reading and disposing', async function () {
		const sandbox = createSandbox();
		const reposManager = sandbox.createStubInstance(RepositoriesManager);
		const provider = new InMemPRFileSystemProvider(reposManager, undefined!, undefined!);
		const registrations: vscode.Disposable[] = [];
		try {
			const uris = ['repoA', 'repoB'].map(name => {
				const remote = { url: `https://github.com/owner/${name}`, remoteName: 'origin' };
				const pr = { number: 63, remote } as PullRequestModel;
				const manager = sandbox.createStubInstance(FolderRepositoryManager);
				manager.findRepo.callsFake(predicate => {
					const repo = { remote } as GitHubRepository;
					return predicate(repo) ? repo : undefined;
				});
				const uri = vscode.Uri.from({
					scheme: 'pr', path: `/work/${name}/Makefile`,
					query: JSON.stringify({ prNumber: 63, remoteName: 'origin' }),
				});
				reposManager.getManagerForFile.withArgs(uri).returns(manager);
				registrations.push(provider.registerTextDocumentContentProvider(pr, async () => name));
				return uri;
			});
			assert.strictEqual(new TextDecoder().decode(await provider.readFile(uris[0])), 'repoA');
			assert.strictEqual(new TextDecoder().decode(await provider.readFile(uris[1])), 'repoB');
			registrations[0].dispose();
			assert.strictEqual(new TextDecoder().decode(await provider.readFile(uris[1])), 'repoB');
		} finally {
			registrations.forEach(registration => registration.dispose());
			sandbox.restore();
		}
	});
});
