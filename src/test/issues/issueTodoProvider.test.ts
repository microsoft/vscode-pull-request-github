/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import * as vscode from 'vscode';
import { IssueTodoProvider } from '../../issues/issueTodoProvider';

// Simple factory for a CopilotRemoteAgentManager mock that always reports availability.
function createAvailableCopilotManager() {
	return { isAvailable: async () => true } as any;
}

describe('IssueTodoProvider', function () {
	it('should provide both actions when CopilotRemoteAgentManager is available', async function () {
		const mockContext = {
			subscriptions: []
		} as any as vscode.ExtensionContext;

		const mockCopilotManager = createAvailableCopilotManager();

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
			lineAt: (line: number) => ({ text: line === 1 ? '  // TODO: Fix this' : '// DEBUG: function test() {' }),
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

	it('prefix matrix detection', async function () {
		const mockContext = { subscriptions: [] } as any as vscode.ExtensionContext;
		const mockCopilotManager = createAvailableCopilotManager();

		const testCases: { testLine: string; expected: boolean; note?: string }[] = [
			{ testLine: ' // TODO implement feature', expected: true },
			{ testLine: '\t//TODO implement feature', expected: true },
			{ testLine: ' # TODO spaced hash', expected: true },
			{ testLine: '-- TODO dash dash', expected: true },
			{ testLine: ' * TODO docblock star', expected: true },
			{ testLine: '   *     TODO extra spaces after star', expected: true },
			{ testLine: '/// TODO rust style', expected: true },
			{ testLine: '///TODO rust tight', expected: true },
			{ testLine: 'let x = 0; // TODO not at line start so should not match', expected: false }, // TODO: Detect inline TODO comments
			{ testLine: ' *TODO (no space after star)', expected: false },
			{ testLine: ' * NotATrigger word', expected: false },
			{ testLine: '/* TODO inside block start should not (prefix not configured)', expected: false },
			{ testLine: 'random text TODO (no prefix)', expected: false },
			{ testLine: '#TODO tight hash', expected: true },
			{ testLine: 'registerTouchBarEntry(DEBUG_RUN_COMMAND_ID, DEBUG_RUN_LABEL, 0, CONTEXT_IN_DEBUG_MODE.toNegated(), FileAccess.asFileUri(\'vs/workbench/contrib/debug/browser/media/continue-tb.png\')', expected: false }
		];

		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === 'githubIssues') {
				return {
					get: (key: string, defaultValue?: any) => {
						if (key === 'createIssueTriggers') { return ['TODO']; }
						if (key === 'createIssueCommentPrefixes') { return ['//', '#', '--', ' * ', '///']; }
						return defaultValue;
					}
				} as any;
			}
			if (section === 'githubPullRequests.codingAgent') {
				return { get: () => true } as any;
			}
			return originalGetConfiguration(section);
		};

		try {
			const provider = new IssueTodoProvider(mockContext, mockCopilotManager);
			for (const tc of testCases) {
				const document = {
					lineAt: (_line: number) => ({ text: tc.testLine }),
					lineCount: 1
				} as vscode.TextDocument;
				const codeLenses = await provider.provideCodeLenses(document, new vscode.CancellationTokenSource().token);
				const detected = codeLenses.length > 0;
				assert.strictEqual(detected, tc.expected, `Unexpected result (expected=${tc.expected}) for line: "${tc.testLine}"`);
			}
		} finally {
			vscode.workspace.getConfiguration = originalGetConfiguration;
		}
	});
});