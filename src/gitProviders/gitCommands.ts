/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

export namespace git {

	export async function checkout(): Promise<void> {
		try {
			await vscode.commands.executeCommand('git.checkout');
		} catch (e) {
			await vscode.commands.executeCommand('remoteHub.switchToBranch');
		}
	}

}