/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestManager, PRManagerState } from '../github/pullRequestManager';
import { MilestoneModel } from "../github/milestoneModel";
import { issueMarkdown } from './util';

// TODO: make exclude from date words configurable
const excludeFromDate: string[] = ['Recovery'];
const now = new Date();

export class IssueCompletionProvider implements vscode.CompletionItemProvider {
	private _items: Promise<MilestoneModel[]> = Promise.resolve([]);

	constructor(private manager: PullRequestManager, context: vscode.ExtensionContext) {
		if (this.manager.state === PRManagerState.RepositoriesLoaded) {
			this._items = this.createItems();
		} else {
			const disposable = this.manager.onDidChangeState(() => {
				if (this.manager.state === PRManagerState.RepositoriesLoaded) {
					this._items = this.createItems();
					disposable.dispose();
				}
			});
			context.subscriptions.push(disposable);
		}
	}

	private createItems(): Promise<MilestoneModel[]> {
		return new Promise(async (resolve) => {
			const milestones = await this.manager.getIssues({ fetchNextPage: false });
			let mostRecentPastTitleTime: Date | undefined = undefined;
			const milestoneDateMap: Map<string, Date> = new Map();
			const milestonesToUse: MilestoneModel[] = [];
			const skipMilestones: string[] = vscode.workspace.getConfiguration('githubIssues').get('ignoreMilestones', []);

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
			resolve(milestonesToUse);
		});
	}

	private removeDateExcludeStrings(possibleDate: string): string {
		excludeFromDate.forEach(exclude => possibleDate = possibleDate.replace(exclude, ''));
		return possibleDate;
	}

	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionItem[]> {
		const milestones = await this._items;
		let range: vscode.Range = new vscode.Range(position, position);
		if (position.character - 1 >= 0) {
			const wordAtPos = document.getText(new vscode.Range(position.translate(0, -1), position));
			if (wordAtPos === '#') {
				range = new vscode.Range(position.translate(0, -1), position);
			}
		}

		const completionItems: vscode.CompletionItem[] = [];

		for (let index = 0; index < milestones.length; index++) {
			const value = milestones[index];
			value.issues.forEach(issue => {
				const item: vscode.CompletionItem = new vscode.CompletionItem(`${issue.number}: ${issue.title}`);
				if (document.languageId === 'markdown') {
					item.insertText = `[#${issue.number}](${issue.html_url})`;
				} else {
					item.insertText = `#${issue.number}`;
				}
				item.documentation = issueMarkdown(issue);
				item.range = range;
				item.detail = value.milestone.title;
				let updatedAt: string = (now.getTime() - new Date(issue.updatedAt).getTime()).toString();
				updatedAt = (new Array(20 - updatedAt.length).join('0')) + updatedAt;
				item.sortText = `${index} ${updatedAt}`;
				item.filterText = `${item.detail} # ${issue.number} ${issue.title} ${item.documentation}`;
				completionItems.push(item);
			});
		}

		return completionItems;
	}
}