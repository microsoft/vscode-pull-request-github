/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { COPILOT_LOGINS } from '../common/copilot';
import { Disposable } from '../common/lifecycle';
import { PR_SETTINGS_NAMESPACE, QUERIES } from '../common/settingKeys';
import { EventType, TimelineEvent } from '../common/timelineEvent';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { RepositoriesManager } from './repositoriesManager';
import { variableSubstitution } from './utils';

export enum CopilotPRStatus {
	None = 0,
	Started = 1,
	Completed = 2,
	Failed = 3,
}

export function isCopilotQuery(query: string): boolean {
	const lowerQuery = query.toLowerCase();
	return COPILOT_LOGINS.some(login => lowerQuery.includes(`author:${login.toLowerCase()}`));
}

function copilotEventToStatus(event: TimelineEvent): CopilotPRStatus {
	switch (event.event) {
		case EventType.CopilotStarted:
			return CopilotPRStatus.Started;
		case EventType.CopilotFinished:
			return CopilotPRStatus.Completed;
		case EventType.CopilotFinishedError:
			return CopilotPRStatus.Failed;
		default:
			return CopilotPRStatus.None;
	}
}

export class CopilotStateModel extends Disposable {
	private _isInitialized = false;
	private readonly _states: Map<string, CopilotPRStatus> = new Map();
	private readonly _showNotification: Set<string> = new Set();
	private readonly _onDidChange = this._register(new vscode.EventEmitter<void>());
	readonly onDidChange = this._onDidChange.event;

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
				this._showNotification.delete(key);
			}
			this._onDidChange.fire();
		}
	}

	set(owner: string, repo: string, prNumber: number, status: CopilotPRStatus): void {
		const key = this.makeKey(owner, repo, prNumber);
		const currentStatus = this._states.get(key);
		if (currentStatus === status) {
			return;
		}
		this._states.set(key, status);
		if (this._isInitialized) {
			this._showNotification.add(key);
		}
		this._onDidChange.fire();
	}

	get(owner: string, repo: string, prNumber: number): CopilotPRStatus {
		const key = this.makeKey(owner, repo, prNumber);
		return this._states.get(key) ?? CopilotPRStatus.None;
	}

	keys(): string[] {
		return Array.from(this._states.keys());
	}

	clearNotifications(): void {
		this._showNotification.clear();
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
}

export class CopilotPRWatcher extends Disposable {

	constructor(private readonly _reposManager: RepositoriesManager, private readonly _model: CopilotStateModel) {
		super();
		const query = this._queriesIncludeCopilot();
		if (query) {
			this._getStateChanges(query);
		}
		this._pollForChanges();

		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${QUERIES}`)) {
				this._pollForChanges();
			}
		}));
	}

	private _queriesIncludeCopilot(): string | undefined {
		const queries = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<{ label: string; query: string }[]>(QUERIES, []);
		return queries.find(query => isCopilotQuery(query.query))?.query;
	}

	private async _pollForChanges(): Promise<void> {
		const query = this._queriesIncludeCopilot();
		if (!query) {
			return;
		}

		await this._getStateChanges(query);

		const timeout = setTimeout(() => {
			this._pollForChanges();
		}, 60 * 1000); // Poll every minute
		this._register({ dispose: () => clearTimeout(timeout) });
	}

	private _currentUser: string | undefined;
	private async _getCurrentUser(folderManager: FolderRepositoryManager): Promise<string> {
		if (!this._currentUser) {
			this._currentUser = (await folderManager.getCurrentUser()).login;
		}
		return this._currentUser;
	}

	private async _getStateChanges(query: string) {
		const stateChanges: { owner: string; repo: string; prNumber: number; status: CopilotPRStatus }[] = [];
		const unseenKeys: Set<string> = new Set(this._model.keys());
		let initialized = 0;

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
				const copilotEvents = await pr.getCopilotTimelineEvents();
				if (copilotEvents.length === 0) {
					continue;
				}
				const lastStatus = this._model.get(pr.remote.owner, pr.remote.repositoryName, pr.number) ?? CopilotPRStatus.None;
				const latestEvent = copilotEventToStatus(copilotEvents[copilotEvents.length - 1]);
				if (latestEvent !== lastStatus) {
					stateChanges.push({
						owner: pr.remote.owner,
						repo: pr.remote.repositoryName,
						prNumber: pr.number,
						status: latestEvent
					});
					this._model.set(pr.remote.owner, pr.remote.repositoryName, pr.number, latestEvent);
				}
			}

			for (const key of unseenKeys) {
				this._model.deleteKey(key);
			}
		}
		if (!this._model.isInitialized) {
			if ((initialized === this._reposManager.folderManagers.length) && (this._reposManager.folderManagers.length > 0)) {
				this._model.setInitialized();
			}
			return [];
		} else {
			return stateChanges;
		}
	}
}