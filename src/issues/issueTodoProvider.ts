/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ISSUE_OR_URL_EXPRESSION } from '../github/utils';
import { ISSUES_CONFIGURATION, MAX_LINE_LENGTH } from './util';

export class IssueTodoProvider implements vscode.CodeActionProvider {
	private expression: RegExp | undefined;

	constructor(context: vscode.ExtensionContext) {
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(() => {
				this.updateTriggers();
			}),
		);
		this.updateTriggers();
	}

	private updateTriggers() {
		const triggers = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('createIssueTriggers', []);
		this.expression = triggers.length > 0 ? new RegExp(triggers.join('|')) : undefined;
	}

	async provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
		_token: vscode.CancellationToken,
	): Promise<vscode.CodeAction[]> {
		if (this.expression === undefined || (context.only && context.only !== vscode.CodeActionKind.QuickFix)) {
			return [];
		}
		const codeActions: vscode.CodeAction[] = [];
		let lineNumber = range.start.line;
		do {
			const line = document.lineAt(lineNumber).text;
			const truncatedLine = line.substring(0, MAX_LINE_LENGTH);
			const matches = truncatedLine.match(ISSUE_OR_URL_EXPRESSION);
			if (!matches) {
				const search = truncatedLine.search(this.expression);
				if (search >= 0) {
					const codeAction: vscode.CodeAction = new vscode.CodeAction(
						'Create GitHub Issue',
						vscode.CodeActionKind.QuickFix,
					);
					const indexOfWhiteSpace = truncatedLine.substring(search).search(/\s/);
					const insertIndex =
						search +
						(indexOfWhiteSpace > 0 ? indexOfWhiteSpace : truncatedLine.match(this.expression)![0].length);
					codeAction.command = {
						title: 'Create GitHub Issue',
						command: 'issue.createIssueFromSelection',
						arguments: [{ document, lineNumber, line, insertIndex, range }],
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
