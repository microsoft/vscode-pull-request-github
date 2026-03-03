/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RemoteInfo } from '../../common/types';
import { COPILOT_ACCOUNTS } from '../common/comment';
import { copilotEventToStatus, CopilotPRStatus } from '../common/copilot';
import { Disposable, disposeAll } from '../common/lifecycle';
import Logger from '../common/logger';
import { DEV_MODE, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { getReviewMode } from '../common/settingsUtils';
import { ITelemetry } from '../common/telemetry';
import { createPRNodeIdentifier } from '../common/uri';
import { FolderRepositoryManager, ItemsResponseResult } from '../github/folderRepositoryManager';
import { PullRequestChangeEvent } from '../github/githubRepository';
import { CheckState, PRType, PullRequestChecks, PullRequestReviewRequirement } from '../github/interface';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { extractRepoFromQuery, UnsatisfiedChecks } from '../github/utils';
import { CategoryTreeNode } from './treeNodes/categoryNode';
import { TreeNode } from './treeNodes/treeNode';
import { CodingAgentPRAndStatus, CopilotStateModel, getCopilotQuery } from '../github/copilotPrWatcher';

export const EXPANDED_QUERIES_STATE = 'expandedQueries';

export interface PRStatusChange {
	pullRequest: PullRequestModel;
	status: UnsatisfiedChecks;
}

interface CachedPRs {
	clearRequested: boolean;
	maxKnownPR: number | undefined; // used to determine if there have been new PRs created since last query
	items: ItemsResponseResult<PullRequestModel>;
}

export class PrsTreeModel extends Disposable {
	private static readonly ID = 'PrsTreeModel';

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
	// For ease of finding which PRs we know about
	private _allCachedPRs: Set<PullRequestModel> = new Set();

	private readonly _repoEvents: Map<FolderRepositoryManager, vscode.Disposable[]> = new Map();
	private _getPullRequestsForQueryLock: Promise<void> = Promise.resolve();
	private _sentNoRepoTelemetry: boolean = false;

	public readonly copilotStateModel: CopilotStateModel;
	private readonly _onDidChangeCopilotStates = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeCopilotStates = this._onDidChangeCopilotStates.event;
	private readonly _onDidChangeCopilotNotifications = this._register(new vscode.EventEmitter<PullRequestModel[]>());
	readonly onDidChangeCopilotNotifications = this._onDidChangeCopilotNotifications.event;

	constructor(private _telemetry: ITelemetry, private readonly _reposManager: RepositoriesManager, private readonly _context: vscode.ExtensionContext) {
		super();
		this.copilotStateModel = new CopilotStateModel();
		this._register(this.copilotStateModel.onDidChangeCopilotStates(() => this._onDidChangeCopilotStates.fire()));
		this._register(this.copilotStateModel.onDidChangeCopilotNotifications((prs) => this._onDidChangeCopilotNotifications.fire(prs)));

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
			const stateChanged: PullRequestChangeEvent[] = [];
			const needsRefresh: PullRequestChangeEvent[] = [];
			for (const pr of prs) {
				if (pr.event.state) {
					stateChanged.push(pr);
				}
				needsRefresh.push(pr);
			}
			this.forceClearQueriesContainingPullRequests(stateChanged);
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

		this._register(this._reposManager.onDidChangeAnyGitHubRepository((folderManager) => {
			this._onDidChangeData.fire(folderManager);
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

	public forceClearCache() {
		this._cachedPRs.clear();
		this._allCachedPRs.clear();
		this._onDidChangeData.fire();
	}

	public hasPullRequest(pr: PullRequestModel): boolean {
		return this._allCachedPRs.has(pr);
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

	private _clearOneCache(folderRepoManager: FolderRepositoryManager, query: string | PRType.LocalPullRequest | PRType.All) {
		const cache = this.getFolderCache(folderRepoManager);
		if (cache.has(query)) {
			const cachedForQuery = cache.get(query);
			if (cachedForQuery) {
				cachedForQuery.clearRequested = true;
			}
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
		prs.forEach(pr => this._allCachedPRs.add(pr));

		/* __GDPR__
			"pr.expand.local" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.expand.local');
		// Don't await this._getChecks. It fires an event that will be listened to.
		this._getChecks(prs);
		this.hasLoaded = true;
		return { hasMorePages: false, hasUnsearchedRepositories: false, items: prs };
	}

	private async _testIfRefreshNeeded(cached: CachedPRs, query: string, folderManager: FolderRepositoryManager): Promise<boolean> {
		if (!cached.clearRequested) {
			return false;
		}

		const repoInfo = await extractRepoFromQuery(folderManager, query);
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

	async getPullRequestsForQuery(folderRepoManager: FolderRepositoryManager, fetchNextPage: boolean, query: string, fetchOnePagePerRepo: boolean = false): Promise<ItemsResponseResult<PullRequestModel>> {
		let release: () => void;
		const lock = new Promise<void>(resolve => { release = resolve; });
		const prev = this._getPullRequestsForQueryLock;
		this._getPullRequestsForQueryLock = prev.then(() => lock);
		await prev;

		try {
			let maxKnownPR: number | undefined;
			const cache = this.getFolderCache(folderRepoManager);
			const cachedPRs = cache.get(query)!;
			if (!fetchNextPage && cache.has(query)) {
				const shouldRefresh = await this._testIfRefreshNeeded(cache.get(query)!, query, folderRepoManager);
				maxKnownPR = cachedPRs.maxKnownPR;
				if (!shouldRefresh) {
					cachedPRs.clearRequested = false;
					return cachedPRs.items;
				}
			}

			if (!maxKnownPR) {
				const repoInfo = await extractRepoFromQuery(folderRepoManager, query);
				if (repoInfo) {
					maxKnownPR = await this._getMaxKnownPR(repoInfo);
				}
			}

			const prs = await folderRepoManager.getPullRequests(
				PRType.Query,
				{ fetchNextPage, fetchOnePagePerRepo },
				query,
			);
			if (fetchNextPage) {
				prs.items = cachedPRs?.items.items.concat(prs.items) ?? prs.items;
			}
			cache.set(query, { clearRequested: false, items: prs, maxKnownPR });
			prs.items.forEach(pr => this._allCachedPRs.add(pr));

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
		const allCache = cache.get(PRType.All);
		if (!update && allCache && !allCache.clearRequested && !fetchNextPage) {
			return allCache.items;
		}

		const prs = await folderRepoManager.getPullRequests(
			PRType.All,
			{ fetchNextPage }
		);
		if (fetchNextPage) {
			prs.items = allCache?.items.items.concat(prs.items) ?? prs.items;
		}
		cache.set(PRType.All, { clearRequested: false, items: prs, maxKnownPR: undefined });
		prs.items.forEach(pr => this._allCachedPRs.add(pr));

		/* __GDPR__
			"pr.expand.all" : {}
		*/
		this._telemetry.sendTelemetryEvent('pr.expand.all');
		// Don't await this._getChecks. It fires an event that will be listened to.
		this._getChecks(prs.items);
		this.hasLoaded = true;
		return prs;
	}

	private forceClearQueriesContainingPullRequests(pullRequests: PullRequestChangeEvent[]): void {
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
					const cachedForQuery = queries.get(queryKey);
					if (cachedForQuery) {
						cachedForQuery.items.items.forEach(item => this._allCachedPRs.delete(item));
					}
					queries.delete(queryKey);
				}
			}
		}
	}

	getCopilotNotificationsCount(owner: string, repo: string): number {
		return this.copilotStateModel.getNotificationsCount(owner, repo);
	}

	get copilotNotificationsCount(): number {
		return this.copilotStateModel.notifications.size;
	}

	clearAllCopilotNotifications(owner?: string, repo?: string): void {
		this.copilotStateModel.clearAllNotifications(owner, repo);
	}

	clearCopilotNotification(owner: string, repo: string, pullRequestNumber: number): void {
		this.copilotStateModel.clearNotification(owner, repo, pullRequestNumber);
	}

	hasCopilotNotification(owner: string, repo: string, pullRequestNumber?: number): boolean {
		if (pullRequestNumber !== undefined) {
			const key = this.copilotStateModel.makeKey(owner, repo, pullRequestNumber);
			return this.copilotStateModel.notifications.has(key);
		} else {
			const partialKey = this.copilotStateModel.makeKey(owner, repo);
			return Array.from(this.copilotStateModel.notifications.keys()).some(key => {
				return key.startsWith(partialKey);
			});
		}
	}

	getCopilotStateForPR(owner: string, repo: string, prNumber: number): CopilotPRStatus {
		return this.copilotStateModel.get(owner, repo, prNumber);
	}

	getCopilotCounts(owner: string, repo: string): { total: number; inProgress: number; error: number } {
		return this.copilotStateModel.getCounts(owner, repo);
	}

	clearCopilotCaches() {
		const copilotQuery = getCopilotQuery();
		if (!copilotQuery) {
			return false;
		}
		for (const folderManager of this._reposManager.folderManagers) {
			this._clearOneCache(folderManager, copilotQuery);
		}
	}

	private _getStateChangesPromise: Promise<boolean> | undefined;
	async refreshCopilotStateChanges(clearCache: boolean = false): Promise<boolean> {
		// Skip Copilot PR status fetching if dev mode is enabled
		const devMode = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(DEV_MODE, false);
		if (devMode) {
			return false;
		}

		// Return the existing in-flight promise if one exists
		if (this._getStateChangesPromise) {
			return this._getStateChangesPromise;
		}

		if (clearCache) {
			this.clearCopilotCaches();
		}

		// Create and store the in-flight promise, and ensure it's cleared when done
		this._getStateChangesPromise = (async () => {
			try {
				const unseenKeys: Set<string> = new Set(this.copilotStateModel.keys());
				let initialized = 0;

				const copilotQuery = getCopilotQuery();
				if (!copilotQuery) {
					return false;
				}

				const changes: CodingAgentPRAndStatus[] = [];
				for (const folderManager of this._reposManager.folderManagers) {
					initialized++;
					const items: PullRequestModel[] = [];
					let hasMore = true;
					do {
						const prs = await this.getPullRequestsForQuery(folderManager, !this.copilotStateModel.isInitialized, copilotQuery, true);
						items.push(...prs.items);
						hasMore = prs.hasMorePages;
					} while (hasMore);

					for (const pr of items) {
						unseenKeys.delete(this.copilotStateModel.makeKey(pr.remote.owner, pr.remote.repositoryName, pr.number));
						const copilotEvents = await pr.getCopilotTimelineEvents(false, !this.copilotStateModel.isInitialized);
						let latestEvent = copilotEventToStatus(copilotEvents[copilotEvents.length - 1]);
						if (latestEvent === CopilotPRStatus.None) {
							if (!COPILOT_ACCOUNTS[pr.author.login]) {
								continue;
							}
							latestEvent = CopilotPRStatus.Started;
						}
						const lastStatus = this.copilotStateModel.get(pr.remote.owner, pr.remote.repositoryName, pr.number) ?? CopilotPRStatus.None;
						if (latestEvent !== lastStatus) {
							changes.push({ item: pr, status: latestEvent });
						}
					}
				}
				for (const key of unseenKeys) {
					this.copilotStateModel.deleteKey(key);
				}
				this.copilotStateModel.set(changes);
				if (!this.copilotStateModel.isInitialized) {
					if ((initialized === this._reposManager.folderManagers.length) && (this._reposManager.folderManagers.length > 0)) {
						Logger.debug(`Copilot PR state initialized with ${this.copilotStateModel.keys().length} PRs`, PrsTreeModel.ID);
						this.copilotStateModel.setInitialized();
					}
					return true;
				} else {
					return true;
				}
			} finally {
				// Ensure the stored promise is cleared so subsequent calls start a new run
				this._getStateChangesPromise = undefined;
			}
		})();

		return this._getStateChangesPromise;
	}

	async getCopilotPullRequests(clearCache: boolean = false): Promise<CodingAgentPRAndStatus[]> {
		if (clearCache) {
			this.clearCopilotCaches();
		}

		await this.refreshCopilotStateChanges(clearCache);
		return this.copilotStateModel.all;
	}

	override dispose() {
		super.dispose();
		disposeAll(Array.from(this._activePRDisposables.values()).flat());
	}

}