/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FolderRepositoryManager, PullRequestDefaults } from '../github/folderRepositoryManager';
import { IMilestone } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { MilestoneModel } from '../github/milestoneModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { getIssueNumberLabel, variableSubstitution } from '../github/utils';
import { extractIssueOriginFromQuery, NEW_ISSUE_SCHEME } from './issueFile';
import { StateManager } from './stateManager';
import {
	getRootUriFromScmInputUri,
	isComment,
	issueMarkdown,
	ISSUES_CONFIGURATION,
} from './util';

class IssueCompletionItem extends vscode.CompletionItem {
	constructor(public readonly issue: IssueModel) {
		super(`${issue.number}: ${issue.title}`, vscode.CompletionItemKind.Issue);
	}
}

export class IssueCompletionProvider implements vscode.CompletionItemProvider {
	constructor(
		private stateManager: StateManager,
		private repositoriesManager: RepositoriesManager,
		private context: vscode.ExtensionContext,
	) { }

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.CompletionContext,
	): Promise<vscode.CompletionItem[]> {
		// If the suggest was not triggered by the trigger character, require that the previous character be the trigger character
		if (
			document.languageId !== 'scminput' &&
			document.uri.scheme !== 'comment' &&
			position.character > 0 &&
			context.triggerKind === vscode.CompletionTriggerKind.Invoke &&
			!document.getText(document.getWordRangeAtPosition(position)).match(/#[0-9]*$/)
		) {
			return [];
		}
		// It's common in markdown to start a line with #s and not want an completion
		if (
			position.character <= 6 &&
			document.languageId === 'markdown' &&
			(document.getText(new vscode.Range(position.with(undefined, 0), position)) ===
				new Array(position.character + 1).join('#')) &&
			document.uri.scheme !== 'comment' &&
			context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter
		) {
			return [];
		}

		if (
			context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter &&
			vscode.workspace
				.getConfiguration(ISSUES_CONFIGURATION)
				.get<string[]>('ignoreCompletionTrigger', [])
				.find(value => value === document.languageId)
		) {
			return [];
		}

		if ((document.languageId !== 'scminput') && (document.languageId !== 'git-commit') && !(await isComment(document, position))) {
			return [];
		}

		let range: vscode.Range = new vscode.Range(position, position);
		if (position.character - 1 >= 0) {
			const wordAtPos = document.getText(new vscode.Range(position.translate(0, -1), position));
			if (wordAtPos === '#') {
				range = new vscode.Range(position.translate(0, -1), position);
			}
		}

		const completionItems: Map<string, vscode.CompletionItem> = new Map();
		const now = new Date();
		let repo: PullRequestDefaults | undefined;
		let uri: vscode.Uri | undefined;
		if (document.languageId === 'scminput') {
			uri = getRootUriFromScmInputUri(document.uri);
		} else if ((document.uri.scheme === 'comment') && vscode.workspace.workspaceFolders?.length) {
			for (const visibleEditor of vscode.window.visibleTextEditors) {
				const testFolderUri = vscode.workspace.workspaceFolders[0].uri.with({ path: visibleEditor.document.uri.path });
				const workspace = vscode.workspace.getWorkspaceFolder(testFolderUri);
				if (workspace) {
					uri = workspace.uri;
					break;
				}
			}
		} else {
			uri = document.uri.scheme === NEW_ISSUE_SCHEME
				? extractIssueOriginFromQuery(document.uri) ?? document.uri
				: document.uri;
		}
		if (!uri) {
			return [];
		}

		let folderManager: FolderRepositoryManager | undefined;
		try {
			folderManager = this.repositoriesManager.getManagerForFile(uri);
			repo = await folderManager?.getPullRequestDefaults();
		} catch (e) {
			// leave repo undefined
		}
		const issueData = this.stateManager.getIssueCollection(folderManager?.repository.rootUri ?? uri);

		// Count up total number of issues. The number of queries is expected to be small.
		let totalIssues = 0;
		for (const issueQuery of issueData) {
			const issuesOrMilestones: IssueModel[] | MilestoneModel[] = (await issueQuery[1]) ?? [];
			if (issuesOrMilestones[0] instanceof IssueModel) {
				totalIssues += issuesOrMilestones.length;
			} else {
				for (const milestone of issuesOrMilestones) {
					totalIssues += (milestone as MilestoneModel).issues.length;
				}
			}
		}

		for (const issueQuery of issueData) {
			const issuesOrMilestones: IssueModel[] | MilestoneModel[] = (await issueQuery[1]) ?? [];
			if (issuesOrMilestones.length === 0) {
				continue;
			}
			if (issuesOrMilestones[0] instanceof IssueModel) {
				let index = 0;
				for (const issue of issuesOrMilestones) {
					completionItems.set(
						getIssueNumberLabel(issue as IssueModel),
						await this.completionItemFromIssue(repo, issue as IssueModel, now, range, document, index++, totalIssues),
					);
				}
			} else {
				for (let index = 0; index < issuesOrMilestones.length; index++) {
					const value: MilestoneModel = issuesOrMilestones[index] as MilestoneModel;
					for (const issue of value.issues) {
						completionItems.set(
							getIssueNumberLabel(issue),
							await this.completionItemFromIssue(
								repo,
								issue,
								now,
								range,
								document,
								index,
								totalIssues,
								value.milestone,
							),
						);
					}
				}
			}
		}
		return [...completionItems.values()];
	}

	private async completionItemFromIssue(
		repo: PullRequestDefaults | undefined,
		issue: IssueModel,
		now: Date,
		range: vscode.Range,
		document: vscode.TextDocument,
		index: number,
		totalCount: number,
		milestone?: IMilestone,
	): Promise<IssueCompletionItem> {
		const item: IssueCompletionItem = new IssueCompletionItem(issue);
		if (document.languageId === 'markdown') {
			item.insertText = `[${getIssueNumberLabel(issue, repo)}](${issue.html_url})`;
		} else {
			const configuration = vscode.workspace
				.getConfiguration(ISSUES_CONFIGURATION)
				.get('issueCompletionFormatScm');
			if (document.uri.path.match(/git\/scm\d\/input/) && typeof configuration === 'string') {
				item.insertText = await variableSubstitution(configuration, issue, repo);
			} else {
				item.insertText = `${getIssueNumberLabel(issue, repo)}`;
			}
		}
		item.documentation = issue.body;
		item.range = range;
		item.detail = milestone ? milestone.title : issue.milestone?.title;
		item.sortText = `${index}`.padStart(`${totalCount}`.length, '0');
		item.filterText = `${item.detail} # ${issue.number} ${issue.title} ${item.documentation}`;
		return item;
	}

	async resolveCompletionItem(
		item: vscode.CompletionItem,
		_token: vscode.CancellationToken,
	): Promise<vscode.CompletionItem> {
		if (item instanceof IssueCompletionItem) {
			item.documentation = await issueMarkdown(item.issue, this.context, this.repositoriesManager);
			item.command = {
				command: 'issues.issueCompletion',
				title: 'Issue Completion Chose,',
			};
		}
		return item;
	}
}
