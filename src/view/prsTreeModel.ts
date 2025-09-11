/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RemoteInfo } from '../../common/types';
import { Disposable, disposeAll } from '../common/lifecycle';
import { getReviewMode } from '../common/settingsUtils';
import { ITelemetry } from '../common/telemetry';
import { createPRNodeIdentifier } from '../common/uri';
import { FolderRepositoryManager, ItemsResponseResult } from '../github/folderRepositoryManager';
import { PullRequestChangeEvent } from '../github/githubRepository';
import { CheckState, PRType, PullRequestChecks, PullRequestReviewRequirement } from '../github/interface';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { UnsatisfiedChecks, variableSubstitution } from '../github/utils';
import { CategoryTreeNode } from './treeNodes/categoryNode';
import { TreeNode } from './treeNodes/treeNode';

export const EXPANDED_QUERIES_STATE = 'expandedQueries';

interface PRStatusChange {
	pullRequest: PullRequestModel;
	status: UnsatisfiedChecks;
}

interface CachedPRs {
	clearRequested: boolean;
	maxKnownPR: number | undefined; // used to determine if there have been new PRs created since last query
	items: ItemsResponseResult<PullRequestModel>;
}

export class PrsTreeModel extends Disposable {
	private _activePRDisposables: Map<FolderRepositoryManager, vscode.Disposable[]> = new Map();
	private readonly _onDidChangePrStatus: vscode.EventEmitter<string[]> = this._register(new vscode.EventEmitter<string[]>());
	public readonly onDidChangePrStatus = this._onDidChangePrStatus.event;
	private readonly _onDidChangeData: vscode.EventEmitter<PullRequestChangeEvent[] | FolderRepositoryManager | void> = this._register(new vscode.EventEmitter<PullRequestChangeEvent[] | FolderRepositoryManager | void>());
	public readonly onDidChangeData = this._onDidChangeData.event;
	private _expandedQueries: Set<string> | undefined;
	private _hasLoaded: boolean = false;
	private _onLoaded: vscode.EventEmitter<void> = this._register(new vscode.EventEmitter<void>());
	public readonly onLoaded = this._onLoaded.event;

	// Key is identifier from createPRNodeUri
	private readonly _queriedPullRequests: Map<string, PRStatusChange> = new Map();

	private _cachedPRs: Map<FolderRepositoryManager, Map<string | PRType.LocalPullRequest | PRType.All, CachedPRs>> = new Map();
	private readonly _repoEvents: Map<FolderRepositoryManager, vscode.Disposable[]> = new Map();
	private _getPullRequestsForQueryLock: Promise<void> = Promise.resolve();
	private _sentNoRepoTelemetry: boolean = false;

	constructor(private _telemetry: ITelemetry, private readonly _reposManager: RepositoriesManager, private readonly _context: vscode.ExtensionContext) {
		super();
		const repoEvents = (manager: FolderRepositoryManager) => {
			if (this._repoEvents.has(manager)) {
				disposeAll(this._repoEvents.get(manager)!);
			} else {
				this._repoEvents.set(manager, []);
			}

			this._repoEvents.get(manager)!.push(manager.onDidChangeActivePullRequest(e => {
				const prs: PullRequestChangeEvent[] = [];
				if (e.old) {
					prs.push({ model: e.old, event: {} });
				}
				if (e.new) {
					prs.push({ model: e.new, event: {} });
				}
				this._onDidChangeData.fire(prs);

				if (this._activePRDisposables.has(manager)) {
					disposeAll(this._activePRDisposables.get(manager)!);
					this._activePRDisposables.delete(manager);
				}
				if (manager.activePullRequest) {
					this._activePRDisposables.set(manager, [
						manager.activePullRequest.onDidChange(e => {
							if (e.comments && manager.activePullRequest) {
								this._onDidChangeData.fire([{ model: manager.activePullRequest, event: e }]);
							}
						})]);
				}
			}));
		};
		this._register({ dispose: () => this._repoEvents.forEach((disposables) => disposeAll(disposables)) });

		for (const manager of this._reposManager.folderManagers) {
			repoEvents(manager);
		}

		this._register(this._reposManager.onDidChangeAnyPullRequests((prs) => {
			const needsRefresh = prs.filter(pr => pr.event.state || pr.event.title || pr.event.body || pr.event.comments || pr.event.draft || pr.event.timeline);
			this.clearQueriesContainingPullRequests(needsRefresh);
			this._onDidChangeData.fire(needsRefresh);
		}));

		this._register(this._reposManager.onDidAddPullRequest(() => {
			if (this._hasLoaded) {
				this._onDidChangeData.fire();
			}
		}));

		this._register(this._reposManager.onDidChangeFolderRepositories((changed) => {
			if (changed.added) {
				repoEvents(changed.added);
				this._onDidChangeData.fire(changed.added);
			}
		}));

		const expandedQueries = this._context.workspaceState.get(EXPANDED_QUERIES_STATE, undefined);
		if (expandedQueries) {
			this._expandedQueries = new Set(expandedQueries);
		}
	}

