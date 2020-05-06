/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';
import { MilestoneModel } from '../github/milestoneModel';
import { StateManager } from './stateManager';
import { Resource } from '../common/resources';
import { PullRequestManager, PRManagerState } from '../github/pullRequestManager';

export class IssuesTreeData implements vscode.TreeDataProvider<IssueModel | MilestoneModel | vscode.TreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<IssueModel | MilestoneModel | null | undefined | void> = new vscode.EventEmitter();
	public onDidChangeTreeData: vscode.Event<IssueModel | MilestoneModel | null | undefined | void> = this._onDidChangeTreeData.event;

	constructor(private stateManager: StateManager, private manager: PullRequestManager, context: vscode.ExtensionContext) {
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

	getTreeItem(element: IssueModel | MilestoneModel | vscode.TreeItem): vscode.TreeItem {
		let treeItem: vscode.TreeItem;
		if (element instanceof vscode.TreeItem) {
			treeItem = element;
		} else if (!(element instanceof IssueModel)) {
			treeItem = new vscode.TreeItem(element.milestone.title, element.issues.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		} else {
			treeItem = new vscode.TreeItem(`${element.number}: ${element.title}`, vscode.TreeItemCollapsibleState.None);
			treeItem.iconPath = {
				light: Resource.icons.light.Issues,
				dark: Resource.icons.dark.Issues
			};
			treeItem.tooltip = `${element.item.labels.length > 0 ? ('▨ ' + element.item.labels.map(label => label.name).join(', ') + '\n') : ''}${element.number}: ${element.title}\n\n${element.body.substring(0, 300)}${element.body.length > 300 ? '...' : ''}`;
			if (this.stateManager.currentIssue?.issue.number === element.number) {
				treeItem.label = `✓ ${treeItem.label}`;
				treeItem.contextValue = 'currentissue';
			} else {
				const savedState = this.stateManager.getSavedIssueState(element.number);
				if (savedState.branch) {
					treeItem.contextValue = 'continueissue';
				} else {
					treeItem.contextValue = 'issue';
				}
			}
		}
		return treeItem;
	}

	getChildren(element: IssueModel | MilestoneModel | vscode.TreeItem | undefined): Promise<(IssueModel | MilestoneModel)[]> | IssueModel[] | vscode.TreeItem[] {
		if (element === undefined && this.manager.state !== PRManagerState.RepositoriesLoaded) {
			return this.getStateChildren();
		} else {
			return this.getIssuesChildren(element);
		}
	}

	getStateChildren(): vscode.TreeItem[] {
		if (this.manager.state === PRManagerState.NeedsAuthentication) {
			const item = new vscode.TreeItem('Sign in');
			item.command = {
				title: 'Sign in',
				command: 'issue.signinAndRefreshList',
				arguments: []
			};
			return [item];
		} else {
			return [new vscode.TreeItem('Loading...')];
		}
	}

	getIssuesChildren(element: IssueModel | MilestoneModel | vscode.TreeItem | undefined): Promise<(IssueModel | MilestoneModel)[]> | IssueModel[] | vscode.TreeItem[] {
		if (element === undefined) {
			// If there's only one query, don't display a title for it
			if (this.stateManager.issueCollection.size === 1) {
				return Array.from(this.stateManager.issueCollection.values())[0];
			}
			const queryLabels = Array.from(this.stateManager.issueCollection.keys());
			const firstLabel = queryLabels[0];
			return queryLabels.map(label => {
				const item = new vscode.TreeItem(label);
				item.contextValue = 'query';
				item.collapsibleState = label === firstLabel ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
				return item;
			});
		} else if (element instanceof vscode.TreeItem) {
			return this.stateManager.issueCollection.get(element.label!) ?? [];
		} else if (!(element instanceof IssueModel)) {
			return element.issues;
		} else {
			return [];
		}
	}

}
