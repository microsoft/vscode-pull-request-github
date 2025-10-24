/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isComment, MAX_LINE_LENGTH } from './util';
import { CODING_AGENT, CREATE_ISSUE_TRIGGERS, ISSUES_SETTINGS_NAMESPACE, SHOW_CODE_LENS } from '../common/settingKeys';
import { escapeRegExp } from '../common/utils';
import { CopilotRemoteAgentManager } from '../github/copilotRemoteAgent';
import { ISSUE_OR_URL_EXPRESSION } from '../github/utils';

export class IssueTodoProvider implements vscode.CodeActionProvider, vscode.CodeLensProvider {
	private expression: RegExp | undefined;

	constructor(
		context: vscode.ExtensionContext,
		private copilotRemoteAgentManager: CopilotRemoteAgentManager
	) {
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(() => {
				this.updateTriggers();
			}),
		);
		this.updateTriggers();
	}

	private updateTriggers() {
		const triggers = vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE).get(CREATE_ISSUE_TRIGGERS, []);
		this.expression = triggers.length > 0 ? new RegExp(triggers.map(trigger => escapeRegExp(trigger)).join('|')) : undefined;
	}

	private findTodoInLine(line: string): { match: RegExpMatchArray; search: number; insertIndex: number } | undefined {
		const truncatedLine = line.substring(0, MAX_LINE_LENGTH);
		const matches = truncatedLine.match(ISSUE_OR_URL_EXPRESSION);
		if (matches) {
			return undefined;
		}
		const match = truncatedLine.match(this.expression!);
		const search = match?.index ?? -1;
		if (search >= 0 && match) {
			const indexOfWhiteSpace = truncatedLine.substring(search).search(/\s/);
			const insertIndex =
				search +
				(indexOfWhiteSpace > 0 ? indexOfWhiteSpace : truncatedLine.match(this.expression!)![0].length);
			return { match, search, insertIndex };
		}
		return undefined;
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
			const todoInfo = this.findTodoInLine(line);
			if (todoInfo) {
				const { match, search, insertIndex } = todoInfo;
				// Create GitHub Issue action
				const createIssueAction: vscode.CodeAction = new vscode.CodeAction(
					vscode.l10n.t('Create GitHub Issue'),
					vscode.CodeActionKind.QuickFix,
				);
				createIssueAction.ranges = [new vscode.Range(lineNumber, search, lineNumber, search + match[0].length)];
				createIssueAction.command = {
					title: vscode.l10n.t('Create GitHub Issue'),
					command: 'issue.createIssueFromSelection',
					arguments: [{ document, lineNumber, line, insertIndex, range }],
				};
				codeActions.push(createIssueAction);

				// Start Coding Agent Session action (if copilot manager is available)
				if (this.copilotRemoteAgentManager) {
					const startAgentAction: vscode.CodeAction = new vscode.CodeAction(
						vscode.l10n.t('Delegate to agent'),
						vscode.CodeActionKind.QuickFix,
					);
					startAgentAction.ranges = [new vscode.Range(lineNumber, search, lineNumber, search + match[0].length)];
					startAgentAction.command = {
						title: vscode.l10n.t('Delegate to agent'),
						command: 'issue.startCodingAgentFromTodo',
						arguments: [{ document, lineNumber, line, insertIndex, range }],
					};
					codeActions.push(startAgentAction);
				}
				break;
			}
			lineNumber++;
		} while (range.end.line >= lineNumber);
		return codeActions;
	}

	async provideCodeLenses(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): Promise<vscode.CodeLens[]> {
		if (this.expression === undefined) {
			return [];
		}

		// Check if CodeLens is enabled
		const isCodeLensEnabled = vscode.workspace.getConfiguration(CODING_AGENT).get(SHOW_CODE_LENS, true);
		if (!isCodeLensEnabled) {
			return [];
		}

		const codeLenses: vscode.CodeLens[] = [];
		for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
			const textLine = document.lineAt(lineNumber);
			const { text: line, firstNonWhitespaceCharacterIndex } = textLine;
			const todoInfo = this.findTodoInLine(line);
			if (!todoInfo) {
				continue;
			}
			if (!(await isComment(document, new vscode.Position(lineNumber, firstNonWhitespaceCharacterIndex), []))) {
				continue;
			}
			const { match, search, insertIndex } = todoInfo;
			const range = new vscode.Range(lineNumber, search, lineNumber, search + match[0].length);
			if (this.copilotRemoteAgentManager && (await this.copilotRemoteAgentManager.isAvailable())) {
				const startAgentCodeLens = new vscode.CodeLens(range, {
					title: vscode.l10n.t('Delegate to agent'),
					command: 'issue.startCodingAgentFromTodo',
					arguments: [{ document, lineNumber, line, insertIndex, range }],
				});
				codeLenses.push(startAgentCodeLens);
			}
		}
		return codeLenses;
	}
}
