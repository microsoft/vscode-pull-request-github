/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubRepository } from '../github/githubRepository';
import { PullRequestModel } from '../github/pullRequestModel';

export abstract class CommentControllerBase {
	constructor(
		protected _folderRepoManager: FolderRepositoryManager
	) { }

	protected _commentController: vscode.CommentController;

	public get commentController(): vscode.CommentController {
		return this._commentController;
	}

	protected githubReposForPullRequest(pullRequest: undefined): undefined;
	protected githubReposForPullRequest(pullRequest: PullRequestModel): GitHubRepository[];
	protected githubReposForPullRequest(pullRequest: PullRequestModel | undefined): GitHubRepository[] | undefined;
	protected githubReposForPullRequest(pullRequest: PullRequestModel | undefined): GitHubRepository[] | undefined {
		const githubRepositories = pullRequest ? [pullRequest.githubRepository] : undefined;
		if (githubRepositories && pullRequest?.head) {
			const headRepo = this._folderRepoManager.findExistingGitHubRepository({ owner: pullRequest.head.owner, repositoryName: pullRequest.remote.repositoryName });
			if (headRepo) {
				githubRepositories.push(headRepo);
			}
		}
		return githubRepositories;
	}
}