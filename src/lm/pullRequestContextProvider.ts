/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestModel } from '../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { RepositoriesManager } from '../github/repositoriesManager';
import { PrsTreeModel } from '../view/prsTreeModel';

interface PRChatContextItem extends vscode.ChatContextItem {
	pr: PullRequestModel;
}

export class PullRequestContextProvider implements vscode.ChatContextProvider {
	constructor(private readonly _prsTreeModel: PrsTreeModel,
		private readonly _reposManager: RepositoriesManager
	) { }

	async provideChatContextForResource(_options: { resource: vscode.Uri }, _token: vscode.CancellationToken): Promise<PRChatContextItem | undefined> {
		const item = PullRequestOverviewPanel.currentPanel?.getCurrentItem();
		if (item) {
			return this._prToUnresolvedContext(item);
		}
	}

	async resolveChatContext(context: PRChatContextItem, _token: vscode.CancellationToken): Promise<vscode.ChatContextItem> {
		context.value = await this._resolvedPrValue(context.pr);
		context.modelDescription = 'All the information about the GitHub pull request the user is viewing, including comments, review threads, and changes.';
		return context;
	}

	async provideChatContextExplicit(_token: vscode.CancellationToken): Promise<PRChatContextItem[] | undefined> {
		const prs = await this._prsTreeModel.getAllPullRequests(this._reposManager.folderManagers[0], false);
		return prs.items.map(pr => {
			return this._prToUnresolvedContext(pr);
		});
	}

	private _prToUnresolvedContext(pr: PullRequestModel): PRChatContextItem {
		return {
			icon: new vscode.ThemeIcon('git-pull-request'),
			label: `#${pr.number} ${pr.title}`,
			modelDescription: 'The GitHub pull request the user is viewing.',
			pr,
		};
	}

	private async _resolvedPrValue(pr: PullRequestModel): Promise<string> {
		return JSON.stringify({
			prNumber: pr.number,
			owner: pr.remote.owner,
			repo: pr.remote.repositoryName,
			title: pr.title,
			body: pr.body,
			comments: pr.comments.map(comment => ({
				author: comment.user?.login,
				body: comment.body,
				createdAt: comment.createdAt
			})),
			threads: (pr.reviewThreadsCache ?? await pr.getReviewThreads()).map(thread => ({
				comments: thread.comments.map(comment => ({
					author: comment.user?.login,
					body: comment.body,
					createdAt: comment.createdAt
				})),
				isResolved: thread.isResolved
			})),
			changes: (pr.rawFileChanges ?? await pr.getRawFileChangesInfo()).map(change => {
				return change.patch;
			})
		});
	}
}