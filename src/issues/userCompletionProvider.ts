/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { User, IAccount } from '../github/interface';
import { PullRequestManager, PRManagerState } from '../github/pullRequestManager';
import { userMarkdown, ISSUES_CONFIGURATION, UserCompletion, isComment } from './util';
import { StateManager } from './stateManager';

export class UserCompletionProvider implements vscode.CompletionItemProvider {
	private _items: Promise<IAccount[]> = Promise.resolve([]);

	constructor(private stateManager: StateManager, private manager: PullRequestManager, context: vscode.ExtensionContext) {
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

	private async createItems(): Promise<IAccount[]> {
		await this.stateManager.tryInitializeAndWait();
		const accounts: IAccount[] = [];
		const assignableUsers = await this.manager.getAssignableUsers();
		for (const user in assignableUsers) {
			accounts.push(...assignableUsers[user]);
		}
		return accounts;
	}

	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionItem[]> {
		// If the suggest was not triggered by the trigger character, require that the previous character be the trigger character
		if ((document.languageId !== 'scminput') && (position.character > 0) && (context.triggerKind === vscode.CompletionTriggerKind.Invoke) && (document.getText(new vscode.Range(position.with(undefined, position.character - 1), position)) !== '@')) {
			return [];
		}

		if ((context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter) &&
			(<string[]>vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('ignoreUserCompletionTrigger', [])).find(value => value === document.languageId)) {
			return [];
		}

		if (!(await isComment(document, position))) {
			return [];
		}

		let range: vscode.Range = new vscode.Range(position, position);
		if (position.character - 1 >= 0) {
			const wordAtPos = document.getText(new vscode.Range(position.translate(0, -1), position));
			if (wordAtPos === '@') {
				range = new vscode.Range(position.translate(0, -1), position);
			}
		}

		const completionItems: vscode.CompletionItem[] = [];
		(await this._items).forEach(item => {
			const completionItem: UserCompletion = new UserCompletion(item.login, vscode.CompletionItemKind.User);
			completionItem.insertText = `@${item.login}`;
			completionItem.login = item.login;
			completionItem.range = range;
			completionItem.detail = item.name;
			completionItem.filterText = `@ ${item.login} ${item.name}`;
			completionItems.push(completionItem);
		});
		return completionItems;
	}

	async resolveCompletionItem(item: UserCompletion, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
		const repo = await this.manager.getPullRequestDefaults();
		const user: User | undefined = await this.manager.resolveUser(repo.owner, repo.repo, item.login);
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