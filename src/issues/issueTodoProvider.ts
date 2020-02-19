/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ISSUE_OR_URL_EXPRESSION } from './util';

export class IssueTodoProvider implements vscode.CodeActionProvider {
	private expression: RegExp;

	constructor(context: vscode.ExtensionContext) {
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(() => {
			this.updateTriggers();
		}));
		this.updateTriggers();
	}

	private updateTriggers() {
		const triggers = vscode.workspace.getConfiguration('githubIssues').get('createIssueTriggers', []);
		this.expression = new RegExp(triggers.join('|'));
	}

	async provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<vscode.CodeAction[]> {
		const codeActions: vscode.CodeAction[] = [];
		let lineNumber = range.start.line;
		do {
			const line = document.lineAt(lineNumber).text;
			const matches = line.match(ISSUE_OR_URL_EXPRESSION);
			if (!matches) {
				const search = line.search(this.expression);
				if (search >= 0) {
					const match = line.match(this.expression);
					const codeAction: vscode.CodeAction = new vscode.CodeAction('Create issue from comment', vscode.CodeActionKind.QuickFix);
					codeAction.command = {
						title: 'Create Issue From Comment',
						command: 'issue.createIssueFromSelection',
						arguments: [{ document, lineNumber, line, insertIndex: search + match![0].length, range }]
					};
					codeActions.push(codeAction);
					break;
				}
			}
			lineNumber++;
		} while (range.end.line >= lineNumber);
		return codeActions;
	}
}
