/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getReviewMode } from '../common/settingsUtils';
import { ITelemetry } from '../common/telemetry';
import { createPRNodeIdentifier } from '../common/uri';
import { dispose } from '../common/utils';
import { FolderRepositoryManager, ItemsResponseResult } from '../github/folderRepositoryManager';
import { CheckState, PRType, PullRequestChecks, PullRequestReviewRequirement } from '../github/interface';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { CategoryTreeNode } from './treeNodes/categoryNode';
import { TreeNode } from './treeNodes/treeNode';

export const EXPANDED_QUERIES_STATE = 'expandedQueries';

export enum UnsatisfiedChecks {
	None = 0,
	ReviewRequired = 1 << 0,
	ChangesRequested = 1 << 1,
	CIFailed = 1 << 2,
	CIPending = 1 << 3
}

interface PRStatusChange {
	pullRequest: PullRequestModel;
	status: UnsatisfiedChecks;
}

export class PrsTreeModel implements vscode.Disposable {
	private readonly _disposables: vscode.Disposable[] = [];
	private _activePRDisposables: Map<FolderRepositoryManager, vscode.Disposable[]> = new Map();
	private readonly _onDidChangePrStatus: vscode.EventEmitter<string[]> = new vscode.EventEmitter();
	public readonly onDidChangePrStatus = this._onDidChangePrStatus.event;
	private readonly _onDidChangeData: vscode.EventEmitter<FolderRepositoryManager | void> = new vscode.EventEmitter();
	public readonly onDidChangeData = this._onDidChangeData.event;
	private _expandedQueries: Set<string> = new Set();
	private _hasLoaded: boolean = false;
	private _onLoaded: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onLoaded = this._onLoaded.event;

	// Key is identifier from createPRNodeUri
	private readonly _queriedPullRequests: Map<string, PRStatusChange> = new Map();

	private _cachedPRs: Map<FolderRepositoryManager, Map<string | PRType.LocalPullRequest | PRType.All, ItemsResponseResult<PullRequestModel>>> = new Map();

	constructor(private _telemetry: ITelemetry, private readonly _reposManager: RepositoriesManager, private readonly _context: vscode.ExtensionContext) {
		const repoEvents = (manager: FolderRepositoryManager) => {
			return [
				manager.onDidChangeActivePullRequest(() => {
					this.clearRepo(manager);
					if (this._activePRDisposables.has(manager)) {
						dispose(this._activePRDisposables.get(manager)!);
						this._activePRDisposables.delete(manager);
					}
					if (manager.activePullRequest) {
						this._activePRDisposables.set(manager, [
							manager.activePullRequest.onDidChangeComments(() => {
								this.clearRepo(manager);
							})]);
					}
				})];
		};

		this._disposables.push(
			...(this._reposManager.folderManagers.map(manager => {
				return repoEvents(manager);
			}).flat()),
		);
		this._disposables.push(this._reposManager.onDidChangeFolderRepositories((changed) => {
			if (changed.added) {
				this._disposables.push(...repoEvents(changed.added));
				this._onDidChangeData.fire(changed.added);
			}
		}));

		this._expandedQueries = new Set(this._context.workspaceState.get(EXPANDED_QUERIES_STATE, [] as string[]));
	}

	public updateExpandedQueries(element: TreeNode, isExpanded: boolean) {
		if (element instanceof CategoryTreeNode) {
			if (isExpanded) {
				this._expandedQueries.add(element.id);
			} else {
				this._expandedQueries.delete(element.id);
			}
			this._context.workspaceState.update(EXPANDED_QUERIES_STATE, Array.from(this._expandedQueries.keys()));
		}
	}

	get expandedQueries(): Set<string> {
		if (this._reposManager.folderManagers.length > 3 && this._expandedQueries.size > 0) {
			return new Set();
		}
		return this._expandedQueries;
	}

	get hasLoaded(): boolean {
		return this._hasLoaded;
	}

	private set hasLoaded(value: boolean) {
		this._hasLoaded = value;
		this._onLoaded.fire();
	}

	public cachedPRStatus(identifier: string): PRStatusChange | undefined {
		return this._queriedPullRequests.get(identifier);
	}

	public clearCache() {
		this._cachedPRs.clear();
		this._onDidChangeData.fire();
	}

	public clearRepo(folderRepoManager: FolderRepositoryManager) {
		this._cachedPRs.delete(folderRepoManager);
		this._onDidChangeData.fire(folderRepoManager);
	}

