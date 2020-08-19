/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { User } from '../github/interface';
import { userMarkdown, ISSUES_CONFIGURATION, UserCompletion, isComment, getRootUriFromScmInputUri } from './util';
import { StateManager } from './stateManager';
import { NEW_ISSUE_SCHEME, extractIssueOriginFromQuery } from './issueFile';
import { RepositoriesManager } from '../github/repositoriesManager';

export class UserCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private stateManager: StateManager, private manager: RepositoriesManager, context: vscode.ExtensionContext) {
	}

	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionItem[]> {
		// If the suggest was not triggered by the trigger character, require that the previous character be the trigger character
		if ((document.languageId !== 'scminput') && (document.uri.scheme !== NEW_ISSUE_SCHEME) && (position.character > 0) && (context.triggerKind === vscode.CompletionTriggerKind.Invoke) && (document.getText(new vscode.Range(position.with(undefined, position.character - 1), position)) !== '@')) {
			return [];
		}

		if ((context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter) &&
			(<string[]>vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('ignoreUserCompletionTrigger', [])).find(value => value === document.languageId)) {
			return [];
		}

		if ((document.languageId !== 'scminput') && !(await isComment(document, position))) {
			return [];
		}

		let range: vscode.Range = new vscode.Range(position, position);
		if (position.character - 1 >= 0) {
			const wordAtPos = document.getText(new vscode.Range(position.translate(0, -1), position));
			if (wordAtPos === '@') {
				range = new vscode.Range(position.translate(0, -1), position);
			}
		}
		const uri = document.uri.scheme === NEW_ISSUE_SCHEME ? (extractIssueOriginFromQuery(document.uri) ?? document.uri) :
			(document.languageId === 'scminput' ? getRootUriFromScmInputUri(document.uri) : document.uri);
		if (!uri) {
			return [];
		}

		const completionItems: vscode.CompletionItem[] = [];
		(await this.stateManager.getUserMap(uri)).forEach(item => {
			const completionItem: UserCompletion = new UserCompletion(item.login, vscode.CompletionItemKind.User);
			completionItem.insertText = `@${item.login}`;
			completionItem.login = item.login;
			completionItem.uri = uri;
			completionItem.range = range;
			completionItem.detail = item.name;
			completionItem.filterText = `@ ${item.login} ${item.name}`;
			if (document.uri.scheme === NEW_ISSUE_SCHEME) {
				completionItem.commitCharacters = [' ', ','];
			}
			completionItems.push(completionItem);
		});
		return completionItems;
	}

	async resolveCompletionItem(item: UserCompletion, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
		const folderManager = this.manager.getManagerForFile(item.uri);
		if (!folderManager) {
			return item;
		}
		const repo = await folderManager.getPullRequestDefaults();
		const user: User | undefined = await folderManager.resolveUser(repo.owner, repo.repo, item.login);
		if (user) {
			item.documentation = userMarkdown(repo, user);
			item.command = {
				command: 'issues.userCompletion',
				title: 'User Completion Chosen'
			};
		}
		return item;
	}
}