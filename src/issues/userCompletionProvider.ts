/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { IGNORE_USER_COMPLETION_TRIGGER, ISSUES_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { TimelineEvent } from '../common/timelineEvent';
import { fromPRUri, Schemes } from '../common/uri';
import { compareIgnoreCase } from '../common/utils';
import { EXTENSION_ID } from '../constants';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { IAccount, User } from '../github/interface';
import { RepositoriesManager } from '../github/repositoriesManager';
import { getRelatedUsersFromTimelineEvents } from '../github/utils';
import { ASSIGNEES, extractIssueOriginFromQuery, NEW_ISSUE_SCHEME } from './issueFile';
import { StateManager } from './stateManager';
import { getRootUriFromScmInputUri, isComment, UserCompletion, userMarkdown } from './util';

export class UserCompletionProvider implements vscode.CompletionItemProvider {
	private static readonly ID: string = 'UserCompletionProvider';
	private _gitBlameCache: { [key: string]: string } = {};

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
			document.languageId !== 'scminput' &&
			document.uri.scheme !== NEW_ISSUE_SCHEME &&
			position.character > 0 &&
			context.triggerKind === vscode.CompletionTriggerKind.Invoke &&
			wordAtPos?.charAt(0) !== '@'
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

		let completionItems: vscode.CompletionItem[] = [];
		const userMap = await this.stateManager.getUserMap(repoUri);
		userMap.forEach(item => {
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
		const commentSpecificSuggestions = await this.getCommentSpecificSuggestions(userMap, document, position);
		if (commentSpecificSuggestions) {
			completionItems = completionItems.concat(commentSpecificSuggestions);
		}
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

	private cachedPrUsers: UserCompletion[] = [];
	private cachedPrTimelineEvents: TimelineEvent[] = [];
	private cachedForPrNumber: number | undefined;
	private async getCommentSpecificSuggestions(
		alreadyIncludedUsers: Map<string, IAccount>,
		document: vscode.TextDocument,
		position: vscode.Position) {
		try {
			const query = JSON.parse(document.uri.query);
			if ((document.uri.scheme !== Schemes.Comment) || compareIgnoreCase(query.extensionId, EXTENSION_ID) !== 0) {
				return;
			}

			const wordRange = document.getWordRangeAtPosition(
				position,
				/@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})?/i,
			);
			if (!wordRange || wordRange.isEmpty) {
				return;
			}
			const activeTextEditors = vscode.window.visibleTextEditors;
			if (!activeTextEditors.length) {
				return;
			}

			let foundRepositoryManager: FolderRepositoryManager | undefined;

			let activeTextEditor: vscode.TextEditor | undefined;
			let prNumber: number | undefined;
			let remoteName: string | undefined;

			for (const editor of activeTextEditors) {
				foundRepositoryManager = this.manager.getManagerForFile(editor.document.uri);
				if (foundRepositoryManager) {
					if (foundRepositoryManager.activePullRequest) {
						prNumber = foundRepositoryManager.activePullRequest.number;
						remoteName = foundRepositoryManager.activePullRequest.remote.remoteName;
						break;
					} else if (editor.document.uri.scheme === Schemes.Pr) {
						const params = fromPRUri(editor.document.uri);
						prNumber = params!.prNumber;
						remoteName = params!.remoteName;
						break;
					}
				}
			}

			if (!foundRepositoryManager) {
				return;
			}
			const repositoryManager = foundRepositoryManager;

			if (prNumber && prNumber === this.cachedForPrNumber) {
				return this.cachedPrUsers;
			}

			let prRelatedusers: { login: string; name?: string }[] = [];
			const fileRelatedUsersNames: { [key: string]: boolean } = {};
			let mentionableUsers: { [key: string]: { login: string; name?: string }[] } = {};

			const prRelatedUsersPromise = new Promise<void>(async resolve => {
				if (prNumber && remoteName) {
					Logger.debug('get Timeline Events and parse users', UserCompletionProvider.ID);
					if (this.cachedForPrNumber === prNumber) {
						return this.cachedPrTimelineEvents;
					}

					const githubRepo = repositoryManager.gitHubRepositories.find(
						repo => repo.remote.remoteName === remoteName,
					);

					if (githubRepo) {
						const pr = await githubRepo.getPullRequest(prNumber);
						this.cachedForPrNumber = prNumber;
						this.cachedPrTimelineEvents = await pr!.getTimelineEvents();
					}

					prRelatedusers = getRelatedUsersFromTimelineEvents(this.cachedPrTimelineEvents);
					resolve();
				}

				resolve();
			});

			const fileRelatedUsersNamesPromise = new Promise<void>(async resolve => {
				if (activeTextEditors.length) {
					try {
						Logger.debug('git blame and parse users', UserCompletionProvider.ID);
						const fsPath = path.resolve(activeTextEditors[0].document.uri.fsPath);
						let blames: string | undefined;
						if (this._gitBlameCache[fsPath]) {
							blames = this._gitBlameCache[fsPath];
						} else {
							blames = await repositoryManager.repository.blame(fsPath);
							this._gitBlameCache[fsPath] = blames;
						}

						const blameLines = blames.split('\n');

						for (const line of blameLines) {
							const matches = /^\w{11} \S*\s*\((.*)\s*\d{4}\-/.exec(line);

							if (matches && matches.length === 2) {
								const name = matches[1].trim();
								fileRelatedUsersNames[name] = true;
							}
						}
					} catch (err) {
						Logger.debug(err, UserCompletionProvider.ID);
					}
				}

				resolve();
			});

			const getMentionableUsersPromise = new Promise<void>(async resolve => {
				Logger.debug('get mentionable users', UserCompletionProvider.ID);
				mentionableUsers = await repositoryManager.getMentionableUsers();
				resolve();
			});

			await Promise.all([
				prRelatedUsersPromise,
				fileRelatedUsersNamesPromise,
				getMentionableUsersPromise,
			]);

			this.cachedPrUsers = [];
			const prRelatedUsersMap: { [key: string]: { login: string; name?: string } } = {};
			Logger.debug('prepare user suggestions', UserCompletionProvider.ID);

			prRelatedusers.forEach(user => {
				if (!prRelatedUsersMap[user.login]) {
					prRelatedUsersMap[user.login] = user;
				}
			});

			const secondMap: { [key: string]: boolean } = {};

			for (const mentionableUserGroup in mentionableUsers) {
				for (const user of mentionableUsers[mentionableUserGroup]) {
					if (!prRelatedUsersMap[user.login] && !secondMap[user.login] && !alreadyIncludedUsers.get(user.login)) {
						secondMap[user.login] = true;

						let priority = 2;
						if (
							fileRelatedUsersNames[user.login] ||
							(user.name && fileRelatedUsersNames[user.name])
						) {
							priority = 1;
						}

						if (prRelatedUsersMap[user.login]) {
							priority = 0;
						}

						const completionItem: UserCompletion = new UserCompletion(
							{ label: user.login, description: user.name }, vscode.CompletionItemKind.User);
						completionItem.insertText = `@${user.login}`;
						completionItem.login = user.login;
						completionItem.uri = repositoryManager.repository.rootUri;
						completionItem.detail = user.name;
						completionItem.filterText = `@ ${user.login} ${user.name}`;
						completionItem.sortText = `${priority}_${user.login}`;
						if (activeTextEditor?.document.uri.scheme === NEW_ISSUE_SCHEME) {
							completionItem.commitCharacters = [' ', ','];
						}
						this.cachedPrUsers.push(completionItem);
					}
				}
			}

			Logger.debug('done', UserCompletionProvider.ID);
			return this.cachedPrUsers;
		} catch (e) {
			return [];
		}
	}
}
