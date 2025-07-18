/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitApiImpl } from '../api/api1';
import { fromGitHubCommitUri } from '../common/uri';
import { CredentialStore } from '../github/credentials';
import { RepositoriesManager } from '../github/repositoriesManager';
import { RepositoryFileSystemProvider } from './repositoryFileSystemProvider';

export class GitHubCommitFileSystemProvider extends RepositoryFileSystemProvider {
	constructor(private readonly repos: RepositoriesManager, gitAPI: GitApiImpl, credentialStore: CredentialStore) {
		super(gitAPI, credentialStore);
	}

	override async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		await this.waitForAuth();
		await this.waitForAnyGitHubRepos(this.repos);

		const params = fromGitHubCommitUri(uri);
		if (!params) {
			throw new Error(`Invalid GitHub commit URI: ${uri.toString()}`);
		}

		const folderManager = this.repos.getManagerForRepository(params.owner, params.repo);
		if (!folderManager) {
			throw new Error(`Repository not found for owner: ${params.owner}, repo: ${params.repo}`);
		}

		const githubRepo = await folderManager.createGitHubRepositoryFromOwnerName(params.owner, params.repo);
		if (!githubRepo) {
			throw new Error(`GitHub repository not found for owner: ${params.owner}, repo: ${params.repo}`);
		}

		return githubRepo.getFile(uri.path, params.commit);
	}
}