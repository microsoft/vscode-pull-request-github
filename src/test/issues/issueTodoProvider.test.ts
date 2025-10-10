/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { IssueTodoProvider } from '../../issues/issueTodoProvider';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { CODING_AGENT, CREATE_ISSUE_TRIGGERS, ISSUES_SETTINGS_NAMESPACE, SHOW_CODE_LENS } from '../../common/settingKeys';

const mockCopilotManager: Partial<CopilotRemoteAgentManager> = {
	isAvailable: () => Promise.resolve(true)
}

describe('IssueTodoProvider', function () {
	it('should provide both actions when CopilotRemoteAgentManager is available', async function () {
		const mockContext = {
			subscriptions: []
		} as any as vscode.ExtensionContext;


		const provider = new IssueTodoProvider(mockContext, mockCopilotManager as CopilotRemoteAgentManager);

		// Create a mock document with TODO comment
		const document = {
			lineAt: (line: number) => ({ text: line === 1 ? '  // TODO: Fix this' : 'function test() {' }),
			lineCount: 4
		} as vscode.TextDocument;

		const range = new vscode.Range(1, 0, 1, 20);
		const context = {
			only: vscode.CodeActionKind.QuickFix
		} as vscode.CodeActionContext;

		const actions = await provider.provideCodeActions(document, range, context, new vscode.CancellationTokenSource().token);

		assert.strictEqual(actions.length, 2);

		// Find the actions
		const createIssueAction = actions.find(a => a.title === 'Create GitHub Issue');
		const startAgentAction = actions.find(a => a.title === 'Delegate to coding agent');

		assert.ok(createIssueAction, 'Should have Create GitHub Issue action');
		assert.ok(startAgentAction, 'Should have Delegate to coding agent action');

		assert.strictEqual(createIssueAction?.command?.command, 'issue.createIssueFromSelection');
		assert.strictEqual(startAgentAction?.command?.command, 'issue.startCodingAgentFromTodo');
	});

	it('should provide code lenses for TODO comments', async function () {
		const mockContext = {
			subscriptions: []
		} as any as vscode.ExtensionContext;

		const provider = new IssueTodoProvider(mockContext, mockCopilotManager as CopilotRemoteAgentManager);

		// Create a mock document with TODO comment
		const document = {
			lineAt: (line: number) => ({
				text: line === 1 ? '  // TODO: Fix this' : 'function test() {}'
			}),
			lineCount: 4
		} as vscode.TextDocument;

		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === ISSUES_SETTINGS_NAMESPACE) {
				return {
					get: (key: string, defaultValue?: any) => {
						if (key === CREATE_ISSUE_TRIGGERS) {
							return ['TODO', 'todo', 'BUG', 'FIXME', 'ISSUE', 'HACK'];
						}
						return defaultValue;
					}
				} as any;
			} else if (section === CODING_AGENT) {
				return {
					get: (key: string, defaultValue?: any) => {
						if (key === SHOW_CODE_LENS) {
							return true;
						}
						return defaultValue;
					}
				} as any;
			}
			return originalGetConfiguration(section);
		};

		try {
			// Update triggers to ensure the expression is set
			(provider as any).updateTriggers();

			const codeLenses = await provider.provideCodeLenses(document, new vscode.CancellationTokenSource().token);

			assert.strictEqual(codeLenses.length, 1);

			// Verify the code lenses
			const startAgentLens = codeLenses.find(cl => cl.command?.title === 'Delegate to coding agent');

			assert.ok(startAgentLens, 'Should have Delegate to coding agent CodeLens');

			assert.strictEqual(startAgentLens?.command?.command, 'issue.startCodingAgentFromTodo');

			// Verify the range points to the TODO text
			assert.strictEqual(startAgentLens?.range.start.line, 1);
		} finally {
			// Restore original configuration
			vscode.workspace.getConfiguration = originalGetConfiguration;
		}
	});

	it('should not provide code lenses when codeLens setting is disabled', async function () {
		const mockContext = {
			subscriptions: []
		} as any as vscode.ExtensionContext;

		const provider = new IssueTodoProvider(mockContext, mockCopilotManager as CopilotRemoteAgentManager);

		// Create a mock document with TODO comment
		const document = {
			lineAt: (line: number) => ({
				text: line === 1 ? '  // TODO: Fix this' : 'function test() {}'
			}),
			lineCount: 4
		} as vscode.TextDocument;

		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === ISSUES_SETTINGS_NAMESPACE) {
				return {
					get: (key: string, defaultValue?: any) => {
						if (key === CREATE_ISSUE_TRIGGERS) {
							return ['TODO', 'todo', 'BUG', 'FIXME', 'ISSUE', 'HACK'];
						}
						return defaultValue;
					}
				} as any;
			} else if (section === CODING_AGENT) {
				return {
					get: (key: string, defaultValue?: any) => {
						if (key === SHOW_CODE_LENS) {
							return false;
						}
						return defaultValue;
					}
				} as any;
			}
			return originalGetConfiguration(section);
		};

		try {
			// Update triggers to ensure the expression is set
			(provider as any).updateTriggers();

			const codeLenses = await provider.provideCodeLenses(document, new vscode.CancellationTokenSource().token);

			// Should return empty array when CodeLens is disabled
			assert.strictEqual(codeLenses.length, 0, 'Should not provide code lenses when setting is disabled');
		} finally {
			// Restore original configuration
			vscode.workspace.getConfiguration = originalGetConfiguration;
		}
	});
});