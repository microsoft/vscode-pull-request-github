/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as LRUCache from 'lru-cache';
import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';
import { IAccount } from '../github/interface';
import { PullRequestManager, PRManagerState, NO_MILESTONE, PullRequestDefaults } from '../github/pullRequestManager';
import { MilestoneModel } from '../github/milestoneModel';
import { GitAPI } from '../typings/git';
import { ISSUES_CONFIGURATION, BRANCH_CONFIGURATION, QUERIES_CONFIGURATION, DEFAULT_QUERY_CONFIGURATION, variableSubstitution } from './util';
import { CurrentIssue } from './currentIssue';

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

export class StateManager {
	public readonly resolvedIssues: LRUCache<string, IssueModel> = new LRUCache(50); // 50 seems big enough
	private _userMap: Promise<Map<string, IAccount>> | undefined;
	private _lastHead: string | undefined;
	private _issueCollection: Map<string, Promise<MilestoneModel[] | IssueModel[]>> = new Map();
	private _onRefreshCacheNeeded: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onRefreshCacheNeeded: vscode.Event<void> = this._onRefreshCacheNeeded.event;
	private _onDidChangeIssueData: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onDidChangeIssueData: vscode.Event<void> = this._onDidChangeIssueData.event;
	private _queries: { label: string, query: string }[] = [];

	private _currentIssue: CurrentIssue | undefined;
	private _onDidChangeCurrentIssue: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidChangeCurrentIssue: vscode.Event<void> = this._onDidChangeCurrentIssue.event;
	private initializePromise: Promise<void> | undefined;
	private _maxIssueNumber: number = 0;

	get issueCollection(): Map<string, Promise<MilestoneModel[] | IssueModel[]>> {
		return this._issueCollection;
	}

	constructor(
		readonly gitAPI: GitAPI,
		private manager: PullRequestManager,
		private context: vscode.ExtensionContext
	) {
		this.context.subscriptions.push(this.manager.onDidChangeRepositories(() => this.refresh()));
	}

