/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PullRequestManager } from '../github/pullRequestManager';
import * as vscode from 'vscode';
import { IssueHoverProvider } from './issueHoverProvider';
import * as LRUCache from 'lru-cache';
import { IssueLinkProvider } from './issueLinkProvider';
import { UserHoverProvider } from './userHoverProvider';
import { IssueTodoProvider } from './issueTodoProvider';
import { PullRequestModel } from '../github/pullRequestModel';
import { IssueCompletionProvider } from './issueCompletionProvider';
import { NewIssue, createGithubPermalink } from './util';
import { UserCompletionProvider } from './userCompletionProvider';

export class IssueFeatureRegistrar implements vscode.Disposable {
	constructor(context: vscode.ExtensionContext, private manager: PullRequestManager) {
		const resolvedIssues: LRUCache<string, PullRequestModel> = new LRUCache(50); // 50 seems big enough
		context.subscriptions.push(vscode.commands.registerCommand('issue.createIssueFromSelection', this.createTodoIssue, this));
		context.subscriptions.push(vscode.commands.registerCommand('issue.copyGithubPermalink', this.copyPermalink, this));
		context.subscriptions.push(vscode.commands.registerCommand('issue.openGithubPermalink', this.openPermalink, this));
		context.subscriptions.push(vscode.languages.registerHoverProvider('*', new IssueHoverProvider(manager, resolvedIssues)));
		context.subscriptions.push(vscode.languages.registerHoverProvider('*', new UserHoverProvider(manager)));
		context.subscriptions.push(vscode.languages.registerDocumentLinkProvider('*', new IssueLinkProvider(manager, resolvedIssues)));
		context.subscriptions.push(vscode.languages.registerCodeActionsProvider('*', new IssueTodoProvider(context)));
		context.subscriptions.push(vscode.languages.registerCompletionItemProvider('*', new IssueCompletionProvider(manager, context), '#'));
		context.subscriptions.push(vscode.languages.registerCompletionItemProvider('*', new UserCompletionProvider(manager, context), '@'));
	}

	dispose() { }

	async createTodoIssue(newIssue?: NewIssue) {
		let document: vscode.TextDocument;
		let titlePlaceholder: string | undefined;
		let insertIndex: number | undefined;
		let lineNumber: number | undefined;
		if (!newIssue && vscode.window.activeTextEditor) {
			document = vscode.window.activeTextEditor.document;
		} else if (newIssue) {
			document = newIssue.document;
			insertIndex = newIssue.insertIndex;
			lineNumber = newIssue.lineNumber;
			titlePlaceholder = newIssue.line.substring(insertIndex, newIssue.line.length).trim();
		} else {
			return undefined;
		}

		const title = await vscode.window.showInputBox({ value: titlePlaceholder, prompt: 'Issue title' });
		if (title) {
			const origin = await this.manager.getOrigin();
			const issueBody: string | undefined = await createGithubPermalink(this.manager, newIssue);
			const issue = await this.manager.createIssue({
				owner: origin.remote.owner,
				repo: origin.remote.repositoryName,
				title,
				body: issueBody
			});
			if (issue) {
				if ((insertIndex !== undefined) && (lineNumber !== undefined)) {
					const edit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
					edit.insert(document.uri, new vscode.Position(lineNumber, insertIndex), ` #${issue.number}`);
					await vscode.workspace.applyEdit(edit);
				} else {
					await vscode.env.openExternal(vscode.Uri.parse(issue.html_url));
				}
			}
		}
	}

	private async getPermalinkWithError(): Promise<string | undefined> {
		const link: string | undefined = await createGithubPermalink(this.manager);
		if (!link) {
			vscode.window.showWarningMessage('Unable to create a GitHub permalink for the selection.');
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