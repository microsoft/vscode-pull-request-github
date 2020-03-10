/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PullRequestManager } from '../github/pullRequestManager';
import * as vscode from 'vscode';
import { IssueHoverProvider } from './issueHoverProvider';
import { UserHoverProvider } from './userHoverProvider';
import { IssueTodoProvider } from './issueTodoProvider';
import { IssueCompletionProvider } from './issueCompletionProvider';
import { NewIssue, createGithubPermalink, USER_EXPRESSION, ISSUES_CONFIGURATION } from './util';
import { UserCompletionProvider } from './userCompletionProvider';
import { StateManager } from './stateManager';
import { IssuesTreeData } from './issuesView';
import { IssueModel } from '../github/issueModel';

export class IssueFeatureRegistrar implements vscode.Disposable {
	private _stateManager: StateManager;

	constructor(private manager: PullRequestManager) {
		this._stateManager = new StateManager(this.manager);
	}

	async initialize(context: vscode.ExtensionContext) {
		await this._stateManager.initialize(context);
		context.subscriptions.push(vscode.commands.registerCommand('issue.createIssueFromSelection', this.createTodoIssue, this));
		context.subscriptions.push(vscode.commands.registerCommand('issue.createIssueFromClipboard', this.createTodoIssueClipboard, this));
		context.subscriptions.push(vscode.commands.registerCommand('issue.copyGithubPermalink', this.copyPermalink, this));
		context.subscriptions.push(vscode.commands.registerCommand('issue.openGithubPermalink', this.openPermalink, this));
		context.subscriptions.push(vscode.commands.registerCommand('issue.openIssue', this.openIssue));
		context.subscriptions.push(vscode.commands.registerCommand('issue.copyIssueNumber', this.copyIssueNumber));
		context.subscriptions.push(vscode.commands.registerCommand('issue.copyIssueUrl', this.copyIssueUrl));
		context.subscriptions.push(vscode.commands.registerCommand('issue.refresh', this.refreshView, this));
		context.subscriptions.push(vscode.languages.registerHoverProvider('*', new IssueHoverProvider(this.manager, this._stateManager)));
		context.subscriptions.push(vscode.languages.registerHoverProvider('*', new UserHoverProvider(this.manager)));
		context.subscriptions.push(vscode.languages.registerCodeActionsProvider('*', new IssueTodoProvider(context)));
		context.subscriptions.push(vscode.languages.registerCompletionItemProvider('*', new IssueCompletionProvider(this._stateManager), '#'));
		context.subscriptions.push(vscode.languages.registerCompletionItemProvider('*', new UserCompletionProvider(this.manager, context), '@'));
		context.subscriptions.push(vscode.window.registerTreeDataProvider('issues:github', new IssuesTreeData(this._stateManager, context)));
	}

	dispose() { }

	refreshView() {
		this._stateManager.refreshCacheNeeded();
	}

	openIssue(issueModel: any) {
		if (issueModel instanceof IssueModel) {
			return vscode.env.openExternal(vscode.Uri.parse(issueModel.html_url));
		}
	}

	copyIssueNumber(issueModel: any) {
		if (issueModel instanceof IssueModel) {
			return vscode.env.clipboard.writeText(issueModel.number.toString());
		}
	}

	copyIssueUrl(issueModel: any) {
		if (issueModel instanceof IssueModel) {
			return vscode.env.clipboard.writeText(issueModel.html_url);
		}
	}

	async createTodoIssueClipboard() {
		return this.createTodoIssue(undefined, await vscode.env.clipboard.readText())
	}

	async createTodoIssue(newIssue?: NewIssue, issueBody?: string) {
		let document: vscode.TextDocument;
		let titlePlaceholder: string | undefined;
		let insertIndex: number | undefined;
		let lineNumber: number | undefined;
		let assignee: string | undefined;
		let issueGenerationText: string | undefined;
		if (!newIssue && vscode.window.activeTextEditor) {
			document = vscode.window.activeTextEditor.document;
			issueGenerationText = document.getText(vscode.window.activeTextEditor.selection);
		} else if (newIssue) {
			document = newIssue.document;
			insertIndex = newIssue.insertIndex;
			lineNumber = newIssue.lineNumber;
			titlePlaceholder = newIssue.line.substring(insertIndex, newIssue.line.length).trim();
			issueGenerationText = document.getText(newIssue.range.isEmpty ? document.lineAt(newIssue.range.start.line).range : newIssue.range);
		} else {
			return undefined;
		}
		const matches = issueGenerationText.match(USER_EXPRESSION);
		if (matches && matches.length === 2 && this._stateManager.userMap.has(matches[1])) {
			assignee = matches[1];
		}

		const title = await vscode.window.showInputBox({ value: titlePlaceholder, prompt: 'Issue title' });
		if (title) {
			const origin = await this.manager.getPullRequestDefaults();
			const body: string | undefined = issueBody ? issueBody : await createGithubPermalink(this.manager, newIssue);
			const issue = await this.manager.createIssue({
				owner: origin.owner,
				repo: origin.repo,
				title,
				body,
				assignee
			});
			if (issue) {
				if ((insertIndex !== undefined) && (lineNumber !== undefined)) {
					const edit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
					const insertText: string = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('createInsertFormat', 'number') === 'number' ? `#${issue.number}` : issue.html_url;
					edit.insert(document.uri, new vscode.Position(lineNumber, insertIndex), ` ${insertText}`);
					await vscode.workspace.applyEdit(edit);
				} else {
					await vscode.env.openExternal(vscode.Uri.parse(issue.html_url));
				}
				this._stateManager.refreshCacheNeeded();
			}
		}
	}

	private async getPermalinkWithError(): Promise<string | undefined> {
		const link: string | undefined = await createGithubPermalink(this.manager);
		if (!link) {
			vscode.window.showWarningMessage('Unable to create a GitHub permalink for the selection. Check that your local branch is tracking a remote branch.');
		}
		return link;
	}

	async copyPermalink() {
		const link = await this.getPermalinkWithError();
		if (link) {
			vscode.env.clipboard.writeText(link);
			vscode.window.showInformationMessage('Link copied to clipboard.');
		}
	}

	async openPermalink() {
		const link = await this.getPermalinkWithError();
		if (link) {
			vscode.env.openExternal(vscode.Uri.parse(link));
		}
	}
}