/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { getIssue } from './util';
import { CREATE_ISSUE_TRIGGERS, ISSUES_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { escapeRegExp } from '../common/utils';
import { RepositoriesManager } from '../github/repositoriesManager';
import { ISSUE_OR_URL_EXPRESSION, parseIssueExpressionOutput } from '../github/utils';

export class IssueTodoDiagnosticProvider {
	private diagnosticCollection: vscode.DiagnosticCollection;
	private expression: RegExp | undefined;

	constructor(
		context: vscode.ExtensionContext,
		private manager: RepositoriesManager,
		private stateManager: StateManager,
	) {
		this.diagnosticCollection = vscode.languages.createDiagnosticCollection('github-issues-todo');
		context.subscriptions.push(this.diagnosticCollection);

		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(ISSUES_SETTINGS_NAMESPACE)) {
					this.updateTriggers();
				}
			}),
		);

		context.subscriptions.push(
			vscode.workspace.onDidOpenTextDocument(document => {
				this.validateDocument(document);
			}),
		);

		context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument(e => {
				this.validateDocument(e.document);
			}),
		);

		context.subscriptions.push(
			vscode.workspace.onDidCloseTextDocument(document => {
				this.diagnosticCollection.delete(document.uri);
			}),
		);

		this.updateTriggers();

		// Validate all currently open documents
		vscode.workspace.textDocuments.forEach(document => {
			this.validateDocument(document);
		});
	}

	private updateTriggers() {
		const triggers = vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE).get(CREATE_ISSUE_TRIGGERS, []);
		this.expression = triggers.length > 0 ? new RegExp(triggers.map(trigger => escapeRegExp(trigger)).join('|')) : undefined;
	}

	private async validateDocument(document: vscode.TextDocument): Promise<void> {
		if (!this.expression) {
			return;
		}

		const folderManager = this.manager.getManagerForFile(document.uri);
		if (!folderManager) {
			return;
		}

		const diagnostics: vscode.Diagnostic[] = [];

		for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
			const line = document.lineAt(lineNumber);
			const lineText = line.text;

			// Check if line contains a TODO trigger
			if (!this.expression.test(lineText)) {
				continue;
			}

			// Look for issue references on this line
			const match = lineText.match(ISSUE_OR_URL_EXPRESSION);
			if (!match) {
				continue;
			}

			const parsed = parseIssueExpressionOutput(match);
			if (!parsed) {
				continue;
			}

			// Get the issue
			try {
				const issue = await getIssue(this.stateManager, folderManager, match[0], parsed);
				if (issue && issue.isClosed) {
					// Find the position of the issue reference
					const issueIndex = lineText.indexOf(match[0]);
					if (issueIndex !== -1) {
						const range = new vscode.Range(
							new vscode.Position(lineNumber, issueIndex),
							new vscode.Position(lineNumber, issueIndex + match[0].length)
						);

						const diagnostic = new vscode.Diagnostic(
							range,
							vscode.l10n.t('Issue #{0} is closed. Consider removing this TODO comment.', issue.number),
							vscode.DiagnosticSeverity.Warning
						);
						diagnostic.source = 'GitHub Issues';
						diagnostics.push(diagnostic);
					}
				}
			} catch (error) {
				// Silently ignore errors fetching issues
			}
		}

		this.diagnosticCollection.set(document.uri, diagnostics);
	}
}
