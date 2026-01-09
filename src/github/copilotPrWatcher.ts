/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GithubItemStateEnum } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { PullRequestOverviewPanel } from './pullRequestOverview';
import { RepositoriesManager } from './repositoriesManager';
import { debounce } from '../common/async';
import { COPILOT_ACCOUNTS } from '../common/comment';
import { COPILOT_LOGINS, copilotEventToStatus, CopilotPRStatus } from '../common/copilot';
import { Disposable } from '../common/lifecycle';
import { DEV_MODE, PR_SETTINGS_NAMESPACE, QUERIES } from '../common/settingKeys';
import { PrsTreeModel } from '../view/prsTreeModel';

export function isCopilotQuery(query: string): boolean {
	const lowerQuery = query.toLowerCase();
	return COPILOT_LOGINS.some(login => lowerQuery.includes(`author:${login.toLowerCase()}`));
}

export function getCopilotQuery(): string | undefined {
	const queries = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<{ label: string; query: string }[]>(QUERIES, []);
	return queries.find(query => isCopilotQuery(query.query))?.query;
}

export interface CodingAgentPRAndStatus {
	item: PullRequestModel;
	status: CopilotPRStatus;
}

export class CopilotStateModel extends Disposable {
	public static ID = 'CopilotStateModel';
	private _isInitialized = false;
	private readonly _states: Map<string, CodingAgentPRAndStatus> = new Map();
	private readonly _showNotification: Set<string> = new Set();
	private readonly _onDidChangeStates = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeCopilotStates = this._onDidChangeStates.event;
	private readonly _onDidChangeNotifications = this._register(new vscode.EventEmitter<PullRequestModel[]>());
	readonly onDidChangeCopilotNotifications = this._onDidChangeNotifications.event;

	makeKey(owner: string, repo: string, prNumber?: number): string {
		if (prNumber === undefined) {
			return `${owner}/${repo}`;
		}
		return `${owner}/${repo}#${prNumber}`;
	}

	deleteKey(key: string): void {
		if (this._states.has(key)) {
			const item = this._states.get(key)!;
			this._states.delete(key);
			if (this._showNotification.has(key)) {
				this._showNotification.delete(key);
				this._onDidChangeNotifications.fire([item.item]);
			}
			this._onDidChangeStates.fire();
		}
	}

	set(statuses: CodingAgentPRAndStatus[]): void {
		const changedModels: PullRequestModel[] = [];
		const changedKeys: string[] = [];
		for (const { item, status } of statuses) {
			const key = this.makeKey(item.remote.owner, item.remote.repositoryName, item.number);
			const currentStatus = this._states.get(key);
			if (currentStatus?.status === status) {
				continue;
			}
			this._states.set(key, { item, status });
			if ((currentStatus?.status === CopilotPRStatus.Started)) {
				continue;
			}
			changedModels.push(item);
			changedKeys.push(key);
		}
		if (changedModels.length > 0) {
			if (this._isInitialized) {
				changedKeys.forEach(key => this._showNotification.add(key));
				this._onDidChangeNotifications.fire(changedModels);
			}
			this._onDidChangeStates.fire();
		}
	}

	get(owner: string, repo: string, prNumber: number): CopilotPRStatus {
		const key = this.makeKey(owner, repo, prNumber);
		return this._states.get(key)?.status ?? CopilotPRStatus.None;
	}

	keys(): string[] {
		return Array.from(this._states.keys());
	}

	clearNotification(owner: string, repo: string, prNumber: number): void {
		const key = this.makeKey(owner, repo, prNumber);
		if (this._showNotification.has(key)) {
			this._showNotification.delete(key);
			const item = this._states.get(key)?.item;
			if (item) {
				this._onDidChangeNotifications.fire([item]);
			}
		}
	}

	clearAllNotifications(owner?: string, repo?: string): void {
		if (this._showNotification.size > 0) {
			const items: PullRequestModel[] = [];

			// If owner and repo are specified, only clear notifications for that repo
			if (owner && repo) {
				const keysToRemove: string[] = [];
				const prefix = `${this.makeKey(owner, repo)}#`;
				for (const key of this._showNotification.keys()) {
					if (key.startsWith(prefix)) {
						const item = this._states.get(key)?.item;
						if (item) {
							items.push(item);
						}
						keysToRemove.push(key);
					}
				}
				keysToRemove.forEach(key => this._showNotification.delete(key));
			} else {
				// Clear all notifications
				for (const key of this._showNotification.keys()) {
					const item = this._states.get(key)?.item;
					if (item) {
						items.push(item);
					}
				}
				this._showNotification.clear();
			}

			if (items.length > 0) {
				this._onDidChangeNotifications.fire(items);
			}
		}
	}

	get notifications(): ReadonlySet<string> {
		return this._showNotification;
	}

	getNotificationsCount(owner: string, repo: string): number {
		let total = 0;
		const partialKey = `${this.makeKey(owner, repo)}#`;
		for (const state of this._showNotification.values()) {
			if (state.startsWith(partialKey)) {
				total++;
			}
		}
		return total;
	}