	async tryInitializeAndWait() {
		if (!this.initializePromise) {
			this.initializePromise = new Promise(resolve => {
				if (this.manager.state === PRManagerState.RepositoriesLoaded) {
					this.doInitialize();
					resolve();
				} else {
					const disposable = this.manager.onDidChangeState(() => {
						if (this.manager.state === PRManagerState.RepositoriesLoaded) {
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
				if ((repository.state.HEAD ? repository.state.HEAD.commit : undefined) !== this._lastHead) {
					this._lastHead = (repository.state.HEAD ? repository.state.HEAD.commit : undefined);
					await this.setIssueData();
				}

				const newBranch = repository.state.HEAD?.name;
				if (!this.currentIssue || (newBranch !== this.currentIssue.branchName)) {
					if (newBranch) {
						await this.setCurrentIssueFromBranch(newBranch);
					} else {
						await this.setCurrentIssue(undefined);
					}
				}
			}));
		});
	}

	refreshCacheNeeded() {
		this._onRefreshCacheNeeded.fire();
	}

	async refresh(): Promise<void> {
		return this.setIssueData();
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
		this._lastHead = this.manager.repository.state.HEAD ? this.manager.repository.state.HEAD.commit : undefined;
		await this.setIssueData();
		this.registerRepositoryChangeEvent();
		this.context.subscriptions.push(this.onRefreshCacheNeeded(async () => {
			await this.refresh();
		}));
		const branch = this.manager.repository.state.HEAD?.name;
		if (!this.currentIssue && branch) {
			await this.setCurrentIssueFromBranch(branch);

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

	private async getUsers(): Promise<Map<string, IAccount>> {
		await this.initializePromise;
		const assignableUsers = await this.manager.getAssignableUsers();
		const userMap: Map<string, IAccount> = new Map();
		for (const remote in assignableUsers) {
			assignableUsers[remote].forEach(account => {
				userMap.set(account.login, account);
			});
		}
		return userMap;
	}

	get userMap(): Promise<Map<string, IAccount>> {
		if (!this.initializePromise) {
			return Promise.resolve(new Map());
		}
		if (!this._userMap) {
			this._userMap = this.getUsers();
		}
		return this._userMap;
	}

	private async getCurrentUser(): Promise<string | undefined> {
		return (await this.manager.credentialStore.getCurrentUser()).login;
	}

	private async setIssueData() {
		this._issueCollection.clear();
		let defaults: PullRequestDefaults | undefined;
		let user: string | undefined;
		for (const query of this._queries) {
			let items: Promise<IssueModel[] | MilestoneModel[]>;
			if (query.query === DEFAULT_QUERY_CONFIGURATION) {
				items = this.setMilestones();
			} else {
				if (!defaults) {
					try {
						defaults = await this.manager.getPullRequestDefaults();
					} catch (e) {
						// leave defaults undefined
					}
				}
				if (!user) {
					user = await this.getCurrentUser();
				}
				items = this.setIssues(await variableSubstitution(query.query, undefined, defaults, user));
			}
			this._issueCollection.set(query.label, items);
		}
		this._maxIssueNumber = await this.manager.getMaxIssue();
	}

	private setIssues(query: string): Promise<IssueModel[]> {
		return new Promise(async (resolve) => {
			const issues = await this.manager.getIssues({ fetchNextPage: false }, query);
			this._onDidChangeIssueData.fire();
			resolve(issues.items);
		});
	}

	private async setCurrentIssueFromBranch(branchName: string) {
		const createBranchConfig = <string>vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(BRANCH_CONFIGURATION);
		if (createBranchConfig === 'off') {
			return;
		}

		let defaults: PullRequestDefaults | undefined;
		try {
			defaults = await this.manager.getPullRequestDefaults();
		} catch (e) {
			// No remote, don't try to set the current issue
			return;
		}
		if (branchName === defaults.base) {
			await this.setCurrentIssue(undefined);
			return;
		}

		if (this._currentIssue && (this._currentIssue.branchName === branchName)) {
			return;
		}

		const state: IssuesState = this.getSavedState();
		for (const branch in state.branches) {
			if (branch === branchName) {
				const issueModel = await this.manager.resolveIssue(state.branches[branch].owner, state.branches[branch].repositoryName, state.branches[branch].number);
				if (issueModel) {
					await this.setCurrentIssue(new CurrentIssue(issueModel, this.manager, this));
				}
				return;
			}
		}
	}

	private setMilestones(): Promise<MilestoneModel[]> {
		return new Promise(async (resolve) => {
			const now = new Date();
			const skipMilestones: string[] = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(IGNORE_MILESTONES_CONFIGURATION, []);
			const milestones = await this.manager.getMilestones({ fetchNextPage: false }, skipMilestones.indexOf(NO_MILESTONE) < 0);
			let mostRecentPastTitleTime: Date | undefined = undefined;
			const milestoneDateMap: Map<string, Date> = new Map();
			const milestonesToUse: MilestoneModel[] = [];

			// The number of milestones is expected to be very low, so two passes through is negligible
			for (let i = 0; i < milestones.items.length; i++) {
				const item = milestones.items[i];
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

	get currentIssue(): CurrentIssue | undefined {
		return this._currentIssue;
	}

	get maxIssueNumber(): number {
		return this._maxIssueNumber;
	}

	private isSettingIssue: boolean = false;
	async setCurrentIssue(issue: CurrentIssue | undefined) {
		if (this.isSettingIssue && (issue === undefined)) {
			return;
		}
		this.isSettingIssue = true;
		try {
			if (this._currentIssue && (issue?.issue.number === this._currentIssue.issue.number)) {
				return;
			}
			if (this._currentIssue) {
				await this._currentIssue.stopWorking();
			}
			this.context.workspaceState.update(CURRENT_ISSUE_KEY, issue?.issue.number);
			if (!issue || await issue.startWorking()) {
				this._currentIssue = issue;
			}
			this._onDidChangeCurrentIssue.fire();
		} catch (e) {
			// Error has already been surfaced
		} finally {
			this.isSettingIssue = false;
		}
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