/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';
import { MilestoneModel } from '../github/milestoneModel';
import { StateManager } from './stateManager';
import { Resource } from '../common/resources';

export class IssuesTreeData implements vscode.TreeDataProvider<IssueModel | MilestoneModel | string> {
	private _onDidChangeTreeData: vscode.EventEmitter<IssueModel | MilestoneModel | string | null | undefined> = new vscode.EventEmitter();
	public onDidChangeTreeData: vscode.Event<IssueModel | MilestoneModel | string | null | undefined> = this._onDidChangeTreeData.event;
	private firstLabel: string | undefined;

	constructor(private stateManager: StateManager, context: vscode.ExtensionContext) {
		context.subscriptions.push(this.stateManager.onDidChangeIssueData(() => {
			this._onDidChangeTreeData.fire();
		}));

		context.subscriptions.push(this.stateManager.onDidChangeCurrentIssue(() => {
			this._onDidChangeTreeData.fire();
		}));
	}

	getTreeItem(element: IssueModel | MilestoneModel | string): vscode.TreeItem {
		let treeItem: vscode.TreeItem;
		if (typeof element === 'string') {
			const collapsibleState: vscode.TreeItemCollapsibleState = element === this.firstLabel ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
			treeItem = new vscode.TreeItem(element, collapsibleState);
		} else if (!(element instanceof IssueModel)) {
			treeItem = new vscode.TreeItem(element.milestone.title, element.issues.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		} else {
			treeItem = new vscode.TreeItem(`${element.number}: ${element.title}`, vscode.TreeItemCollapsibleState.None);
			treeItem.iconPath = {
				light: Resource.icons.light.Issues,
				dark: Resource.icons.dark.Issues
			};
			if (this.stateManager.currentIssue?.issue.number === element.number) {
				treeItem.label = `✓ ${treeItem.label}`;
				treeItem.contextValue = 'currentissue';
			} else {
				treeItem.contextValue = 'issue';
			}
		}
		return treeItem;
	}

	getChildren(element: IssueModel | MilestoneModel | string | undefined): Promise<(IssueModel | MilestoneModel)[]> | IssueModel[] | string[] {
		if (element === undefined) {
			// If there's only one query, don't display a title for it
			if (this.stateManager.issueCollection.size === 1) {
				return Array.from(this.stateManager.issueCollection.values())[0];
			}
			const queryLabels = Array.from(this.stateManager.issueCollection.keys());
			this.firstLabel = queryLabels[0];
			return queryLabels;
		} else if (typeof element === 'string') {
			return this.stateManager.issueCollection.get(element) ?? [];
		} else if (!(element instanceof IssueModel)) {
			return element.issues;
		} else {
			return [];
		}
	}

}