	setInitialized() {
		this._isInitialized = true;
	}

	get isInitialized(): boolean {
		return this._isInitialized;
	}

	getCounts(owner: string, repo: string): { total: number; inProgress: number; error: number } {
		let inProgressCount = 0;
		let errorCount = 0;

		for (const state of this._states.values()) {
			if (state.item.remote.owner !== owner || state.item.remote.repositoryName !== repo) {
				continue;
			}
			if (state.status === CopilotPRStatus.Started) {
				inProgressCount++;
			} else if (state.status === CopilotPRStatus.Failed) {
				errorCount++;
			}
		}

		return {
			total: this._states.size,
			inProgress: inProgressCount,
			error: errorCount
		};
	}

	get all(): CodingAgentPRAndStatus[] {
		return Array.from(this._states.values());
	}
}

export class CopilotPRWatcher extends Disposable {
	private readonly _model: CopilotStateModel;

	constructor(private readonly _reposManager: RepositoriesManager, private readonly _prsTreeModel: PrsTreeModel) {
		super();
		this._model = _prsTreeModel.copilotStateModel;
		if (this._reposManager.folderManagers.length === 0) {
			const initDisposable = this._reposManager.onDidChangeAnyGitHubRepository(() => {
				initDisposable.dispose();
				this._initialize();
			});
		} else {
			this._initialize();
		}
	}

	private _initialize() {
		this._prsTreeModel.refreshCopilotStateChanges(true);
		this._pollForChanges();
		const updateFullState = debounce(() => this._prsTreeModel.refreshCopilotStateChanges(true), 50);
		this._register(this._reposManager.onDidChangeAnyPullRequests(e => {
			if (e.some(pr => COPILOT_ACCOUNTS[pr.model.author.login])) {
				if (!this._model.isInitialized) {
					return;
				}
				if (e.some(pr => this._model.get(pr.model.remote.owner, pr.model.remote.repositoryName, pr.model.number) === CopilotPRStatus.None)) {
					// A PR we don't know about was updated
					updateFullState();
				} else {
					for (const pr of e) {
						if (pr.model instanceof PullRequestModel) {
							this._updateSingleState(pr.model);
						}
					}
				}
			}
		}));
		this._register(PullRequestOverviewPanel.onVisible(e => this._model.clearNotification(e.remote.owner, e.remote.repositoryName, e.number)));

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${QUERIES}`)) {
				this._pollForChanges();
			}
		}));
		this._register(vscode.window.onDidChangeWindowState(e => {
			if (e.active || e.focused) {
				// If we are becoming active/focused, and it's been more than the poll interval since the last poll, poll now
				if (Date.now() - this._lastPollTime > this._pollInterval) {
					this._pollForChanges();
				}
			}
		}));
		this._register({ dispose: () => this._pollTimeout && clearTimeout(this._pollTimeout) });
	}

	private get _pollInterval(): number {
		if (vscode.window.state.active || vscode.window.state.focused) {
			return 60 * 1000 * 2; // Poll every 2 minutes
		}
		return 60 * 1000 * 5; // Poll every 5 minutes
	}

	private _pollTimeout: NodeJS.Timeout | undefined;
	private _lastPollTime = 0;
	private async _pollForChanges(): Promise<void> {
		// Skip polling if dev mode is enabled
		const devMode = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(DEV_MODE, false);
		if (devMode) {
			return;
		}

		if (this._pollTimeout) {
			clearTimeout(this._pollTimeout);
			this._pollTimeout = undefined;
		}
		this._lastPollTime = Date.now();
		const shouldContinue = await this._prsTreeModel.refreshCopilotStateChanges(true);

		if (shouldContinue) {
			this._pollTimeout = setTimeout(() => {
				this._pollForChanges();
			}, this._pollInterval);
		}
	}

	private async _updateSingleState(pr: PullRequestModel): Promise<void> {
		const changes: CodingAgentPRAndStatus[] = [];

		const copilotEvents = await pr.getCopilotTimelineEvents(false, !this._model.isInitialized);
		let latestEvent = copilotEventToStatus(copilotEvents[copilotEvents.length - 1]);
		if (latestEvent === CopilotPRStatus.None) {
			if (!COPILOT_ACCOUNTS[pr.author.login]) {
				return;
			}
			latestEvent = CopilotPRStatus.Started;
		}

		if (pr.state !== GithubItemStateEnum.Open) {
			// PR has been closed or merged, time to remove it.
			const key = this._model.makeKey(pr.remote.owner, pr.remote.repositoryName, pr.number);
			this._model.deleteKey(key);
			return;
		}

		const lastStatus = this._model.get(pr.remote.owner, pr.remote.repositoryName, pr.number) ?? CopilotPRStatus.None;
		if (latestEvent !== lastStatus) {
			changes.push({ item: pr, status: latestEvent });
		}
		this._model.set(changes);
	}

}