	private async _getChecks(pullRequests: PullRequestModel[]) {
		// If there are too many pull requests then we could hit our internal rate limit
		// or even GitHub's secondary rate limit. If there are more than 100 PRs,
		// chunk them into 100s.
		let checks: [PullRequestChecks | null, PullRequestReviewRequirement | null][] = [];
		for (let i = 0; i < pullRequests.length; i += 100) {
			const sliceEnd = (i + 100 < pullRequests.length) ? i + 100 : pullRequests.length;
			checks.push(...await Promise.all(pullRequests.slice(i, sliceEnd).map(pullRequest => {
				return pullRequest.getStatusChecks();
			})));
		}

		const changedStatuses: string[] = [];
		for (let i = 0; i < pullRequests.length; i++) {
			const pullRequest = pullRequests[i];
			const [check, reviewRequirement] = checks[i];
			let newStatus: UnsatisfiedChecks = UnsatisfiedChecks.None;

			if (reviewRequirement) {
				if (reviewRequirement.state === CheckState.Failure) {
					newStatus |= UnsatisfiedChecks.ReviewRequired;
				} else if (reviewRequirement.state == CheckState.Pending) {
					newStatus |= UnsatisfiedChecks.ChangesRequested;
				}
			}

			if (!check || check.state === CheckState.Unknown) {
				continue;
			}
			if (check.state !== CheckState.Success) {
				for (const status of check.statuses) {
					if (status.state === CheckState.Failure) {
						newStatus |= UnsatisfiedChecks.CIFailed;
					} else if (status.state === CheckState.Pending) {
						newStatus |= UnsatisfiedChecks.CIPending;
					}
				}
				if (newStatus === UnsatisfiedChecks.None) {
					newStatus |= UnsatisfiedChecks.CIPending;
				}
			}
			const identifier = createPRNodeIdentifier(pullRequest);
			const oldState = this._queriedPullRequests.get(identifier);
			if ((oldState === undefined) || (oldState.status !== newStatus)) {
				const newState = { pullRequest, status: newStatus };
				changedStatuses.push(identifier);
				this._queriedPullRequests.set(identifier, newState);
			}
		}
		this._onDidChangePrStatus.fire(changedStatuses);
	}

	private getFolderCache(folderRepoManager: FolderRepositoryManager): Map<string | PRType.LocalPullRequest | PRType.All, ItemsResponseResult<PullRequestModel>> {
		let cache = this._cachedPRs.get(folderRepoManager);
		if (!cache) {
			cache = new Map();
			this._cachedPRs.set(folderRepoManager, cache);
		}
		return cache;
	}

	async getLocalPullRequests(folderRepoManager: FolderRepositoryManager, update?: boolean) {
		const cache = this.getFolderCache(folderRepoManager);
		if (!update && cache.has(PRType.LocalPullRequest)) {
			return cache.get(PRType.LocalPullRequest)!;
		}

		const useReviewConfiguration = getReviewMode();

		const prs = (await folderRepoManager.getLocalPullRequests())
			.filter(pr => pr.isOpen || (pr.isClosed && useReviewConfiguration.closed) || (pr.isMerged && useReviewConfiguration.merged));
		cache.set(PRType.LocalPullRequest, { hasMorePages: false, hasUnsearchedRepositories: false, items: prs });

		/* __GDPR__
			"pr.expand.local" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.expand.local');
		// Don't await this._getChecks. It fires an event that will be listened to.
		this._getChecks(prs);
		this.hasLoaded = true;
		return { hasMorePages: false, hasUnsearchedRepositories: false, items: prs };
	}

	async getPullRequestsForQuery(folderRepoManager: FolderRepositoryManager, fetchNextPage: boolean, query: string, update?: boolean): Promise<ItemsResponseResult<PullRequestModel>> {
		const cache = this.getFolderCache(folderRepoManager);
		if (!update && cache.has(query)) {
			return cache.get(query)!;
		}

		const prs = await folderRepoManager.getPullRequests(
			PRType.Query,
			{ fetchNextPage },
			query,
		);
		cache.set(query, prs);

		/* __GDPR__
			"pr.expand.query" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.expand.query');
		// Don't await this._getChecks. It fires an event that will be listened to.
		this._getChecks(prs.items);
		this.hasLoaded = true;
		return prs;
	}

	async getAllPullRequests(folderRepoManager: FolderRepositoryManager, fetchNextPage: boolean, update?: boolean): Promise<ItemsResponseResult<PullRequestModel>> {
		const cache = this.getFolderCache(folderRepoManager);
		if (!update && cache.has(PRType.All) && !fetchNextPage) {
			return cache.get(PRType.All)!;
		}

		const prs = await folderRepoManager.getPullRequests(
			PRType.All,
			{ fetchNextPage }
		);
		cache.set(PRType.All, prs);

		/* __GDPR__
			"pr.expand.all" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.expand.all');
		// Don't await this._getChecks. It fires an event that will be listened to.
		this._getChecks(prs.items);
		this.hasLoaded = true;
		return prs;
	}

	dispose() {
		dispose(this._disposables);
		dispose(Array.from(this._activePRDisposables.values()).flat());
	}

}