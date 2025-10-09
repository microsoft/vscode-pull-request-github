/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MAX_LINE_LENGTH } from './util';
import { CODING_AGENT, CREATE_ISSUE_COMMENT_PREFIXES, CREATE_ISSUE_TRIGGERS, ISSUES_SETTINGS_NAMESPACE, SHOW_CODE_LENS } from '../common/settingKeys';
import { escapeRegExp } from '../common/utils';
import { CopilotRemoteAgentManager } from '../github/copilotRemoteAgent';
import { ISSUE_OR_URL_EXPRESSION } from '../github/utils';

export class IssueTodoProvider implements vscode.CodeActionProvider, vscode.CodeLensProvider {
	private expression: RegExp | undefined;
	private triggerTokens: string[] = [];
	private prefixTokens: string[] = [];

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
		const issuesConfig = vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE);
		this.triggerTokens = issuesConfig.get<string[]>(CREATE_ISSUE_TRIGGERS, []);
		this.prefixTokens = issuesConfig.get<string[]>(CREATE_ISSUE_COMMENT_PREFIXES, []);
		if (this.triggerTokens.length === 0 || this.prefixTokens.length === 0) {
			this.expression = undefined;
			return;
		}
		// Build a regex that captures the trigger word so we can highlight just that portion
		// ^\s*(?:prefix1|prefix2)\s*(trigger1|trigger2)\b
		const prefixesSource = this.prefixTokens.map(p => escapeRegExp(p)).join('|');
		const triggersSource = this.triggerTokens.map(t => escapeRegExp(t)).join('|');
		this.expression = new RegExp(`^\\s*(?:${prefixesSource})\\s*(${triggersSource})\\b`);
	}

	private findTodoInLine(line: string): { match: RegExpMatchArray; search: number; insertIndex: number } | undefined {
		if (!this.expression) {
			return undefined;
		}
		const truncatedLine = line.substring(0, MAX_LINE_LENGTH);
		// If the line already contains an issue reference or URL, skip
		if (ISSUE_OR_URL_EXPRESSION.test(truncatedLine)) {
			return undefined;
		}
		const match = this.expression.exec(truncatedLine);
		if (!match) {
			return undefined;
		}
		// match[1] is the captured trigger token
		const fullMatch = match[0];
		const trigger = match[1];
		// Find start of trigger within full line for highlighting
		const triggerStartInFullMatch = fullMatch.lastIndexOf(trigger); // safe since trigger appears once at end
		const search = match.index + triggerStartInFullMatch;
		const insertIndex = search + trigger.length;
		// Return a RegExpMatchArray-like structure; reuse match
		return { match, search, insertIndex };
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
						vscode.l10n.t('Delegate to coding agent'),
						vscode.CodeActionKind.QuickFix,
					);
					startAgentAction.ranges = [new vscode.Range(lineNumber, search, lineNumber, search + match[0].length)];
					startAgentAction.command = {
						title: vscode.l10n.t('Delegate to coding agent'),
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
			const line = document.lineAt(lineNumber).text;
			const todoInfo = this.findTodoInLine(line);
			if (todoInfo) {
				const { match, search, insertIndex } = todoInfo;
				const range = new vscode.Range(lineNumber, search, lineNumber, search + match[0].length);
				if (this.copilotRemoteAgentManager && (await this.copilotRemoteAgentManager.isAvailable())) {
					const startAgentCodeLens = new vscode.CodeLens(range, {
						title: vscode.l10n.t('Delegate to coding agent'),
						command: 'issue.startCodingAgentFromTodo',
						arguments: [{ document, lineNumber, line, insertIndex, range }],
					});
					codeLenses.push(startAgentCodeLens);
				}
			}
		}
		return codeLenses;
	}
}
