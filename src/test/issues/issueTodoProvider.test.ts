/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import * as issueUtil from '../../issues/util';

const mockCopilotManager: Partial<CopilotRemoteAgentManager> = {
	isAvailable: () => Promise.resolve(true)
}

describe('IssueTodoProvider', function () {
	// Mock isComment
	// We don't have a real 'vscode.TextDocument' in these tests, which
	// causes 'vscode.languages.getTokenInformationAtPosition' to throw.
	const originalIsComment = issueUtil.isComment;
	before(() => {
		(issueUtil as any).isComment = async (document: vscode.TextDocument, position: vscode.Position) => {
			try {
				const lineText = document.lineAt(position.line).text;
				return lineText.trim().startsWith('//');
			} catch {
				return false;
			}
		};
	});
	after(() => {
		(issueUtil as any).isComment = originalIsComment;
	});
});