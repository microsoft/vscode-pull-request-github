/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PullRequestManager } from '../github/pullRequestManager';
import * as vscode from 'vscode';
import { NewIssue } from './issueTodoProvider';
import { IssueHoverProvider } from './issueHoverProvider';
import * as LRUCache from 'lru-cache';
import { IssueLinkProvider } from './issueLinkProvider';
import { UserHoverProvider } from './userHoverProvider';
import { IssueTodoProvider } from './issueTodoProvider';
import { PullRequestModel } from '../github/pullRequestModel';
import { IssueCompletionProvider } from './issueCompletionProvider';

export class IssueFeatureRegistrar implements vscode.Disposable {
	constructor(context: vscode.ExtensionContext, private manager: PullRequestManager) {
		const resolvedIssues: LRUCache<string, PullRequestModel> = new LRUCache(50); // 50 seems big enough
		context.subscriptions.push(vscode.commands.registerCommand('issue.createIssueFromSelection', this.createTodoIssue, this));
		context.subscriptions.push(vscode.languages.registerHoverProvider('*', new IssueHoverProvider(manager, resolvedIssues)));
		context.subscriptions.push(vscode.languages.registerHoverProvider('*', new UserHoverProvider(manager)));
		context.subscriptions.push(vscode.languages.registerDocumentLinkProvider('*', new IssueLinkProvider(manager, resolvedIssues)));
		context.subscriptions.push(vscode.languages.registerCodeActionsProvider('*', new IssueTodoProvider()));
		context.subscriptions.push(vscode.languages.registerCompletionItemProvider('*', new IssueCompletionProvider(manager, context), '#'));
	}

	dispose() { }

	async createTodoIssue(newIssue?: NewIssue) {
		let document: vscode.TextDocument;
		let titlePlaceholder: string | undefined;
		let insertIndex: number | undefined;
		let lineNumber: number | undefined;
		let range: vscode.Range;
		if (!newIssue && vscode.window.activeTextEditor) {
			document = vscode.window.activeTextEditor.document;
			range = vscode.window.activeTextEditor.selection;
		} else if (newIssue) {
			document = newIssue.document;
			insertIndex = newIssue.insertIndex;
			lineNumber = newIssue.lineNumber;
			titlePlaceholder = newIssue.line.substring(insertIndex + 4, newIssue.line.length).trim();
			range = newIssue.range;
		} else {
			return undefined;
		}

		const title = await vscode.window.showInputBox({ value: titlePlaceholder, prompt: 'Issue title' });
		if (title) {
			const origin = await this.manager.getOrigin();
			let issueBody: string | undefined;
			if (this.manager.repository.state.HEAD && this.manager.repository.state.HEAD.commit && (this.manager.repository.state.HEAD.ahead === 0)) {
				issueBody = `https://github.com/${origin.remote.owner}/${origin.remote.repositoryName}/blob/${this.manager.repository.state.HEAD.commit}/${vscode.workspace.asRelativePath(document.uri)}#L${range.start.line + 1}-L${range.end.line + 1}`;
			} else if (this.manager.repository.state.HEAD && this.manager.repository.state.HEAD.ahead && (this.manager.repository.state.HEAD.ahead > 0)) {
				issueBody = `https://github.com/${origin.remote.owner}/${origin.remote.repositoryName}/blob/${this.manager.repository.state.HEAD.upstream!.name}/${vscode.workspace.asRelativePath(document.uri)}#L${range.start.line + 1}-L${range.end.line + 1}`;
			}
			const issue = await this.manager.createIssue({
				owner: origin.remote.owner,
				repo: origin.remote.repositoryName,
				title,
				body: issueBody
			});
			if (issue) {
				if ((insertIndex !== undefined) && (lineNumber !== undefined)) {
					const edit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
					edit.insert(document.uri, new vscode.Position(lineNumber, insertIndex + 4), ` #${issue.number}`);
					await vscode.workspace.applyEdit(edit);
				} else {
					await vscode.env.openExternal(vscode.Uri.parse(issue.html_url));
				}
			}
		}
	}
}