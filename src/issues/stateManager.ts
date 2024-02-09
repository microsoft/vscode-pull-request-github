/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import LRUCache from 'lru-cache';
import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { GitApiImpl } from '../api/api1';
import { AuthProvider } from '../common/authentication';
import { parseRepositoryRemotes } from '../common/remote';
import {
	DEFAULT,
	IGNORE_MILESTONES,
	ISSUES_SETTINGS_NAMESPACE,
	QUERIES,
	USE_BRANCH_FOR_ISSUES,
} from '../common/settingKeys';
import {
	FolderRepositoryManager,
	PullRequestDefaults,
	ReposManagerState,
} from '../github/folderRepositoryManager';
import { IAccount } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { getIssueNumberLabel, variableSubstitution } from '../github/utils';
import { CurrentIssue } from './currentIssue';

const CURRENT_ISSUE_KEY = 'currentIssue';

const ISSUES_KEY = 'issues';

export interface IssueState {
	branch?: string;
	hasDraftPR?: boolean;
}

interface TimeStampedIssueState extends IssueState {
	stateModifiedTime: number;
}

interface IssuesState {
	issues: Record<string, TimeStampedIssueState>;
	branches: Record<string, { owner: string; repositoryName: string; number: number }>;
}

// eslint-disable-next-line no-template-curly-in-string
const DEFAULT_QUERY_CONFIGURATION_VALUE: { label: string, query: string, groupBy: QueryGroup[] }[] = [{ label: vscode.l10n.t('My Issues'), query: 'is:open assignee:@me repo:${owner}/${repository}', groupBy: ['milestone'] }];

export class IssueItem extends IssueModel {
	uri: vscode.Uri;
}

interface SingleRepoState {
	lastHead?: string;
	lastBranch?: string;
	currentIssue?: CurrentIssue;
	issueCollection: Map<string, Promise<IssueQueryResult>>;
	maxIssueNumber: number;
	userMap?: Promise<Map<string, IAccount>>;
	folderManager: FolderRepositoryManager;
}

export type QueryGroup = 'repository' | 'milestone';

export interface IssueQueryResult {
	groupBy: QueryGroup[];
	issues: IssueItem[];
}

export class StateManager {
	public readonly resolvedIssues: Map<string, LRUCache<string, IssueModel>> = new Map();
	private _singleRepoStates: Map<string, SingleRepoState | undefined> = new Map();
	private _onRefreshCacheNeeded: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onRefreshCacheNeeded: vscode.Event<void> = this._onRefreshCacheNeeded.event;
	private _onDidChangeIssueData: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onDidChangeIssueData: vscode.Event<void> = this._onDidChangeIssueData.event;
	private _queries: { label: string; query: string, groupBy?: QueryGroup[] }[] = [];

	private _onDidChangeCurrentIssue: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidChangeCurrentIssue: vscode.Event<void> = this._onDidChangeCurrentIssue.event;
	private initializePromise: Promise<void> | undefined;
	private statusBarItem?: vscode.StatusBarItem;

	getIssueCollection(uri: vscode.Uri): Map<string, Promise<IssueQueryResult>> {
		let collection = this._singleRepoStates.get(uri.path)?.issueCollection;
		if (collection) {
			return collection;
		} else {
			collection = new Map();
			return collection;
		}
	}

	constructor(
		readonly gitAPI: GitApiImpl,
		private manager: RepositoriesManager,
		private context: vscode.ExtensionContext,
	) { }

	private getOrCreateSingleRepoState(uri: vscode.Uri, folderManager?: FolderRepositoryManager): SingleRepoState {
		let state = this._singleRepoStates.get(uri.path);
		if (state) {
			return state;
		}
		if (!folderManager) {
			folderManager = this.manager.getManagerForFile(uri)!;
		}
		state = {
			issueCollection: new Map(),
			maxIssueNumber: 0,
			folderManager,
		};
		this._singleRepoStates.set(uri.path, state);
		return state;
	}

