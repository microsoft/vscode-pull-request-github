/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as LRUCache from 'lru-cache';
import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';
import { IAccount } from '../github/interface';
import { FolderRepositoryManager, NO_MILESTONE, PullRequestDefaults, ReposManagerState } from '../github/folderRepositoryManager';
import { MilestoneModel } from '../github/milestoneModel';
import { ISSUES_CONFIGURATION, BRANCH_CONFIGURATION, QUERIES_CONFIGURATION, DEFAULT_QUERY_CONFIGURATION, variableSubstitution, getIssueNumberLabel } from './util';
import { CurrentIssue } from './currentIssue';
import { RepositoriesManager } from '../github/repositoriesManager';
import { GitApiImpl } from '../api/api1';

// TODO: make exclude from date words configurable
const excludeFromDate: string[] = ['Recovery'];
const CURRENT_ISSUE_KEY = 'currentIssue';

const ISSUES_KEY = 'issues';

const IGNORE_MILESTONES_CONFIGURATION = 'ignoreMilestones';

export interface IssueState {
	branch?: string;
	hasDraftPR?: boolean;
}

interface TimeStampedIssueState extends IssueState {
	stateModifiedTime: number;
}

interface IssuesState {
	issues: Record<string, TimeStampedIssueState>;
	branches: Record<string, { owner: string, repositoryName: string, number: number }>;
}

const DEFAULT_QUERY_CONFIGURATION_VALUE = [{ label: 'My Issues', query: 'default' }];

export interface MilestoneItem extends MilestoneModel {
	uri: vscode.Uri;
}

export class IssueItem extends IssueModel {
	uri: vscode.Uri;
}

interface SingleRepoState {
	lastHead?: string;
	lastBranch?: string;
	currentIssue?: CurrentIssue;
	issueCollection: Map<string, Promise<MilestoneItem[] | IssueItem[]>>;
	maxIssueNumber: number;
	userMap?: Promise<Map<string, IAccount>>;
	folderManager: FolderRepositoryManager;
}

export class StateManager {
	public readonly resolvedIssues: Map<string, LRUCache<string, IssueModel>> = new Map();
	private _singleRepoStates: Map<string, SingleRepoState | undefined> = new Map();
	private _onRefreshCacheNeeded: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onRefreshCacheNeeded: vscode.Event<void> = this._onRefreshCacheNeeded.event;
	private _onDidChangeIssueData: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onDidChangeIssueData: vscode.Event<void> = this._onDidChangeIssueData.event;
	private _queries: { label: string, query: string }[] = [];

	private _onDidChangeCurrentIssue: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidChangeCurrentIssue: vscode.Event<void> = this._onDidChangeCurrentIssue.event;
	private initializePromise: Promise<void> | undefined;
	private statusBarItem?: vscode.StatusBarItem;

