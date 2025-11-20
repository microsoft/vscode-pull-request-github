/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitApiImpl } from '../api/api1';
import { Disposable } from '../common/lifecycle';
import { onceEvent } from '../common/utils';
import { PullRequestModel } from '../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { RepositoriesManager } from '../github/repositoriesManager';
import { PrsTreeModel } from '../view/prsTreeModel';

interface PRChatContextItem extends vscode.ChatContextItem {
	pr?: PullRequestModel;
}

export class PullRequestContextProvider extends Disposable implements vscode.ChatContextProvider {
	private readonly _onDidChangeWorkspaceChatContext = new vscode.EventEmitter<void>();
	readonly onDidChangeWorkspaceChatContext = this._onDidChangeWorkspaceChatContext.event;

	constructor(private readonly _prsTreeModel: PrsTreeModel,
		private readonly _reposManager: RepositoriesManager,
		private readonly _git: GitApiImpl
	) {
		super();
	}

	/**
	 * Do this setup in the initialize method so that it can be called after the provider is registered.
	 */
	async initialize() {
		if (this._git.state === 'uninitialized') {
			await new Promise<void>(resolve => {
				this._register(onceEvent(this._git.onDidChangeState)(() => resolve()));
			});
		}
		this._reposManager.folderManagers.forEach(folderManager => {
			this._register(folderManager.onDidChangeActivePullRequest(() => {
				this._onDidChangeWorkspaceChatContext.fire();
			}));
		});
		this._register(this._reposManager.onDidChangeFolderRepositories(e => {
			if (!e.added) {
				return;
			}
			this._register(e.added.onDidChangeActivePullRequest(() => {
				this._onDidChangeWorkspaceChatContext.fire();
			}));
			this._onDidChangeWorkspaceChatContext.fire();
		}));
		this._register(this._reposManager.onDidChangeAnyGitHubRepository(() => {
			this._onDidChangeWorkspaceChatContext.fire();
		}));
		this._onDidChangeWorkspaceChatContext.fire();
	}

	async provideChatContextForResource(_options: { resource: vscode.Uri }, _token: vscode.CancellationToken): Promise<PRChatContextItem | undefined> {
		const item = PullRequestOverviewPanel.currentPanel?.getCurrentItem();
		if (item) {
			return this._prToUnresolvedContext(item);
		}
	}

	async resolveChatContext(context: PRChatContextItem, _token: vscode.CancellationToken): Promise<vscode.ChatContextItem> {
		if (!context.pr) {
			return context;
		}
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