	async tryInitializeAndWait() {
		if (!this.initializePromise) {
			this.initializePromise = new Promise(resolve => {
				if (!this.manager.credentialStore.isAnyAuthenticated()) {
					// We don't wait for sign in to finish initializing.
					const disposable = this.manager.credentialStore.onDidGetSession(() => {
						disposable.dispose();
						this.doInitialize();
					});
					resolve();
				} else if (this.manager.state === ReposManagerState.RepositoriesLoaded) {
					this.doInitialize().then(() => resolve());
				} else {
					const disposable = this.manager.onDidChangeState(() => {
						if (this.manager.state === ReposManagerState.RepositoriesLoaded) {
							this.doInitialize().then(() => {
								disposable.dispose();
								resolve();
							});
						}
					});
					this.context.subscriptions.push(disposable);
				}
			});
		}
		return this.initializePromise;
	}

	private registerRepositoryChangeEvent() {
		async function updateRepository(that: StateManager, repository: Repository) {
			const state = that.getOrCreateSingleRepoState(repository.rootUri);
			// setIssueData can cause the last head and branch state to change. Capture them before that can happen.
			const oldHead = state.lastHead;
			const oldBranch = state.lastBranch;
			const newHead = repository.state.HEAD ? repository.state.HEAD.commit : undefined;
			if ((repository.state.HEAD ? repository.state.HEAD.commit : undefined) !== oldHead) {
				await that.setIssueData(state.folderManager);
			}

			const newBranch = repository.state.HEAD?.name;
			if (
				(oldHead !== newHead || oldBranch !== newBranch) &&
				(!state.currentIssue || newBranch !== state.currentIssue.branchName)
			) {
				if (newBranch) {
					if (state.folderManager) {
						await that.setCurrentIssueFromBranch(state, newBranch, true);
					}
				} else {
					await that.setCurrentIssue(state, undefined, true);
				}
			}
			state.lastHead = repository.state.HEAD ? repository.state.HEAD.commit : undefined;
			state.lastBranch = repository.state.HEAD ? repository.state.HEAD.name : undefined;
		}

		function addChangeEvent(that: StateManager, repository: Repository) {
			that.context.subscriptions.push(
				repository.state.onDidChange(async () => {
					updateRepository(that, repository);
				}),
			);
		}

		this.context.subscriptions.push(this.gitAPI.onDidOpenRepository(repository => {
			updateRepository(this, repository);
			addChangeEvent(this, repository);
		}));
		this.gitAPI.repositories.forEach(repository => {
			addChangeEvent(this, repository);
		});
	}

	refreshCacheNeeded() {
		this._onRefreshCacheNeeded.fire();
	}

	async refresh() {
		return this.setAllIssueData();
	}

	private async doInitialize() {
		this.cleanIssueState();
		this._queries = vscode.workspace
			.getConfiguration(ISSUES_SETTINGS_NAMESPACE, null)
			.get(QUERIES, DEFAULT_QUERY_CONFIGURATION_VALUE);
		if (this._queries.length === 0) {
			this._queries = DEFAULT_QUERY_CONFIGURATION_VALUE;
		}
		this.context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(change => {
				if (change.affectsConfiguration(`${ISSUES_SETTINGS_NAMESPACE}.${QUERIES}`)) {
					this._queries = vscode.workspace
						.getConfiguration(ISSUES_SETTINGS_NAMESPACE, null)
						.get(QUERIES, DEFAULT_QUERY_CONFIGURATION_VALUE);
					this._onRefreshCacheNeeded.fire();
				} else if (change.affectsConfiguration(`${ISSUES_SETTINGS_NAMESPACE}.${IGNORE_MILESTONES}`)) {
					this._onRefreshCacheNeeded.fire();
				}
			}),
		);
		this.registerRepositoryChangeEvent();
		await this.setAllIssueData();
		this.context.subscriptions.push(
			this.onRefreshCacheNeeded(async () => {
				await this.refresh();
			}),
		);

