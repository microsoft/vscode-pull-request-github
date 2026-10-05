/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';

/** Reuse the returned stubs instead of wrapping the VS Code APIs again. */
export function mockTreeViewWorkbench(sinon: SinonSandbox): { createTreeView: SinonStub; executeCommand: SinonStub } {
	const executeCommand = sinon.stub(vscode.commands, 'executeCommand').callsFake(async command => {
		assert.strictEqual(command, 'setContext', 'Tree fixtures must not execute workbench commands');
		return undefined;
	});
	const noEvent: vscode.Event<never> = () => new vscode.Disposable(() => { });
	const createTreeView = sinon.stub(vscode.window, 'createTreeView').callsFake(<T>(): vscode.TreeView<T> => ({
		onDidExpandElement: noEvent,
		onDidCollapseElement: noEvent,
		onDidChangeSelection: noEvent,
		onDidChangeVisibility: noEvent,
		onDidChangeCheckboxState: noEvent,
		selection: [],
		visible: false,
		reveal: async () => { },
		dispose: () => { },
	}));
	return { createTreeView, executeCommand };
}
