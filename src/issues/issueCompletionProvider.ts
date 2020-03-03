/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { issueMarkdown } from './util';
import { StateManager } from './stateManager';

export class IssueCompletionProvider implements vscode.CompletionItemProvider {

	constructor(private stateManager: StateManager) { }

	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionItem[]> {
		// If the suggest was not triggered by the trigger character, require that the previous character be the trigger character
		if ((position.character > 0) && (context.triggerKind === vscode.CompletionTriggerKind.Invoke) && (document.getText(new vscode.Range(position.with(undefined, position.character - 1), position)) !== '#')) {
			return [];
		}
		// It's common in markdown to start a line with #s and not want an completion
		if ((position.character <= 6) && (document.languageId === 'markdown') && (document.getText(new vscode.Range(position.with(undefined, 0), position)) === new Array(position.character + 1).join('#'))) {
			return [];
		}

		const milestones = await this.stateManager.milestones;
		let range: vscode.Range = new vscode.Range(position, position);
		if (position.character - 1 >= 0) {
			const wordAtPos = document.getText(new vscode.Range(position.translate(0, -1), position));
			if (wordAtPos === '#') {
				range = new vscode.Range(position.translate(0, -1), position);
			}
		}

		const completionItems: vscode.CompletionItem[] = [];
		const now = new Date();

		for (let index = 0; index < milestones.length; index++) {
			const value = milestones[index];
			value.issues.forEach(issue => {
				const item: vscode.CompletionItem = new vscode.CompletionItem(`${issue.number}: ${issue.title}`, vscode.CompletionItemKind.Constant);
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