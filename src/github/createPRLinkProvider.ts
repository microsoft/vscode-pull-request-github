/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ReviewManager } from '../view/reviewManager';
import { FolderRepositoryManager } from './folderRepositoryManager';

interface GitHubCreateTerminalLink extends vscode.TerminalLink {
	url: string;
}

export class GitHubCreatePullRequestLinkProvider implements vscode.TerminalLinkProvider {

	constructor(private readonly reviewManager: ReviewManager, private readonly folderRepositoryManager: FolderRepositoryManager) { }

	provideTerminalLinks(context: vscode.TerminalLinkContext, token: vscode.CancellationToken): vscode.ProviderResult<GitHubCreateTerminalLink[]> {
		const startIndex = context.line.indexOf('https://github.com');
		if (startIndex === -1) {
			return [];
		}

		/**
		 * When a branch is published, a line like the following is written to the terminal:
		 * remote:      https://github.com/RMacfarlane/pullrequest-demo/pull/new/rmacfarlane/testbranch3
		 */
		const url = context.line.substring(startIndex);
		const regex = new RegExp(/https:\/\/github\.com\/(.*)\/(.*)\/pull\/new\/(.*)/);
		const result = url.match(regex);
		if (result && result.length === 4) {
			const owner = result[1];
			const repositoryName = result[2];
			const branchName = result[3];

			const hasMatchingGitHubRepo = this.folderRepositoryManager.gitHubRepositories
				.findIndex(repo => repo.remote.owner === owner && repo.remote.repositoryName === repositoryName) > -1;

			// The create flow compares against the current branch, so check that the published branch is this branch
			if (hasMatchingGitHubRepo && this.reviewManager.repository.state.HEAD?.name === branchName) {
				return [
					{
						startIndex,
						length: context.line.length - startIndex,
						tooltip: 'Create a Pull Request',
						url
					}
				];
			}
		}

		return [];
	}

	handleTerminalLink(link: GitHubCreateTerminalLink): vscode.ProviderResult<void> {
		vscode.window.showInformationMessage('Do you want to create a pull request using the GitHub Pull Requests and Issues extension?',
			'Yes',
			'No, continue to github.com').then(notificationResult => {
				if (notificationResult === 'Yes') {
					this.reviewManager.createPullRequest();
				} else {
					vscode.env.openExternal(vscode.Uri.parse(link.url));
				}
			});
	}
}