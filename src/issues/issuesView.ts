/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { commands, contexts } from '../common/executeCommands';
import { groupBy } from '../common/utils';
import { FolderRepositoryManager, ReposManagerState } from '../github/folderRepositoryManager';
import { IssueModel } from '../github/issueModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { issueBodyHasLink } from './issueLinkLookup';
import { IssueItem, QueryGroup, StateManager } from './stateManager';
import { issueMarkdown } from './util';

export class QueryNode {
	constructor(
		public readonly repoRootUri: vscode.Uri,
		public readonly queryLabel: string,
		public readonly isFirst: boolean
	) {
	}
}

class IssueGroupNode {
	constructor(public readonly repoRootUri: vscode.Uri, public readonly queryLabel, public readonly isInFirstQuery: boolean, public readonly groupLevel: number, public readonly group: string, public readonly groupByOrder: QueryGroup[], public readonly issuesInGroup: IssueItem[]) {
	}
}

export class IssuesTreeData
	implements vscode.TreeDataProvider<FolderRepositoryManager | QueryNode | IssueGroupNode | IssueItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<
		FolderRepositoryManager | IssueItem | null | undefined | void
	> = new vscode.EventEmitter();
	public onDidChangeTreeData: vscode.Event<
		FolderRepositoryManager | IssueItem | null | undefined | void
	> = this._onDidChangeTreeData.event;

	constructor(
		private stateManager: StateManager,
		private manager: RepositoriesManager,
		private context: vscode.ExtensionContext,
	) {
		context.subscriptions.push(
			this.manager.onDidChangeState(() => {
				this._onDidChangeTreeData.fire();
			}),
		);
		context.subscriptions.push(
			this.stateManager.onDidChangeIssueData(() => {
				this._onDidChangeTreeData.fire();
			}),
		);

		context.subscriptions.push(
			this.stateManager.onDidChangeCurrentIssue(() => {
				this._onDidChangeTreeData.fire();
			}),
		);
	}

	private getFolderRepoItem(element: FolderRepositoryManager): vscode.TreeItem {
		return new vscode.TreeItem(path.basename(element.repository.rootUri.fsPath), getQueryExpandState(this.context, element, vscode.TreeItemCollapsibleState.Expanded));
	}

	private getQueryItem(element: QueryNode): vscode.TreeItem {
		const item = new vscode.TreeItem(element.queryLabel, getQueryExpandState(this.context, element, element.isFirst ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed));
		item.contextValue = 'query';
		return item;
	}

	private getIssueGroupItem(element: IssueGroupNode): vscode.TreeItem {
		return new vscode.TreeItem(element.group, getQueryExpandState(this.context, element, element.isInFirstQuery ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed));
	}

	private getIssueTreeItem(element: IssueItem): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(`${element.number}: ${element.title}`, vscode.TreeItemCollapsibleState.None);
		treeItem.iconPath = element.isOpen
			? new vscode.ThemeIcon('issues', new vscode.ThemeColor('issues.open'))
			: new vscode.ThemeIcon('issue-closed', new vscode.ThemeColor('issues.closed'));
		if (this.stateManager.currentIssue(element.uri)?.issue.number === element.number) {
			treeItem.label = `✓ ${treeItem.label as string}`;
			treeItem.contextValue = 'currentissue';
		} else {
			const savedState = this.stateManager.getSavedIssueState(element.number);
			if (savedState.branch) {
				treeItem.contextValue = 'continueissue';
			} else {
				treeItem.contextValue = 'issue';
			}
		}
		if (issueBodyHasLink(element)) {
			treeItem.contextValue = 'link' + treeItem.contextValue;
		}
		return treeItem;
	}

	getTreeItem(element: FolderRepositoryManager | QueryNode | IssueGroupNode | IssueItem): vscode.TreeItem {
		if (element instanceof FolderRepositoryManager) {
			return this.getFolderRepoItem(element);
		} else if (element instanceof QueryNode) {
			return this.getQueryItem(element);
		} else if (element instanceof IssueGroupNode) {
			return this.getIssueGroupItem(element);
		} else {
			return this.getIssueTreeItem(element);
		}
	}

	getChildren(
		element: FolderRepositoryManager | QueryNode | IssueGroupNode | IssueItem | undefined,
	): FolderRepositoryManager[] | QueryNode[] | Promise<IssueItem[] | IssueGroupNode[]> {
		if (element === undefined && this.manager.state !== ReposManagerState.RepositoriesLoaded) {
			return this.getStateChildren();
		} else {
			return this.getIssuesChildren(element);
		}
	}

	async resolveTreeItem(
		item: vscode.TreeItem,
		element: FolderRepositoryManager | QueryNode | IssueGroupNode | IssueItem,
	): Promise<vscode.TreeItem> {
		if (element instanceof IssueModel) {
			item.tooltip = await issueMarkdown(element, this.context, this.manager);
		}
		return item;
	}

	getStateChildren(): [] {
		if ((this.manager.state === ReposManagerState.NeedsAuthentication)
			|| !this.manager.folderManagers.length) {
			return [];
		} else {
			commands.setContext(contexts.LOADING_ISSUES_TREE, true);
			return [];
		}
	}

	private getRootChildren(): FolderRepositoryManager[] | QueryNode[] | Promise<IssueItem[] | IssueGroupNode[]> {
		// If there's only one folder manager go straight to the query nodes
		if (this.manager.folderManagers.length === 1) {
			return this.getRepoChildren(this.manager.folderManagers[0]);
		} else if (this.manager.folderManagers.length > 1) {
			return this.manager.folderManagers;
		} else {
			return [];
		}
	}

	private getRepoChildren(folderManager: FolderRepositoryManager): QueryNode[] | Promise<IssueItem[] | IssueGroupNode[]> {
		const issueCollection = this.stateManager.getIssueCollection(folderManager.repository.rootUri);
		const queryLabels = Array.from(issueCollection.keys());
		if (queryLabels.length === 1) {
			return this.getQueryNodeChildren(new QueryNode(folderManager.repository.rootUri, queryLabels[0], true));
		}
		return queryLabels.map((label, index) => {
			const item = new QueryNode(folderManager.repository.rootUri, label, index === 0);
			return item;
		});
	}

	private async getQueryNodeChildren(queryNode: QueryNode): Promise<IssueItem[] | IssueGroupNode[]> {
		const issueCollection = this.stateManager.getIssueCollection(queryNode.repoRootUri);
		const issueQueryResult = await issueCollection.get(queryNode.queryLabel);
		if (!issueQueryResult) {
			return [];
		}
		return this.getIssueGroupsForGroupIndex(queryNode.repoRootUri, queryNode.queryLabel, queryNode.isFirst, issueQueryResult.groupBy, 0, issueQueryResult.issues);
	}

	private getIssueGroupsForGroupIndex(repoRootUri: vscode.Uri, queryLabel: string, isFirst: boolean, groupByOrder: QueryGroup[], indexInGroupByOrder: number, issues: IssueItem[]): IssueGroupNode[] | IssueItem[] {
		if (groupByOrder.length <= indexInGroupByOrder) {
			return issues;
		}
		const groupByValue = groupByOrder[indexInGroupByOrder];
		if ((groupByValue !== 'milestone' && groupByValue !== 'repository') || groupByOrder.findIndex(groupBy => groupBy === groupByValue) !== indexInGroupByOrder) {
			return this.getIssueGroupsForGroupIndex(repoRootUri, queryLabel, isFirst, groupByOrder, indexInGroupByOrder + 1, issues);
		}

		const groups = groupBy(issues, issue => {
			if (groupByValue === 'repository') {
				return `${issue.remote.owner}/${issue.remote.repositoryName}`;
			} else {
				return issue.milestone?.title ?? 'No Milestone';
			}
		});
		const nodes: IssueGroupNode[] = [];
		for (const group in groups) {
			nodes.push(new IssueGroupNode(repoRootUri, queryLabel, isFirst, indexInGroupByOrder, group, groupByOrder, groups[group]));
		}
		return nodes;
	}

	private async getIssueGroupChildren(issueGroupNode: IssueGroupNode): Promise<IssueItem[] | IssueGroupNode[]> {
		return this.getIssueGroupsForGroupIndex(issueGroupNode.repoRootUri, issueGroupNode.queryLabel, issueGroupNode.isInFirstQuery, issueGroupNode.groupByOrder, issueGroupNode.groupLevel + 1, issueGroupNode.issuesInGroup);
	}

	getIssuesChildren(
		element: FolderRepositoryManager | QueryNode | IssueGroupNode | IssueItem | undefined,
	): FolderRepositoryManager[] | QueryNode[] | Promise<IssueItem[] | IssueGroupNode[]> {
		if (element === undefined) {
			return this.getRootChildren();
		} else if (element instanceof FolderRepositoryManager) {
			return this.getRepoChildren(element);
		} else if (element instanceof QueryNode) {
			return this.getQueryNodeChildren(element);
		} else if (element instanceof IssueGroupNode) {
			return this.getIssueGroupChildren(element);
		} else {
			return [];
		}
	}
}

