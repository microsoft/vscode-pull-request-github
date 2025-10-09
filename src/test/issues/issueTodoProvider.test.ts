/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { IssueTodoProvider } from '../../issues/issueTodoProvider';

describe('IssueTodoProvider', function () {
	it('should provide both actions when CopilotRemoteAgentManager is available', async function () {
		const mockContext = {
			subscriptions: []
		} as any as vscode.ExtensionContext;

		const mockCopilotManager = {} as any; // Mock CopilotRemoteAgentManager

		// Mock configuration for triggers and prefixes
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === 'githubIssues') {
				return {
					get: (key: string, defaultValue?: any) => {
						if (key === 'createIssueTriggers') { return ['TODO']; }
						if (key === 'createIssueCommentPrefixes') { return ['//']; }
						return defaultValue;
					}
				} as any;
			}
			return originalGetConfiguration(section);
		};

		const provider = new IssueTodoProvider(mockContext, mockCopilotManager);

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

		const mockCopilotManager = {} as any; // Mock CopilotRemoteAgentManager

		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === 'githubIssues') {
				return {
					get: (key: string, defaultValue?: any) => {
						if (key === 'createIssueTriggers') { return ['TODO']; }
						if (key === 'createIssueCommentPrefixes') { return ['//', '#']; }
						return defaultValue;
					}
				} as any;
			}
			return originalGetConfiguration(section);
		};
		const provider = new IssueTodoProvider(mockContext, mockCopilotManager);

		// Create a mock document with TODO comment
		const document = {
			lineAt: (line: number) => ({
				text: line === 1 ? '  // TODO: Fix this' : 'function test() {}'
			}),
			lineCount: 4
		} as vscode.TextDocument;

		const codeLenses = await provider.provideCodeLenses(document, new vscode.CancellationTokenSource().token);

		assert.strictEqual(codeLenses.length, 2);

		// Verify the code lenses
		const createIssueLens = codeLenses.find(cl => cl.command?.title === 'Create GitHub Issue');
		const startAgentLens = codeLenses.find(cl => cl.command?.title === 'Delegate to coding agent');

		assert.ok(createIssueLens, 'Should have Create GitHub Issue CodeLens');
		assert.ok(startAgentLens, 'Should have Delegate to coding agent CodeLens');

		assert.strictEqual(createIssueLens?.command?.command, 'issue.createIssueFromSelection');
		assert.strictEqual(startAgentLens?.command?.command, 'issue.startCodingAgentFromTodo');

		// Verify the range points to the TODO text
		assert.strictEqual(createIssueLens?.range.start.line, 1);
		assert.strictEqual(startAgentLens?.range.start.line, 1);
	});

	it('should respect the createIssueCodeLens setting', async function () {
		const mockContext = {
			subscriptions: []
		} as any as vscode.ExtensionContext;

		const mockCopilotManager = {} as any; // Mock CopilotRemoteAgentManager

		const provider = new IssueTodoProvider(mockContext, mockCopilotManager);

		// Create a mock document with TODO comment
		const document = {
			lineAt: (line: number) => ({
				text: line === 1 ? '  // TODO: Fix this' : 'function test() {}'
			}),
			lineCount: 4
		} as vscode.TextDocument;

		// Mock the workspace configuration to return false for createIssueCodeLens
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === 'githubIssues') {
				return {
					get: (key: string, defaultValue?: any) => {
						if (key === 'createIssueCodeLens') {
							return false;
						}
						if (key === 'createIssueTriggers') {
							return ['TODO', 'todo', 'BUG', 'FIXME', 'ISSUE', 'HACK'];
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

	it('should not trigger on line without comment prefix', async function () {
		const mockContext = { subscriptions: [] } as any as vscode.ExtensionContext;
		const mockCopilotManager = {} as any;

		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === 'githubIssues') {
				return {
					get: (key: string, defaultValue?: any) => {
						if (key === 'createIssueTriggers') { return ['DEBUG_RUN']; }
						if (key === 'createIssueCommentPrefixes') { return ['//']; }
						return defaultValue;
					}
				} as any;
			}
			return originalGetConfiguration(section);
		};

		const provider = new IssueTodoProvider(mockContext, mockCopilotManager);

		const testLine = "\tregisterTouchBarEntry(DEBUG_RUN_COMMAND_ID, DEBUG_RUN_LABEL, 0, CONTEXT_IN_DEBUG_MODE.toNegated(), FileAccess.asFileUri('vs/workbench/contrib/debug/browser/media/continue-tb.png'));";
		const document = {
			lineAt: (_line: number) => ({ text: testLine }),
			lineCount: 1
		} as vscode.TextDocument;

		const codeLenses = await provider.provideCodeLenses(document, new vscode.CancellationTokenSource().token);
		assert.strictEqual(codeLenses.length, 0, 'Should not create CodeLens for trigger inside code without prefix');

		vscode.workspace.getConfiguration = originalGetConfiguration; // restore
	});
});