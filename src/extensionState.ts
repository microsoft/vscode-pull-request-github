/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

// Synced keys
export const NEVER_SHOW_PULL_NOTIFICATION = 'github.pullRequest.pullNotification.show';

export function setSyncedKeys(context: vscode.ExtensionContext) {
	context.globalState.setKeysForSync([NEVER_SHOW_PULL_NOTIFICATION]);
}