/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { StateManager, MilestoneItem, IssueItem } from './stateManager';
import { issueMarkdown } from './util';
import { RepositoriesManager } from '../github/repositoriesManager';
import { ReposManagerState, FolderRepositoryManager } from '../github/folderRepositoryManager';
import { IssueModel } from '../github/issueModel';
import { issueBodyHasLink } from './issueLinkLookup';

export class IssueUriTreeItem extends vscode.TreeItem {
	constructor(public readonly uri: vscode.Uri | undefined, label: string, collapsibleState?: vscode.TreeItemCollapsibleState) {
		super(label, collapsibleState);
	}

	get labelAsString(): string | undefined {
		return typeof this.label === 'string' ? this.label : this.label?.label;
	}
}

export class IssuesTreeData implements vscode.TreeDataProvider<FolderRepositoryManager | IssueItem | MilestoneItem | IssueUriTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<FolderRepositoryManager | IssueItem | MilestoneItem | null | undefined | void> = new vscode.EventEmitter();
	public onDidChangeTreeData: vscode.Event<FolderRepositoryManager | IssueItem | MilestoneItem | null | undefined | void> = this._onDidChangeTreeData.event;

	constructor(private stateManager: StateManager, private manager: RepositoriesManager, private context: vscode.ExtensionContext) {
		context.subscriptions.push(this.manager.onDidChangeState(() => {
			this._onDidChangeTreeData.fire();
		}));
		context.subscriptions.push(this.stateManager.onDidChangeIssueData(() => {
			this._onDidChangeTreeData.fire();
		}));

		context.subscriptions.push(this.stateManager.onDidChangeCurrentIssue(() => {
			this._onDidChangeTreeData.fire();
		}));
	}

	getTreeItem(element: FolderRepositoryManager | IssueItem | MilestoneItem | IssueUriTreeItem): IssueUriTreeItem {
		let treeItem: IssueUriTreeItem;
		if (element instanceof IssueUriTreeItem) {
			treeItem = element;
		} else if (element instanceof FolderRepositoryManager) {
			treeItem = new IssueUriTreeItem(element.repository.rootUri, path.basename(element.repository.rootUri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
		} else if (!(element instanceof IssueModel)) {
			treeItem = new IssueUriTreeItem(element.uri, element.milestone.title, element.issues.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		} else {
			treeItem = new IssueUriTreeItem(undefined, `${element.number}: ${element.title}`, vscode.TreeItemCollapsibleState.None);
			treeItem.iconPath = element.isOpen ? new vscode.ThemeIcon('issues', new vscode.ThemeColor('issues.open')) : new vscode.ThemeIcon('issue-closed', new vscode.ThemeColor('issues.closed'));
			if (this.stateManager.currentIssue(element.uri)?.issue.number === element.number) {
				treeItem.label = `✓ ${treeItem.label!}`;
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
		}
		return treeItem;
	}

	getChildren(element: FolderRepositoryManager | IssueItem | MilestoneItem | IssueUriTreeItem | undefined): FolderRepositoryManager[] | Promise<(IssueItem | MilestoneItem)[]> | IssueItem[] | IssueUriTreeItem[] {
		if ((element === undefined) && (this.manager.state !== ReposManagerState.RepositoriesLoaded)) {
			return this.getStateChildren();
		} else {
			return this.getIssuesChildren(element);
		}
	}

	async resolveTreeItem(item: vscode.TreeItem, element: FolderRepositoryManager | IssueItem | MilestoneItem | vscode.TreeItem): Promise<vscode.TreeItem> {
		if (element instanceof IssueModel) {
			item.tooltip = await issueMarkdown(element, this.context, this.manager);
		}
		return item;
	}

	getStateChildren(): IssueUriTreeItem[] {
		if (this.manager.state === ReposManagerState.NeedsAuthentication) {
			return [];
		} else {
			return [new IssueUriTreeItem(undefined, 'Loading...')];
		}
	}

	getQueryItems(folderManager: FolderRepositoryManager): Promise<(IssueItem | MilestoneItem)[]> | IssueUriTreeItem[] {
		const issueCollection = this.stateManager.getIssueCollection(folderManager.repository.rootUri);
		if (issueCollection.size === 1) {
			return Array.from(issueCollection.values())[0];
		}
		const queryLabels = Array.from(issueCollection.keys());
		const firstLabel = queryLabels[0];
		return queryLabels.map(label => {
			const item = new IssueUriTreeItem(folderManager.repository.rootUri, label);
			item.contextValue = 'query';
			item.collapsibleState = label === firstLabel ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
			return item;
		});
	}

	getIssuesChildren(element: FolderRepositoryManager | IssueItem | MilestoneItem | IssueUriTreeItem | undefined): FolderRepositoryManager[] | Promise<(IssueItem | MilestoneItem)[]> | IssueItem[] | IssueUriTreeItem[] {
		if (element === undefined) {
			// If there's only one query, don't display a title for it
			if (this.manager.folderManagers.length === 1) {
				return this.getQueryItems(this.manager.folderManagers[0]);
			} else if (this.manager.folderManagers.length > 1) {
				return this.manager.folderManagers;
			} else {
				return [];
			}
		} else if (element instanceof FolderRepositoryManager) {
			return this.getQueryItems(element);
		} else if (element instanceof IssueUriTreeItem) {
			return element.uri ? this.stateManager.getIssueCollection(element.uri).get(element.labelAsString!) ?? [] : [];
		} else if (!(element instanceof IssueModel)) {
			return element.issues.map(item => {
				const issueItem: IssueItem = Object.assign(item);
				issueItem.uri = element.uri;
				return issueItem;
			});
		} else {
			return [];
		}
	}

}
