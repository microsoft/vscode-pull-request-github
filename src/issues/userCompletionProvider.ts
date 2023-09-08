/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGNORE_USER_COMPLETION_TRIGGER, ISSUES_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { Schemes } from '../common/uri';
import { User } from '../github/interface';
import { RepositoriesManager } from '../github/repositoriesManager';
import { ASSIGNEES, extractIssueOriginFromQuery, NEW_ISSUE_SCHEME } from './issueFile';
import { StateManager } from './stateManager';
import { getRootUriFromScmInputUri, isComment, UserCompletion, userMarkdown } from './util';

export class UserCompletionProvider implements vscode.CompletionItemProvider {
	constructor(
		private stateManager: StateManager,
		private manager: RepositoriesManager,
		_context: vscode.ExtensionContext,
	) { }

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.CompletionContext,
	): Promise<vscode.CompletionItem[]> {
		let wordRange = document.getWordRangeAtPosition(position);
		let wordAtPos = wordRange ? document.getText(wordRange) : undefined;
		if (!wordRange || wordAtPos?.charAt(0) !== '@') {
			const start = wordRange?.start ?? position;
			const testWordRange = new vscode.Range(start.translate(undefined, start.character ? -1 : 0), position);
			const testWord = document.getText(testWordRange);
			if (testWord.charAt(0) === '@') {
				wordRange = testWordRange;
				wordAtPos = testWord;
			}
		}
		// If the suggest was not triggered by the trigger character, require that the previous character be the trigger character
		if (
			position.character > 0 &&
			context.triggerKind === vscode.CompletionTriggerKind.Invoke &&
			((document.languageId === 'scminput' && !document.lineAt(position.line).text.includes('@')) ||
				(document.languageId !== 'scminput' && document.uri.scheme !== NEW_ISSUE_SCHEME && wordAtPos?.charAt(0) !== '@'))
		) {
			return [];
		}

		// If the suggest was not triggered  by the trigger character and it's in a new issue file, make sure it's on the Assignees line.
		if (
			(document.uri.scheme === NEW_ISSUE_SCHEME) &&
			(context.triggerKind === vscode.CompletionTriggerKind.Invoke) &&
			(document.getText(new vscode.Range(position.with(undefined, 0), position.with(undefined, ASSIGNEES.length))) !== ASSIGNEES)
		) {
			return [];
		}

		if (
			context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter &&
			vscode.workspace
				.getConfiguration(ISSUES_SETTINGS_NAMESPACE)
				.get<string[]>(IGNORE_USER_COMPLETION_TRIGGER, [])
				.find(value => value === document.languageId)
		) {
			return [];
		}

		if (!this.isCodeownersFiles(document.uri) && (document.languageId !== 'scminput') && (document.languageId !== 'git-commit') && !(await isComment(document, position))) {
			return [];
		}

		let range: vscode.Range = new vscode.Range(position, position);
		if (position.character - 1 >= 0) {
			if (wordRange && wordAtPos?.charAt(0) === '@') {
				range = wordRange;
			}
		}

		let uri: vscode.Uri | undefined = document.uri;
		if (document.uri.scheme === NEW_ISSUE_SCHEME) {
			uri = extractIssueOriginFromQuery(document.uri) ?? document.uri;
		} else if (document.languageId === 'scminput') {
			uri = getRootUriFromScmInputUri(document.uri);
		} else if (document.uri.scheme === Schemes.Comment) {
			const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
			uri = activeTab instanceof vscode.TabInputText ? activeTab.uri : (activeTab instanceof vscode.TabInputTextDiff ? activeTab.modified : undefined);
		}

		if (!uri) {
			return [];
		}

		const repoUri = this.manager.getManagerForFile(uri)?.repository.rootUri ?? uri;

		const completionItems: vscode.CompletionItem[] = [];
		(await this.stateManager.getUserMap(repoUri)).forEach(item => {
			const completionItem: UserCompletion = new UserCompletion(
				{ label: item.login, description: item.name }, vscode.CompletionItemKind.User);
			completionItem.insertText = `@${item.login}`;
			completionItem.login = item.login;
			completionItem.uri = repoUri;
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

	private isCodeownersFiles(uri: vscode.Uri): boolean {
		const repositoryManager = this.manager.getManagerForFile(uri);
		if (!repositoryManager || !uri.path.startsWith(repositoryManager.repository.rootUri.path)) {
			return false;
		}
		const subpath = uri.path.substring(repositoryManager.repository.rootUri.path.length).toLowerCase();
		const codeownersFiles = ['/codeowners', '/docs/codeowners', '/.github/codeowners'];
		return !!codeownersFiles.find(file => file === subpath);
	}

	async resolveCompletionItem(item: UserCompletion, _token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
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
				title: vscode.l10n.t('User Completion Chosen'),
			};
		}
		return item;
	}
}
