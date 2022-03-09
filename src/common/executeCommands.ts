/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export namespace commands {
	export function executeCommand(command: string) {
		return vscode.commands.executeCommand(command);
	}

	export function focusView(viewId: string) {
		return executeCommand(`${viewId}.focus`);
	}
}