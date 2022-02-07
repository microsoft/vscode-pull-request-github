/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import
{ IAccount } from './github/interface';


// Synced keys
export const NEVER_SHOW_PULL_NOTIFICATION = 'github.pullRequest.pullNotification.show';

// Not synced keys
export const REPO_KEYS = 'github.pullRequest.repos';

export interface RepoState {
	mentionableUsers?: IAccount[];

	stateModifiedTime?: number;

}

export interface ReposState {
	repos: { [ownerAndRepo: string]: RepoState };
}

export function setSyncedKeys(context: vscode.ExtensionContext) {
	context.globalState.setKeysForSync([NEVER_SHOW_PULL_NOTIFICATION]);
}

