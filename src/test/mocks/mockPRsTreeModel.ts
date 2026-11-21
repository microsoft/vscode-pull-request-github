/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Disposable, EventEmitter } from "vscode";
import { CopilotPRStatus } from "../../common/copilot";
import { CodingAgentPRAndStatus, CopilotStateModel } from "../../github/copilotPrWatcher";
import { FolderRepositoryManager, ItemsResponseResult } from "../../github/folderRepositoryManager";
import { PullRequestChangeEvent } from "../../github/githubRepository";
import { PullRequestModel } from "../../github/pullRequestModel";
import { PRStatusChange, PrsTreeModel } from "../../view/prsTreeModel";
import { TreeNode } from "../../view/treeNodes/treeNode";

export class MockPrsTreeModel implements Partial<PrsTreeModel> {
	onDidChangeCopilotStates: Event<void> = new EventEmitter<void>().event;
	onDidChangeCopilotNotifications: Event<PullRequestModel[]> = new EventEmitter<PullRequestModel[]>().event;
	clearCopilotCaches(): false | undefined {
		throw new Error("Method not implemented.");
	}
	async refreshCopilotStateChanges(clearCache?: boolean): Promise<boolean> {
		return false;
	}
	getCopilotPullRequests(clearCache?: boolean): Promise<CodingAgentPRAndStatus[]> {
		throw new Error("Method not implemented.");
	}
	public onDidChangePrStatus: Event<string[]> = new EventEmitter<string[]>().event;
	public onDidChangeData: Event<void | FolderRepositoryManager | PullRequestChangeEvent[]> = new EventEmitter<void>().event;
	public onLoaded: Event<void>;
	public copilotStateModel: CopilotStateModel;
	public updateExpandedQueries(element: TreeNode, isExpanded: boolean): void {
		throw new Error("Method not implemented.");
	}
	get expandedQueries(): Set<string> | undefined {
		return new Set<string>(['All Open']);
	}
	get hasLoaded(): boolean {
		return true;
	}
	set hasLoaded(value: boolean) {
		throw new Error("Method not implemented.");
	}
	public cachedPRStatus(identifier: string): PRStatusChange | undefined {
		throw new Error("Method not implemented.");
	}
	public forceClearCache(): void {
		throw new Error("Method not implemented.");
	}
	public hasPullRequest(pr: PullRequestModel): boolean {
		throw new Error("Method not implemented.");
	}
	public clearCache(silent?: boolean): void {
		throw new Error("Method not implemented.");
	}
	async getLocalPullRequests(folderRepoManager: FolderRepositoryManager, update?: boolean): Promise<ItemsResponseResult<PullRequestModel>> {
		return {
			hasMorePages: false,
			items: this._localPullRequests,
			hasUnsearchedRepositories: false
		};
	}
	getPullRequestsForQuery(folderRepoManager: FolderRepositoryManager, fetchNextPage: boolean, query: string): Promise<ItemsResponseResult<PullRequestModel>> {
		throw new Error("Method not implemented.");
	}
	getAllPullRequests(folderRepoManager: FolderRepositoryManager, fetchNextPage: boolean, update?: boolean): Promise<ItemsResponseResult<PullRequestModel>> {
		throw new Error("Method not implemented.");
	}
	getCopilotNotificationsCount(owner: string, repo: string): number {
		return 0;
	}
	get copilotNotificationsCount(): number {
		return 0;
	}
	clearAllCopilotNotifications(owner?: string, repo?: string): void {
		throw new Error("Method not implemented.");
	}
	clearCopilotNotification(owner: string, repo: string, pullRequestNumber: number): void {
		throw new Error("Method not implemented.");
	}
	hasCopilotNotification(owner: string, repo: string, pullRequestNumber?: number): boolean {
		throw new Error("Method not implemented.");
	}
	getCopilotStateForPR(owner: string, repo: string, prNumber: number): CopilotPRStatus {
		if (prNumber === 123) {
			return CopilotPRStatus.Started;
		} else {
			return CopilotPRStatus.None;
		}
	}
	getCopilotCounts(owner: string, repo: string): { total: number; inProgress: number; error: number; } {
		throw new Error("Method not implemented.");
	}
	dispose(): void {
		throw new Error("Method not implemented.");
	}
	protected _isDisposed: boolean;
	protected _register<T extends Disposable>(value: T): T {
		throw new Error("Method not implemented.");
	}
	protected get isDisposed(): boolean {
		throw new Error("Method not implemented.");
	}

	private _localPullRequests: PullRequestModel[] = [];
	addLocalPullRequest(pr: PullRequestModel): void {
		this._localPullRequests.push(pr);
	}
}