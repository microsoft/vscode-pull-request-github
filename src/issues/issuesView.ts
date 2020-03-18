/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';
import { MilestoneModel } from '../github/milestoneModel';
import { StateManager } from './stateManager';
import { Resource } from '../common/resources';

export class IssuesTreeData implements vscode.TreeDataProvider<IssueModel | MilestoneModel> {
	private _onDidChangeTreeData: vscode.EventEmitter<IssueModel | MilestoneModel | null | undefined> = new vscode.EventEmitter();
	public onDidChangeTreeData: vscode.Event<IssueModel | MilestoneModel | null | undefined> = this._onDidChangeTreeData.event;

	constructor(private stateManager: StateManager, context: vscode.ExtensionContext, private useByMilestone: boolean) {
		context.subscriptions.push(this.stateManager.onDidChangeIssueData(() => {
			this._onDidChangeTreeData.fire();
		}));

		context.subscriptions.push(this.stateManager.onDidChangeCurrentIssue(() => {
			this._onDidChangeTreeData.fire();
		}));
	}

	getTreeItem(element: IssueModel | MilestoneModel): vscode.TreeItem {
		let treeItem: vscode.TreeItem;
		if (!(element instanceof IssueModel)) {
			treeItem = new vscode.TreeItem(element.milestone.title, element.issues.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		} else {
			treeItem = new vscode.TreeItem(`${element.number}: ${element.title}`, vscode.TreeItemCollapsibleState.None);
			if (this.stateManager.currentIssue?.issue.number === element.number) {
				treeItem.iconPath = {
					light: Resource.icons.light.Check,
					dark: Resource.icons.dark.Check
				};
				treeItem.contextValue = 'currentissue';
			} else {
				treeItem.iconPath = {
					light: Resource.icons.light.Issues,
					dark: Resource.icons.dark.Issues
				};
				treeItem.contextValue = 'issue';
			}
		}
		return treeItem;
	}

	getChildren(element: IssueModel | MilestoneModel | undefined): Promise<(IssueModel | MilestoneModel)[]> | IssueModel[] {
		if (element === undefined) {
			return this.useByMilestone ? this.stateManager.issueData.byMilestone || [] : this.stateManager.issueData.byIssue || [];
		} else if (!(element instanceof IssueModel)) {
			return element.issues;
		} else {
			return [];
		}
	}

}
