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
		const startAgentAction = actions.find(a => a.title === 'Start Coding Agent Session');

		assert.ok(createIssueAction, 'Should have Create GitHub Issue action');
		assert.ok(startAgentAction, 'Should have Start Coding Agent Session action');

		assert.strictEqual(createIssueAction?.command?.command, 'issue.createIssueFromSelection');
		assert.strictEqual(startAgentAction?.command?.command, 'issue.startCodingAgentFromTodo');
	});
});