	getIssueCollection(uri: vscode.Uri): Map<string, Promise<MilestoneItem[] | IssueItem[]>> {
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
		private context: vscode.ExtensionContext
	) {
		manager.folderManagers.forEach(folderManager => {
			this.context.subscriptions.push(folderManager.onDidChangeRepositories(() => this.refresh()));
		});
	}

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
			folderManager
		};
		this._singleRepoStates.set(uri.path, state);
		return state;
	}

	async tryInitializeAndWait() {
		if (!this.initializePromise) {
			this.initializePromise = new Promise(resolve => {
				if (this.manager.state === ReposManagerState.RepositoriesLoaded) {
					this.doInitialize();
					resolve();
				} else {
					const disposable = this.manager.onDidChangeState(() => {
						if (this.manager.state === ReposManagerState.RepositoriesLoaded) {
							this.doInitialize();
							disposable.dispose();
							resolve();
						}
					});
					this.context.subscriptions.push(disposable);
				}
			});
		}
		return this.initializePromise;
	}

	private registerRepositoryChangeEvent() {
		this.gitAPI.repositories.forEach(repository => {
			this.context.subscriptions.push(repository.state.onDidChange(async () => {
				const state = this.getOrCreateSingleRepoState(repository.rootUri);
				// setIssueData can cause the last head and branch state to change. Capture them before that can happen.
				const oldHead = state.lastHead;
				const oldBranch = state.lastBranch;
				const newHead = (repository.state.HEAD ? repository.state.HEAD.commit : undefined);
				if ((repository.state.HEAD ? repository.state.HEAD.commit : undefined) !== oldHead) {
					await this.setIssueData(state.folderManager);
				}

				const newBranch = repository.state.HEAD?.name;
				if (((oldHead !== newHead) || (oldBranch !== newBranch)) &&
					(!state.currentIssue || (newBranch !== state.currentIssue.branchName))) {
					if (newBranch) {
						if (state.folderManager) {
							await this.setCurrentIssueFromBranch(state, newBranch);
						}
					} else {
						await this.setCurrentIssue(state, undefined);
					}
				}
				state.lastHead = (repository.state.HEAD ? repository.state.HEAD.commit : undefined);
				state.lastBranch = (repository.state.HEAD ? repository.state.HEAD.name : undefined);
			}));
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
		this._queries = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(QUERIES_CONFIGURATION, DEFAULT_QUERY_CONFIGURATION_VALUE);
		if (this._queries.length === 0) {
			this._queries = DEFAULT_QUERY_CONFIGURATION_VALUE;
		}
		this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(change => {
			if (change.affectsConfiguration(`${ISSUES_CONFIGURATION}.${QUERIES_CONFIGURATION}`)) {
				this._queries = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(QUERIES_CONFIGURATION, DEFAULT_QUERY_CONFIGURATION_VALUE);
				this._onRefreshCacheNeeded.fire();
			} else if (change.affectsConfiguration(`${ISSUES_CONFIGURATION}.${IGNORE_MILESTONES_CONFIGURATION}`)) {
				this._onRefreshCacheNeeded.fire();
			}
		}));
		await this.setAllIssueData();
		this.registerRepositoryChangeEvent();
		this.context.subscriptions.push(this.onRefreshCacheNeeded(async () => {
			await this.refresh();
		}));
		for (const folderManager of this.manager.folderManagers) {
			const singleRepoState: SingleRepoState = this.getOrCreateSingleRepoState(folderManager.repository.rootUri, folderManager);
			singleRepoState.lastHead = folderManager.repository.state.HEAD ? folderManager.repository.state.HEAD.commit : undefined;
			this._singleRepoStates.set(folderManager.repository.rootUri.path, singleRepoState);
			const branch = folderManager.repository.state.HEAD?.name;
			if (!singleRepoState.currentIssue && branch) {
				await this.setCurrentIssueFromBranch(singleRepoState, branch);
			}
		}
	}

	private cleanIssueState() {
		const stateString: string | undefined = this.context.workspaceState.get(ISSUES_KEY);
		const state: IssuesState = stateString ? JSON.parse(stateString) : { issues: [], branches: [] };
		const deleteDate: number = new Date().valueOf() - (30 /*days*/ * 86400000 /*milliseconds in a day*/);
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
		const assignableUsers = await (this.manager.getManagerForFile(uri))?.getAssignableUsers();
		const userMap: Map<string, IAccount> = new Map();
		for (const remote in assignableUsers) {
			assignableUsers[remote].forEach(account => {
				userMap.set(account.login, account);
			});
		}
		return userMap;
	}

	getUserMap(uri: vscode.Uri): Promise<Map<string, IAccount>> {
		if (!this.initializePromise) {
			return Promise.resolve(new Map());
		}
		const state = this.getOrCreateSingleRepoState(uri);
		if (!state.userMap) {
			state.userMap = this.getUsers(uri);
		}
		return state.userMap;
	}

	private async getCurrentUser(): Promise<string | undefined> {
		return (await this.manager.credentialStore.getCurrentUser())?.login;
	}

	private async setAllIssueData() {
		return Promise.all(this.manager.folderManagers.map(folderManager => this.setIssueData(folderManager)));
	}

	private async setIssueData(folderManager: FolderRepositoryManager) {
		const singleRepoState = this.getOrCreateSingleRepoState(folderManager.repository.rootUri, folderManager);
		singleRepoState.issueCollection.clear();
		let defaults: PullRequestDefaults | undefined;
		let user: string | undefined;
		for (const query of this._queries) {
			let items: Promise<IssueItem[] | MilestoneItem[]>;
			if (query.query === DEFAULT_QUERY_CONFIGURATION) {
				items = this.setMilestones(folderManager);
			} else {
				if (!defaults) {
					try {
						defaults = await folderManager.getPullRequestDefaults();
					} catch (e) {
						// leave defaults undefined
					}
				}
				if (!user) {
					user = await this.getCurrentUser();
				}
				items = this.setIssues(folderManager, await variableSubstitution(query.query, undefined, defaults, user));
			}
			singleRepoState.issueCollection.set(query.label, items);
		}
		singleRepoState.maxIssueNumber = await folderManager.getMaxIssue();
		singleRepoState.lastHead = folderManager.repository.state.HEAD?.commit;
		singleRepoState.lastBranch = folderManager.repository.state.HEAD?.name;
	}

	private setIssues(folderManager: FolderRepositoryManager, query: string): Promise<IssueItem[]> {
		return new Promise(async (resolve) => {
			const issues = await folderManager.getIssues({ fetchNextPage: false }, query);
			this._onDidChangeIssueData.fire();
			resolve(issues.items.map(item => {
				const issueItem: IssueItem = <IssueItem>item;
				issueItem.uri = folderManager.repository.rootUri;
				return issueItem;
			}));
		});
	}

	private async setCurrentIssueFromBranch(singleRepoState: SingleRepoState, branchName: string) {
		const createBranchConfig = <string>vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(BRANCH_CONFIGURATION);
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
			await this.setCurrentIssue(singleRepoState, undefined);
			return;
		}

		if (singleRepoState.currentIssue && (singleRepoState.currentIssue.branchName === branchName)) {
			return;
		}

		const state: IssuesState = this.getSavedState();
		for (const branch in state.branches) {
			if (branch === branchName) {
				const issueModel = await singleRepoState.folderManager.resolveIssue(state.branches[branch].owner, state.branches[branch].repositoryName, state.branches[branch].number);
				if (issueModel) {
					await this.setCurrentIssue(singleRepoState, new CurrentIssue(issueModel, singleRepoState.folderManager, this));
				}
				return;
			}
		}
	}

	private setMilestones(folderManager: FolderRepositoryManager): Promise<MilestoneItem[]> {
		return new Promise(async (resolve) => {
			const now = new Date();
			const skipMilestones: string[] = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(IGNORE_MILESTONES_CONFIGURATION, []);
			const milestones = await folderManager.getMilestones({ fetchNextPage: false }, skipMilestones.indexOf(NO_MILESTONE) < 0);
			let mostRecentPastTitleTime: Date | undefined = undefined;
			const milestoneDateMap: Map<string, Date> = new Map();
			const milestonesToUse: MilestoneItem[] = [];

			// The number of milestones is expected to be very low, so two passes through is negligible
			for (let i = 0; i < milestones.items.length; i++) {
				const item: MilestoneItem = <MilestoneItem>milestones.items[i];
				item.uri = folderManager.repository.rootUri;
				const milestone = milestones.items[i].milestone;
				if ((item.issues && item.issues.length <= 0) || (skipMilestones.indexOf(milestone.title) >= 0)) {
					continue;
				}

				milestonesToUse.push(item);
				let milestoneDate = milestone.dueOn ? new Date(milestone.dueOn) : undefined;
				if (!milestoneDate) {
					milestoneDate = new Date(this.removeDateExcludeStrings(milestone.title));
					if (isNaN(milestoneDate.getTime())) {
						milestoneDate = new Date(milestone.createdAt!);
					}
				}
				if ((milestoneDate < now) && ((mostRecentPastTitleTime === undefined) || (milestoneDate > mostRecentPastTitleTime))) {
					mostRecentPastTitleTime = milestoneDate;
				}
				milestoneDateMap.set(milestone.id ? milestone.id : milestone.title, milestoneDate);
			}

			milestonesToUse.sort((a: MilestoneModel, b: MilestoneModel): number => {
				const dateA = milestoneDateMap.get(a.milestone.id ? a.milestone.id : a.milestone.title)!;
				const dateB = milestoneDateMap.get(b.milestone.id ? b.milestone.id : b.milestone.title)!;
				if (mostRecentPastTitleTime && (dateA >= mostRecentPastTitleTime) && (dateB >= mostRecentPastTitleTime)) {
					return dateA <= dateB ? -1 : 1;
				} else {
					return dateA >= dateB ? -1 : 1;
				}
			});
			this._onDidChangeIssueData.fire();
			resolve(milestonesToUse);
		});
	}

	private removeDateExcludeStrings(possibleDate: string): string {
		excludeFromDate.forEach(exclude => possibleDate = possibleDate.replace(exclude, ''));
		return possibleDate;
	}

	currentIssue(uri: vscode.Uri): CurrentIssue | undefined {
		return this._singleRepoStates.get(uri.path)?.currentIssue;
	}

	currentIssues(): CurrentIssue[] {
		return Array.from(this._singleRepoStates.values()).filter(state => state?.currentIssue).map(state => state!.currentIssue!);
	}

	maxIssueNumber(uri: vscode.Uri): number {
		return this._singleRepoStates.get(uri.path)?.maxIssueNumber ?? 0;
	}

	private isSettingIssue: boolean = false;
	async setCurrentIssue(repoState: SingleRepoState | FolderRepositoryManager, issue: CurrentIssue | undefined) {
		if (this.isSettingIssue && (issue === undefined)) {
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
			if (repoState.currentIssue && (issue?.issue.number === repoState.currentIssue.issue.number)) {
				return;
			}
			if (repoState.currentIssue) {
				await repoState.currentIssue.stopWorking();
			}
			if (issue) {
				this.context.subscriptions.push(issue.onDidChangeCurrentIssueState(() => this.updateStatusBar()));
			}
			this.context.workspaceState.update(CURRENT_ISSUE_KEY, issue?.issue.number);
			if (!issue || await issue.startWorking()) {
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
			this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
		}
		const statusBarItem = this.statusBarItem!;
		statusBarItem.text = `$(issues) Issue ${currentIssues.map(issue => getIssueNumberLabel(issue.issue, issue.repoDefaults)).join(', ')}`;
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

	setSavedIssueState(issue: IssueModel, issueState: IssueState) {
		const state: IssuesState = this.getSavedState();
		state.issues[`${issue.number}`] = { ...issueState, stateModifiedTime: (new Date().valueOf()) };
		if (issueState.branch) {
			if (!state.branches) {
				state.branches = Object.create(null);
			}
			state.branches[issueState.branch] = { number: issue.number, owner: issue.remote.owner, repositoryName: issue.remote.repositoryName };
		}
		this.context.workspaceState.update(ISSUES_KEY, JSON.stringify(state));
	}
}