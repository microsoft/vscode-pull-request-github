/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { issueMarkdown, ISSUES_CONFIGURATION, variableSubstitution, getIssueNumberLabel, isComment, getRootUriFromScmInputUri } from './util';
import { StateManager } from './stateManager';
import { IssueModel } from '../github/issueModel';
import { IMilestone } from '../github/interface';
import { MilestoneModel } from '../github/milestoneModel';
import { PullRequestDefaults } from '../github/folderRepositoryManager';
import { RepositoriesManager } from '../github/repositoriesManager';

class IssueCompletionItem extends vscode.CompletionItem {
	constructor(public readonly issue: IssueModel) {
		super(`${issue.number}: ${issue.title}`, vscode.CompletionItemKind.Issue);
	}
}

export class IssueCompletionProvider implements vscode.CompletionItemProvider {

	constructor(private stateManager: StateManager, private repositoriesManager: RepositoriesManager, private context: vscode.ExtensionContext) { }

	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionItem[]> {
		// If the suggest was not triggered by the trigger character, require that the previous character be the trigger character
		if ((document.languageId !== 'scminput') && (document.uri.scheme !== 'comment') && (position.character > 0) &&
			(context.triggerKind === vscode.CompletionTriggerKind.Invoke) &&
			!document.getText(document.getWordRangeAtPosition(position)).match(/#[0-9]*$/)) {
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

		if ((document.languageId !== 'scminput') && !(await isComment(document, position))) {
			return [];
		}

		let range: vscode.Range = new vscode.Range(position, position);
		if (position.character - 1 >= 0) {
			const wordAtPos = document.getText(new vscode.Range(position.translate(0, -1), position));
			if (wordAtPos === '#') {
				range = new vscode.Range(position.translate(0, -1), position);
			}
		}

		await this.stateManager.tryInitializeAndWait();

		const completionItems: Map<string, vscode.CompletionItem> = new Map();
		const now = new Date();
		let repo: PullRequestDefaults | undefined;
		let uri: vscode.Uri | undefined;
		if (document.languageId === 'scminput') {
			uri = getRootUriFromScmInputUri(document.uri);
		} else if (document.uri.scheme === 'comment') {
			uri = vscode.window.visibleTextEditors.length > 0
				? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(vscode.window.visibleTextEditors[0].document.uri.fsPath))?.uri
				: undefined;
		} else {
			uri = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
		}
		if (!uri) {
			return [];
		}

		try {
			repo = await (await this.repositoriesManager.getManagerForFile(uri))?.getPullRequestDefaults();
		} catch (e) {
			// leave repo undefined
		}
		const issueData = this.stateManager.getIssueCollection(uri);
		for (const issueQuery of issueData) {
			const issuesOrMilestones: IssueModel[] | MilestoneModel[] = await issueQuery[1] ?? [];
			if (issuesOrMilestones.length === 0) {
				continue;
			}
			if (issuesOrMilestones[0] instanceof IssueModel) {
				let index = 0;
				for (const issue of issuesOrMilestones) {
					completionItems.set(getIssueNumberLabel(<IssueModel>issue), await this.completionItemFromIssue(repo, <IssueModel>issue, now, range, document, index++));
				}
			} else {
				for (let index = 0; index < issuesOrMilestones.length; index++) {
					const value: MilestoneModel = <MilestoneModel>issuesOrMilestones[index];
					for (const issue of value.issues) {
						completionItems.set(getIssueNumberLabel(issue), await this.completionItemFromIssue(repo, issue, now, range, document, index, value.milestone));
					}
				}
			}
		}
		return [...completionItems.values()];
	}

	private async completionItemFromIssue(repo: PullRequestDefaults | undefined, issue: IssueModel, now: Date, range: vscode.Range, document: vscode.TextDocument, index: number, milestone?: IMilestone): Promise<IssueCompletionItem> {
		const item: IssueCompletionItem = new IssueCompletionItem(issue);
		if (document.languageId === 'markdown') {
			item.insertText = `[${getIssueNumberLabel(issue, repo)}](${issue.html_url})`;
		} else {
			const configuration = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('issueCompletionFormatScm');
			if (document.uri.path.match(/scm\/git\/scm\d\/input/) && (typeof configuration === 'string')) {
				item.insertText = await variableSubstitution(configuration, issue, repo);
			} else {
				item.insertText = `${getIssueNumberLabel(issue, repo)}`;
			}
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

	async resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): Promise<vscode.CompletionItem> {
		if (item instanceof IssueCompletionItem) {
			item.documentation = await issueMarkdown(item.issue, this.context, this.repositoriesManager);
			item.command = {
				command: 'issues.issueCompletion',
				title: 'Issue Completion Chose,'
			};
		}
		return item;
	}
}