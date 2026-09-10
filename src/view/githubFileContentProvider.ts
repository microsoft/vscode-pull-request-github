/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RepositoryFileSystemProvider } from './repositoryFileSystemProvider';
import { GitApiImpl } from '../api/api1';
import { fromGitHubCommitUri } from '../common/uri';
import { CredentialStore } from '../github/credentials';
import { GitHubRepository } from '../github/githubRepository';
import { RepositoriesManager } from '../github/repositoriesManager';

export class GitHubCommitFileSystemProvider extends RepositoryFileSystemProvider {
	private readonly _gitHubRepositories = new Map<string, GitHubRepository>();

	constructor(private readonly repos: RepositoriesManager, gitAPI: GitApiImpl, credentialStore: CredentialStore) {
		super(gitAPI, credentialStore);
	}

	registerGitHubRepository(repository: GitHubRepository): void {
		this._gitHubRepositories.set(this.repositoryKey(repository.remote.owner, repository.remote.repositoryName), repository);
	}

	override async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		await this.waitForAuth();

		const params = fromGitHubCommitUri(uri);
		if (!params) {
			throw new Error(`Invalid GitHub commit URI: ${uri.toString()}`);
		}

		const registeredRepository = this._gitHubRepositories.get(this.repositoryKey(params.owner, params.repo));
		if (registeredRepository) {
			return registeredRepository.getFile(uri.path, params.commit);
		}

		await this.waitForAnyGitHubRepos(this.repos);
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

	private repositoryKey(owner: string, repo: string): string {
		return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
	}
}

let githubCommitFileSystemProvider: GitHubCommitFileSystemProvider | undefined;

export function getGitHubCommitFileSystemProvider(initialize?: { reposManager: RepositoriesManager, gitAPI: GitApiImpl, credentialStore: CredentialStore }): GitHubCommitFileSystemProvider | undefined {
	if (!githubCommitFileSystemProvider && initialize) {
		githubCommitFileSystemProvider = new GitHubCommitFileSystemProvider(initialize.reposManager, initialize.gitAPI, initialize.credentialStore);
	}
	return githubCommitFileSystemProvider;
}