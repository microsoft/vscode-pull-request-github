/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { COPILOT_ACCOUNTS } from '../common/comment';
import { COPILOT_LOGINS, copilotEventToStatus, CopilotPRStatus } from '../common/copilot';
import { Disposable } from '../common/lifecycle';
import { PR_SETTINGS_NAMESPACE, QUERIES } from '../common/settingKeys';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { PullRequestModel } from './pullRequestModel';
import { PullRequestOverviewPanel } from './pullRequestOverview';
import { RepositoriesManager } from './repositoriesManager';
import { variableSubstitution } from './utils';

export function isCopilotQuery(query: string): boolean {
	const lowerQuery = query.toLowerCase();
	return COPILOT_LOGINS.some(login => lowerQuery.includes(`author:${login.toLowerCase()}`));
}

export class CopilotStateModel extends Disposable {
	private _isInitialized = false;
	private readonly _states: Map<string, { item: PullRequestModel, status: CopilotPRStatus }> = new Map();
	private readonly _showNotification: Set<string> = new Set();
	private readonly _onDidChangeStates = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeStates = this._onDidChangeStates.event;
	private readonly _onDidChangeNotifications = this._register(new vscode.EventEmitter<PullRequestModel[]>());
	readonly onDidChangeNotifications = this._onDidChangeNotifications.event;

	makeKey(owner: string, repo: string, prNumber: number): string {
		return `${owner}/${repo}#${prNumber}`;
	}

	delete(owner: string, repo: string, prNumber: number): void {
		const key = this.makeKey(owner, repo, prNumber);
		this.deleteKey(key);
	}
	deleteKey(key: string): void {
		if (this._states.has(key)) {
			this._states.delete(key);
			if (this._showNotification.has(key)) {
				const item = this._states.get(key)!;
				this._showNotification.delete(key);
				this._onDidChangeNotifications.fire([item.item]);
			}
			this._onDidChangeStates.fire();
		}
	}

	set(statuses: { pullRequestModel: PullRequestModel, status: CopilotPRStatus }[]): void {
		const changedModels: PullRequestModel[] = [];
		const changedKeys: string[] = [];
		for (const { pullRequestModel, status } of statuses) {
			const key = this.makeKey(pullRequestModel.remote.owner, pullRequestModel.remote.repositoryName, pullRequestModel.number);
			const currentStatus = this._states.get(key);
			if (currentStatus?.status === status) {
				continue;
			}
			this._states.set(key, { item: pullRequestModel, status });
			changedModels.push(pullRequestModel);
			changedKeys.push(key);
		}
		if (this._isInitialized) {
			changedKeys.forEach(key => this._showNotification.add(key));
			this._onDidChangeNotifications.fire(changedModels);
		}
		if (changedModels.length > 0) {
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

	get notifications(): ReadonlySet<string> {
		return this._showNotification;
	}

	setInitialized() {
		this._isInitialized = true;
	}

	get isInitialized(): boolean {
		return this._isInitialized;
	}

	getCounts(): { total: number; inProgress: number; error: number } {
		let inProgressCount = 0;
		let errorCount = 0;

		for (const state of this._states.values()) {
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
}

export class CopilotPRWatcher extends Disposable {

	constructor(private readonly _reposManager: RepositoriesManager, private readonly _model: CopilotStateModel) {
		super();
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
		this._getStateChanges();
		this._pollForChanges();
		this._register(this._reposManager.onDidChangeAnyPullRequests(() => this._getStateChanges()));
		this._register(PullRequestOverviewPanel.onVisible(e => this._model.clearNotification(e.remote.owner, e.remote.repositoryName, e.number)));

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${QUERIES}`)) {
				this._pollForChanges();
			}
		}));
		this._register({ dispose: () => this._timeout && clearTimeout(this._timeout) });
	}

	private _queriesIncludeCopilot(): string | undefined {
		const queries = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<{ label: string; query: string }[]>(QUERIES, []);
		return queries.find(query => isCopilotQuery(query.query))?.query;
	}

	private _timeout: NodeJS.Timeout | undefined;
	private async _pollForChanges(): Promise<void> {
		const shouldContinue = await this._getStateChanges();

		if (shouldContinue) {
			this._timeout = setTimeout(() => {
				this._pollForChanges();
			}, 60 * 1000); // Poll every minute
		}
	}

	private _currentUser: string | undefined;
	private async _getCurrentUser(folderManager: FolderRepositoryManager): Promise<string> {
		if (!this._currentUser) {
			this._currentUser = (await folderManager.getCurrentUser()).login;
		}
		return this._currentUser;
	}

	private async _getStateChanges(): Promise<boolean> {
		const query = this._queriesIncludeCopilot();
		if (!query) {
			return false;
		}
		const stateChanges: { owner: string; repo: string; prNumber: number; status: CopilotPRStatus }[] = [];
		const unseenKeys: Set<string> = new Set(this._model.keys());
		let initialized = 0;

		const changes: { pullRequestModel: PullRequestModel, status: CopilotPRStatus }[] = [];
		for (const folderManager of this._reposManager.folderManagers) {
			// It doesn't matter which repo we use since the query will specify the owner/repo.
			const githubRepository = folderManager.gitHubRepositories[0];
			if (!githubRepository) {
				continue;
			}
			initialized++;
			const prs = await folderManager.getPullRequestsForCategory(githubRepository, await variableSubstitution(query, undefined, await folderManager.getPullRequestDefaults(), await this._getCurrentUser(folderManager)));
			for (const pr of prs?.items ?? []) {
				unseenKeys.delete(this._model.makeKey(pr.remote.owner, pr.remote.repositoryName, pr.number));
				const copilotEvents = await pr.getCopilotTimelineEvents(pr);
				let latestEvent = copilotEventToStatus(copilotEvents[copilotEvents.length - 1]);
				if (latestEvent === CopilotPRStatus.None) {
					if (!COPILOT_ACCOUNTS[pr.author.login]) {
						continue;
					}
					latestEvent = CopilotPRStatus.Started;
				}
				const lastStatus = this._model.get(pr.remote.owner, pr.remote.repositoryName, pr.number) ?? CopilotPRStatus.None;
				if (latestEvent !== lastStatus) {
					stateChanges.push({
						owner: pr.remote.owner,
						repo: pr.remote.repositoryName,
						prNumber: pr.number,
						status: latestEvent
					});
					changes.push({ pullRequestModel: pr, status: latestEvent });
				}
			}

			for (const key of unseenKeys) {
				this._model.deleteKey(key);
			}
		}
		this._model.set(changes);
		if (!this._model.isInitialized) {
			if ((initialized === this._reposManager.folderManagers.length) && (this._reposManager.folderManagers.length > 0)) {
				this._model.setInitialized();
			}
			return true;
		} else {
			return true;
		}
	}
}