const EXPANDED_ISSUES_STATE = 'expandedIssuesState';

function expandStateId(element: FolderRepositoryManager | QueryNode | IssueGroupNode | IssueItem) {
	let id: string | undefined;
	if (element instanceof FolderRepositoryManager) {
		id = element.repository.rootUri.toString();
	} else if (element instanceof QueryNode) {
		id = `${element.repoRootUri.toString()}/${element.queryLabel}`;
	} else if (element instanceof IssueGroupNode) {
		id = `${element.repoRootUri.toString()}/${element.queryLabel}/${element.groupLevel}/${element.group}`;
	}
	return id;
}

export function updateExpandedQueries(context: vscode.ExtensionContext, element: FolderRepositoryManager | QueryNode | IssueGroupNode | IssueItem, isExpanded: boolean) {
	const id = expandStateId(element);

	if (id) {
		const expandedQueries = new Set<string>(context.workspaceState.get(EXPANDED_ISSUES_STATE, []) as string[]);
		if (isExpanded) {
			expandedQueries.add(id);
		} else {
			expandedQueries.delete(id);
		}
		context.workspaceState.update(EXPANDED_ISSUES_STATE, Array.from(expandedQueries.keys()));
	}
}

function getQueryExpandState(context: vscode.ExtensionContext, element: FolderRepositoryManager | QueryNode | IssueGroupNode, defaultState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded): vscode.TreeItemCollapsibleState {
	const id = expandStateId(element);
	if (id) {
		const savedValue = context.workspaceState.get(EXPANDED_ISSUES_STATE);
		if (!savedValue) {
			return defaultState;
		}
		const expandedQueries = new Set<string>(savedValue as string[]);
		return expandedQueries.has(id) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
	}
	return vscode.TreeItemCollapsibleState.None;
}
