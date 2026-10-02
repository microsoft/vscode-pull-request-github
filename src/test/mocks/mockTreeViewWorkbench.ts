/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';

export function mockTreeViewWorkbench(sinon: SinonSandbox): SinonStub {
	sinon.stub(vscode.commands, 'executeCommand').callsFake(async command => {
		assert.strictEqual(command, 'setContext', 'Tree fixtures must not execute workbench commands');
		return undefined;
	});
	const noEvent: vscode.Event<never> = () => new vscode.Disposable(() => { });
	return sinon.stub(vscode.window, 'createTreeView').callsFake(<T>(): vscode.TreeView<T> => ({
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
}
