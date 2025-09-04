/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CREATE_ISSUE_TRIGGERS, ISSUES_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { escapeRegExp } from '../common/utils';
import { CopilotRemoteAgentManager } from '../github/copilotRemoteAgent';
import { ISSUE_OR_URL_EXPRESSION } from '../github/utils';
import { MAX_LINE_LENGTH } from './util';

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
				const match = truncatedLine.match(this.expression);
				const search = match?.index ?? -1;
				if (search >= 0 && match) {
					// Create GitHub Issue action
					const createIssueAction: vscode.CodeAction = new vscode.CodeAction(
						vscode.l10n.t('Create GitHub Issue'),
						vscode.CodeActionKind.QuickFix,
					);
					createIssueAction.ranges = [new vscode.Range(lineNumber, search, lineNumber, search + match[0].length)];
					const indexOfWhiteSpace = truncatedLine.substring(search).search(/\s/);
					const insertIndex =
						search +
						(indexOfWhiteSpace > 0 ? indexOfWhiteSpace : truncatedLine.match(this.expression)![0].length);
					createIssueAction.command = {
						title: vscode.l10n.t('Create GitHub Issue'),
						command: 'issue.createIssueFromSelection',
						arguments: [{ document, lineNumber, line, insertIndex, range }],
					};
					codeActions.push(createIssueAction);

					// Start Coding Agent Session action (if copilot manager is available)
					if (this.copilotRemoteAgentManager) {
						const startAgentAction: vscode.CodeAction = new vscode.CodeAction(
							vscode.l10n.t('Start Coding Agent Session'),
							vscode.CodeActionKind.QuickFix,
						);
						startAgentAction.ranges = [new vscode.Range(lineNumber, search, lineNumber, search + match[0].length)];
						startAgentAction.command = {
							title: vscode.l10n.t('Start Coding Agent Session'),
							command: 'issue.startCodingAgentFromTodo',
							arguments: [{ document, lineNumber, line, insertIndex, range }],
						};
						codeActions.push(startAgentAction);
					}
					break;
				}
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

		const codeLenses: vscode.CodeLens[] = [];
		for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
			const line = document.lineAt(lineNumber).text;
			const truncatedLine = line.substring(0, MAX_LINE_LENGTH);
			const matches = truncatedLine.match(ISSUE_OR_URL_EXPRESSION);

			if (!matches) {
				const match = truncatedLine.match(this.expression);
				const search = match?.index ?? -1;
				if (search >= 0 && match) {
					const indexOfWhiteSpace = truncatedLine.substring(search).search(/\s/);
					const insertIndex =
						search +
						(indexOfWhiteSpace > 0 ? indexOfWhiteSpace : truncatedLine.match(this.expression)![0].length);

					const range = new vscode.Range(lineNumber, search, lineNumber, search + match[0].length);

					// Only show "Start Coding Agent Session" code lens if copilot manager is available
					if (this.copilotRemoteAgentManager) {
						const startAgentCodeLens = new vscode.CodeLens(range, {
							title: vscode.l10n.t('Start Coding Agent Session'),
							command: 'issue.startCodingAgentFromTodo',
							arguments: [{ document, lineNumber, line, insertIndex, range }],
						});
						codeLenses.push(startAgentCodeLens);
					}
				}
			}
		}
		return codeLenses;
	}

	resolveCodeLens(
		codeLens: vscode.CodeLens,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.CodeLens> {
		// Code lens is already resolved in provideCodeLenses
		return codeLens;
	}
}