	public updateExpandedQueries(element: TreeNode, isExpanded: boolean) {
		if (!this._expandedQueries) {
			this._expandedQueries = new Set();
		}
		if ((element instanceof CategoryTreeNode) && element.id) {
			if (isExpanded) {
				this._expandedQueries.add(element.id);
			} else {
				this._expandedQueries.delete(element.id);
			}
			this._context.workspaceState.update(EXPANDED_QUERIES_STATE, Array.from(this._expandedQueries.keys()));
		}
	}

	get expandedQueries(): Set<string> | undefined {
		if (this._reposManager.folderManagers.length > 3 && this._expandedQueries && this._expandedQueries.size > 0) {
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

	public clearCache(silent: boolean = false) {
		if (this._cachedPRs.size === 0) {
			return;
		}

		// Instead of clearing the entire cache, mark each cached query as requiring refresh.
		for (const queries of this._cachedPRs.values()) {
			for (const [, cachedPRs] of queries.entries()) {
				if (cachedPRs) {
					cachedPRs.clearRequested = true;
				}
			}
		}

		if (!silent) {
			this._onDidChangeData.fire();
		}
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

	private getFolderCache(folderRepoManager: FolderRepositoryManager): Map<string | PRType.LocalPullRequest | PRType.All, CachedPRs> {
		let cache = this._cachedPRs.get(folderRepoManager);
		if (!cache) {
			cache = new Map();
			this._cachedPRs.set(folderRepoManager, cache);
		}
		return cache;
	}

	async getLocalPullRequests(folderRepoManager: FolderRepositoryManager, update?: boolean): Promise<ItemsResponseResult<PullRequestModel>> {
		const cache = this.getFolderCache(folderRepoManager);
		if (!update && cache.has(PRType.LocalPullRequest)) {
			return cache.get(PRType.LocalPullRequest)!.items;
		}

		const useReviewConfiguration = getReviewMode();

		const prs = (await folderRepoManager.getLocalPullRequests())
			.filter(pr => pr.isOpen || (pr.isClosed && useReviewConfiguration.closed) || (pr.isMerged && useReviewConfiguration.merged));
		const toCache: CachedPRs = {
			clearRequested: false,
			maxKnownPR: undefined,
			items: { hasMorePages: false, hasUnsearchedRepositories: false, items: prs, totalCount: prs.length }
		};
		cache.set(PRType.LocalPullRequest, toCache);

		/* __GDPR__
			"pr.expand.local" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.expand.local');
		// Don't await this._getChecks. It fires an event that will be listened to.
		this._getChecks(prs);
		this.hasLoaded = true;
		return { hasMorePages: false, hasUnsearchedRepositories: false, items: prs };
	}

	private async _extractRepoFromQuery(folderManager: FolderRepositoryManager, query: string): Promise<RemoteInfo | undefined> {
		if (!query) {
			return undefined;
		}

		const defaults = await folderManager.getPullRequestDefaults();
		const substituted = await variableSubstitution(query, undefined, defaults, (await folderManager.getCurrentUser()).login);

		const repoRegex = /(?:^|\s)repo:(?:"?(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)"?)/i;
		const repoMatch = repoRegex.exec(substituted);
		if (repoMatch && repoMatch.groups) {
			return { owner: repoMatch.groups.owner, repositoryName: repoMatch.groups.repo };
		}

		return undefined;
	}

	private async _testIfRefreshNeeded(cached: CachedPRs, query: string, folderManager: FolderRepositoryManager): Promise<boolean> {
		if (!cached.clearRequested) {
			return false;
		}

		const repoInfo = await this._extractRepoFromQuery(folderManager, query);
		if (!repoInfo) {
			// Query doesn't specify a repo or org, so always refresh
			// Send telemetry once indicating we couldn't find a repo in the query.
			if (!this._sentNoRepoTelemetry) {
				/* __GDPR__
					"pr.expand.noRepo" : {}
				*/
				this._telemetry.sendTelemetryEvent('pr.expand.noRepo');
				this._sentNoRepoTelemetry = true;
			}
			return true;
		}

		const currentMax = await this._getMaxKnownPR(repoInfo);
		if (currentMax !== cached.maxKnownPR) {
			cached.maxKnownPR = currentMax;
			return true;
		}
		return false;
	}

	private async _getMaxKnownPR(repoInfo: RemoteInfo): Promise<number | undefined> {
		const manager = this._reposManager.getManagerForRepository(repoInfo.owner, repoInfo.repositoryName);
		if (!manager) {
			return;
		}
		const repo = manager.findExistingGitHubRepository({ owner: repoInfo.owner, repositoryName: repoInfo.repositoryName });
		if (!repo) {
			return;
		}
		return repo.getMaxPullRequest();
	}

	async getPullRequestsForQuery(folderRepoManager: FolderRepositoryManager, fetchNextPage: boolean, query: string): Promise<ItemsResponseResult<PullRequestModel>> {
		let release: () => void;
		const lock = new Promise<void>(resolve => { release = resolve; });
		const prev = this._getPullRequestsForQueryLock;
		this._getPullRequestsForQueryLock = prev.then(() => lock);
		await prev;

		try {
			let maxKnownPR: number | undefined;
			const cache = this.getFolderCache(folderRepoManager);
			if (!fetchNextPage && cache.has(query)) {
				const shouldRefresh = await this._testIfRefreshNeeded(cache.get(query)!, query, folderRepoManager);
				const cachedPRs = cache.get(query)!;
				maxKnownPR = cachedPRs.maxKnownPR;
				if (!shouldRefresh) {
					cachedPRs.clearRequested = false;
					return cachedPRs.items;
				}
			}

			if (!maxKnownPR) {
				const repoInfo = await this._extractRepoFromQuery(folderRepoManager, query);
				if (repoInfo) {
					maxKnownPR = await this._getMaxKnownPR(repoInfo);
				}
			}

			const prs = await folderRepoManager.getPullRequests(
				PRType.Query,
				{ fetchNextPage },
				query,
			);
			cache.set(query, { clearRequested: false, items: prs, maxKnownPR });

			/* __GDPR__
				"pr.expand.query" : {}
			*/
			this._telemetry.sendTelemetryEvent('pr.expand.query');
			// Don't await this._getChecks. It fires an event that will be listened to.
			this._getChecks(prs.items);
			this.hasLoaded = true;
			return prs;
		} finally {
			release!();
		}
	}

	async getAllPullRequests(folderRepoManager: FolderRepositoryManager, fetchNextPage: boolean, update?: boolean): Promise<ItemsResponseResult<PullRequestModel>> {
		const cache = this.getFolderCache(folderRepoManager);
		if (!update && cache.has(PRType.All) && !fetchNextPage) {
			return cache.get(PRType.All)!.items;
		}

		const prs = await folderRepoManager.getPullRequests(
			PRType.All,
			{ fetchNextPage }
		);
		cache.set(PRType.All, { clearRequested: false, items: prs, maxKnownPR: undefined });

		/* __GDPR__
			"pr.expand.all" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.expand.all');
		// Don't await this._getChecks. It fires an event that will be listened to.
		this._getChecks(prs.items);
		this.hasLoaded = true;
		return prs;
	}

	private clearQueriesContainingPullRequests(pullRequests: PullRequestChangeEvent[]): void {
		const withStateChange = pullRequests.filter(prChange => prChange.event.state);
		if (!withStateChange || withStateChange.length === 0) {
			return;
		}
		for (const [, queries] of this._cachedPRs.entries()) {
			for (const [queryKey, cachedPRs] of queries.entries()) {
				if (!cachedPRs || !cachedPRs.items.items || cachedPRs.items.items.length === 0) {
					continue;
				}
				const hasPR = withStateChange.some(prChange =>
					cachedPRs.items.items.some(item => item === prChange.model)
				);
				if (hasPR) {
					queries.get(queryKey)!.clearRequested = true;
				}
			}
		}
	}

	override dispose() {
		super.dispose();
		disposeAll(Array.from(this._activePRDisposables.values()).flat());
	}

}