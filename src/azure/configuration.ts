/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export function trustedServerCollections(): readonly string[] {
	const configured = vscode.workspace.getConfiguration('azureDevOpsPullRequests').inspect<string[]>('serverCollections');
	const legacy = vscode.workspace.getConfiguration('azureDevOps').inspect<string[]>('serverCollections');
	return configured?.globalValue ?? legacy?.globalValue ?? [];
}
