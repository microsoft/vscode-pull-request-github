/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { issueMarkdown, ISSUES_CONFIGURATION } from './util';
import { StateManager } from './stateManager';
import { IssueModel } from '../github/issueModel';
import { IMilestone } from '../github/interface';

class IssueCompletionItem extends vscode.CompletionItem {
	constructor(public readonly issue: IssueModel) {
		super(`${issue.number}: ${issue.title}`, vscode.CompletionItemKind.Constant);
	}
}

export class IssueCompletionProvider implements vscode.CompletionItemProvider {

	constructor(private stateManager: StateManager) { }

	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionItem[]> {
		// If the suggest was not triggered by the trigger character, require that the previous character be the trigger character
		if ((position.character > 0) && (context.triggerKind === vscode.CompletionTriggerKind.Invoke) && !document.getText(document.getWordRangeAtPosition(position)).match(/#[0-9]*$/)) {
			return [];
		}
		// It's common in markdown to start a line with #s and not want an completion
		if ((position.character <= 6) && (document.languageId === 'markdown') && (document.getText(new vscode.Range(position.with(undefined, 0), position)) === new Array(position.character + 1).join('#'))) {
			return [];
		}

		if ((context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter) &&
			(<string[]>vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('ignoreCompletionTrigger', [])).find(value => value === document.languageId)) {
			return [];
		}

		let range: vscode.Range = new vscode.Range(position, position);
		if (position.character - 1 >= 0) {
			const wordAtPos = document.getText(new vscode.Range(position.translate(0, -1), position));
			if (wordAtPos === '#') {
				range = new vscode.Range(position.translate(0, -1), position);
			}
		}

		const completionItems: vscode.CompletionItem[] = [];
		const now = new Date();

		const issueData = this.stateManager.issueData;
		if (issueData.byMilestone) {
			const milestones = await issueData.byMilestone;
			for (let index = 0; index < milestones.length; index++) {
				const value = milestones[index];
				value.issues.forEach(issue => {
					completionItems.push(this.completionItemFromIssue(issue, now, range, document, index, value.milestone));
				});
			}
		} else if (issueData.byIssue) {
			const issues = await issueData.byIssue;
			let index = 0;
			issues.forEach(issue => {
				completionItems.push(this.completionItemFromIssue(issue, now, range, document, index++));
			});
		}

		return completionItems;
	}

	private completionItemFromIssue(issue: IssueModel, now: Date, range: vscode.Range, document: vscode.TextDocument, index: number, milestone?: IMilestone): IssueCompletionItem {
		const item: IssueCompletionItem = new IssueCompletionItem(issue);
		if (document.languageId === 'markdown') {
			item.insertText = `[#${issue.number}](${issue.html_url})`;
		} else {
			item.insertText = `#${issue.number}`;
		}
		item.documentation = issue.body;
		item.range = range;
		item.detail = milestone ? milestone.title : issue.milestone?.title;
		let updatedAt: string = (now.getTime() - new Date(issue.updatedAt).getTime()).toString();
		updatedAt = (new Array(20 - updatedAt.length).join('0')) + updatedAt;
		item.sortText = `${index} ${updatedAt}`;
		item.filterText = `${item.detail} # ${issue.number} ${issue.title} ${item.documentation}`;
		return item;
	}

	resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.CompletionItem {
		if (item instanceof IssueCompletionItem) {
			item.documentation = issueMarkdown(item.issue);
		}
		return item;
	}
}