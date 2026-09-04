/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import { issueMarkdown } from '../github/markdownUtils';
import { PullRequestModel } from '../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { RepositoriesManager } from '../github/repositoriesManager';
import { PrsTreeModel } from '../view/prsTreeModel';

export interface PRChatContextItem extends vscode.ChatContextItem {
	pr?: PullRequestModel;
}

export namespace PRChatContextItem {
	export function is(item: unknown): item is PRChatContextItem {
		return (item as PRChatContextItem).pr !== undefined;
	}
}

export class PullRequestContextProvider extends Disposable implements vscode.ChatAttachContextProvider<PRChatContextItem>, vscode.ChatTabContextProvider<PRChatContextItem> {
	constructor(private readonly _prsTreeModel: PrsTreeModel,
		private readonly _reposManager: RepositoriesManager,
		private readonly _context: vscode.ExtensionContext
	) {
		super();
	}

	async provideAttachChatContext(_token: vscode.CancellationToken): Promise<PRChatContextItem[]> {
		const prs = await this._prsTreeModel.getAllPullRequests(this._reposManager.folderManagers[0], false);
		return prs.items.map(pr => {
			return this._prToUnresolvedContext(pr);
		});
	}

	async provideChatTabContext(_options: { tab: vscode.Tab; }, _token: vscode.CancellationToken): Promise<PRChatContextItem | undefined> {
		const item = PullRequestOverviewPanel.getActivePanel()?.getCurrentItem();
		if (item) {
			return this._prToUnresolvedContext(item);
		}
	}

	async resolveAttachChatContext(context: PRChatContextItem, token: vscode.CancellationToken): Promise<vscode.ChatContextItem> {
		return this._resolveChatContext(context, token);
	}

	async resolveChatTabContext(context: PRChatContextItem, token: vscode.CancellationToken): Promise<vscode.ChatContextItem> {
		return this._resolveChatContext(context, token);
	}

	private async _resolveChatContext(context: PRChatContextItem, _token: vscode.CancellationToken): Promise<vscode.ChatContextItem> {
		if (!context.pr) {
			return context;
		}
		context.value = await this._resolvedPrValue(context.pr);
		context.modelDescription = 'All the information about the GitHub pull request the user is viewing, including comments, review threads, and changes.';
		context.tooltip = await issueMarkdown(context.pr, this._context, this._reposManager);
		return context;
	}

	private _prToUnresolvedContext(pr: PullRequestModel): PRChatContextItem {
		return {
			iconPath: new vscode.ThemeIcon('git-pull-request'),
			label: `#${pr.number} ${pr.title}`,
			modelDescription: 'The GitHub pull request the user is viewing.',
			tooltip: new vscode.MarkdownString(`#${pr.number} ${pr.title}`),
			pr,
			command: {
				command: 'pr.openDescription',
				title: vscode.l10n.t('Open Pull Request')
			}
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