		for (const folderManager of this.manager.folderManagers) {
			this.context.subscriptions.push(folderManager.onDidChangeRepositories(() => this.refresh()));

			const singleRepoState: SingleRepoState = this.getOrCreateSingleRepoState(
				folderManager.repository.rootUri,
				folderManager,
			);
			singleRepoState.lastHead = folderManager.repository.state.HEAD
				? folderManager.repository.state.HEAD.commit
				: undefined;
			this._singleRepoStates.set(folderManager.repository.rootUri.path, singleRepoState);
			const branch = folderManager.repository.state.HEAD?.name;
			if (!singleRepoState.currentIssue && branch) {
				await this.setCurrentIssueFromBranch(singleRepoState, branch, true);
			}
		}
	}

	private cleanIssueState() {
		const stateString: string | undefined = this.context.workspaceState.get(ISSUES_KEY);
		const state: IssuesState = stateString ? JSON.parse(stateString) : { issues: [], branches: [] };
		const deleteDate: number = new Date().valueOf() - 30 /*days*/ * 86400000 /*milliseconds in a day*/;
		for (const issueState in state.issues) {
			if (state.issues[issueState].stateModifiedTime < deleteDate) {
				if (state.branches && state.branches[issueState]) {
					delete state.branches[issueState];
				}
				delete state.issues[issueState];
			}
		}
	}

	private async getUsers(uri: vscode.Uri): Promise<Map<string, IAccount>> {
		await this.initializePromise;
		const assignableUsers = await this.manager.getManagerForFile(uri)?.getAssignableUsers();
		const userMap: Map<string, IAccount> = new Map();
		for (const remote in assignableUsers) {
			assignableUsers[remote].forEach(account => {
				userMap.set(account.login, account);
			});
		}
		return userMap;
	}

	async getUserMap(uri: vscode.Uri): Promise<Map<string, IAccount>> {
		if (!this.initializePromise) {
			return Promise.resolve(new Map());
		}
		const state = this.getOrCreateSingleRepoState(uri);
		if (!state.userMap || (await state.userMap).size === 0) {
			state.userMap = this.getUsers(uri);
		}
		return state.userMap;
	}

	private async getCurrentUser(authProviderId: AuthProvider): Promise<string | undefined> {
		return (await this.manager.credentialStore.getCurrentUser(authProviderId))?.login;
	}

	private async setAllIssueData() {
		return Promise.all(this.manager.folderManagers.map(folderManager => this.setIssueData(folderManager)));
	}

	private async setIssueData(folderManager: FolderRepositoryManager) {
		const singleRepoState = this.getOrCreateSingleRepoState(folderManager.repository.rootUri, folderManager);
		singleRepoState.issueCollection.clear();
		const enterpriseRemotes = parseRepositoryRemotes(folderManager.repository).filter(
			remote => remote.isEnterprise
		);
		const user = await this.getCurrentUser(enterpriseRemotes.length ? AuthProvider.githubEnterprise : AuthProvider.github);

		for (let query of this._queries) {
			let items: Promise<IssueQueryResult> | undefined;
			if (query.query === DEFAULT) {
				query = DEFAULT_QUERY_CONFIGURATION_VALUE[0];
			}

			items = this.setIssues(
				folderManager,
				// Do not resolve pull request defaults as they will get resolved in the query later per repository
				await variableSubstitution(query.query, undefined, undefined, user),
			).then(issues => ({ groupBy: query.groupBy ?? [], issues }));

			if (items) {
				singleRepoState.issueCollection.set(query.label, items);
			}
		}
		singleRepoState.maxIssueNumber = await folderManager.getMaxIssue();
		singleRepoState.lastHead = folderManager.repository.state.HEAD?.commit;
		singleRepoState.lastBranch = folderManager.repository.state.HEAD?.name;
	}

	private setIssues(folderManager: FolderRepositoryManager, query: string): Promise<IssueItem[]> {
		return new Promise(async resolve => {
			const issues = await folderManager.getIssues(query);
			this._onDidChangeIssueData.fire();
			resolve(
				issues.items.map(item => {
					const issueItem: IssueItem = item as IssueItem;
					issueItem.uri = folderManager.repository.rootUri;
					return issueItem;
				}),
			);
		});
	}

	private async setCurrentIssueFromBranch(singleRepoState: SingleRepoState, branchName: string, silent: boolean = false) {
		const createBranchConfig = vscode.workspace
			.getConfiguration(ISSUES_SETTINGS_NAMESPACE)
			.get<string>(USE_BRANCH_FOR_ISSUES);
		if (createBranchConfig === 'off') {
			return;
		}

		let defaults: PullRequestDefaults | undefined;
		try {
			defaults = await singleRepoState.folderManager.getPullRequestDefaults();
		} catch (e) {
			// No remote, don't try to set the current issue
			return;
		}
		if (branchName === defaults.base) {
			await this.setCurrentIssue(singleRepoState, undefined, false);
			return;
		}

		if (singleRepoState.currentIssue && singleRepoState.currentIssue.branchName === branchName) {
			return;
		}

		const state: IssuesState = this.getSavedState();
		for (const branch in state.branches) {
			if (branch === branchName) {
				const issueModel = await singleRepoState.folderManager.resolveIssue(
					state.branches[branch].owner,
					state.branches[branch].repositoryName,
					state.branches[branch].number,
				);
				if (issueModel) {
					await this.setCurrentIssue(
						singleRepoState,
						new CurrentIssue(issueModel, singleRepoState.folderManager, this),
						false,
						silent
					);
				}
				return;
			}
		}
	}

	currentIssue(uri: vscode.Uri): CurrentIssue | undefined {
		return this._singleRepoStates.get(uri.path)?.currentIssue;
	}

	currentIssues(): CurrentIssue[] {
		return Array.from(this._singleRepoStates.values())
			.filter(state => state?.currentIssue)
			.map(state => state!.currentIssue!);
	}

	maxIssueNumber(uri: vscode.Uri): number {
		return this._singleRepoStates.get(uri.path)?.maxIssueNumber ?? 0;
	}

	private isSettingIssue: boolean = false;
	async setCurrentIssue(repoState: SingleRepoState | FolderRepositoryManager, issue: CurrentIssue | undefined, checkoutDefaultBranch: boolean, silent: boolean = false) {
		if (this.isSettingIssue && issue === undefined) {
			return;
		}
		this.isSettingIssue = true;
		if (repoState instanceof FolderRepositoryManager) {
			const state = this._singleRepoStates.get(repoState.repository.rootUri.path);
			if (!state) {
				return;
			}
			repoState = state;
		}
		try {
			if (repoState.currentIssue && issue?.issue.number === repoState.currentIssue.issue.number) {
				return;
			}
			if (repoState.currentIssue) {
				await repoState.currentIssue.stopWorking(checkoutDefaultBranch);
			}
			if (issue) {
				this.context.subscriptions.push(issue.onDidChangeCurrentIssueState(() => this.updateStatusBar()));
			}
			this.context.workspaceState.update(CURRENT_ISSUE_KEY, issue?.issue.number);
			if (!issue || (await issue.startWorking(silent))) {
				repoState.currentIssue = issue;
				this.updateStatusBar();
			}
			this._onDidChangeCurrentIssue.fire();
		} catch (e) {
			// Error has already been surfaced
		} finally {
			this.isSettingIssue = false;
		}
	}

	private updateStatusBar() {
		const currentIssues = this.currentIssues();
		const shouldShowStatusBarItem = currentIssues.length > 0;
		if (!shouldShowStatusBarItem) {
			if (this.statusBarItem) {
				this.statusBarItem.hide();
				this.statusBarItem.dispose();
				this.statusBarItem = undefined;
			}
			return;
		}
		if (shouldShowStatusBarItem && !this.statusBarItem) {
			this.statusBarItem = vscode.window.createStatusBarItem('github.issues.status', vscode.StatusBarAlignment.Left, 0);
			this.statusBarItem.name = vscode.l10n.t('GitHub Active Issue');
		}
		const statusBarItem = this.statusBarItem!;
		statusBarItem.text = vscode.l10n.t('{0} Issue {1}', '$(issues)', currentIssues
			.map(issue => getIssueNumberLabel(issue.issue, issue.repoDefaults))
			.join(', '));
		statusBarItem.tooltip = currentIssues.map(issue => issue.issue.title).join(', ');
		statusBarItem.command = 'issue.statusBar';
		statusBarItem.show();
	}

	private getSavedState(): IssuesState {
		const stateString: string | undefined = this.context.workspaceState.get(ISSUES_KEY);
		return stateString ? JSON.parse(stateString) : { issues: Object.create(null), branches: Object.create(null) };
	}

	getSavedIssueState(issueNumber: number): IssueState {
		const state: IssuesState = this.getSavedState();
		return state.issues[`${issueNumber}`] ?? {};
	}

	async setSavedIssueState(issue: IssueModel, issueState: IssueState) {
		const state: IssuesState = this.getSavedState();
		state.issues[`${issue.number}`] = { ...issueState, stateModifiedTime: new Date().valueOf() };
		if (issueState.branch) {
			if (!state.branches) {
				state.branches = Object.create(null);
			}
			state.branches[issueState.branch] = {
				number: issue.number,
				owner: issue.remote.owner,
				repositoryName: issue.remote.repositoryName,
			};
		}
		return this.context.workspaceState.update(ISSUES_KEY, JSON.stringify(state));
	}
}
