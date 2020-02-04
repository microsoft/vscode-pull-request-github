/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ISSUE_EXPRESSION } from './util';

export interface NewIssue {
	document: vscode.TextDocument;
	lineNumber: number;
	line: string;
	insertIndex: number;
	range: vscode.Range | vscode.Selection;
}

export class IssueTodoProvider implements vscode.CodeActionProvider {
	async provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<vscode.CodeAction[]> {
		const codeActions: vscode.CodeAction[] = [];
		let lineNumber = range.start.line;
		do {
			const line = document.lineAt(lineNumber).text;
			const index = line.toLowerCase().indexOf('todo');
			const matches = line.match(ISSUE_EXPRESSION);
			if ((index >= 0) && !matches) {
				const codeAction: vscode.CodeAction = new vscode.CodeAction('Create issue from TODO', vscode.CodeActionKind.QuickFix);
				codeAction.command = {
					title: 'Create Issue From TODO',
					command: 'issue.createIssueFromSelection',
					arguments: [{ document, lineNumber, line, insertIndex: index, range }]
				};
				codeActions.push(codeAction);
				break;
			}
			lineNumber++;
		} while (range.end.line >= lineNumber);
		return codeActions;
	}
}
