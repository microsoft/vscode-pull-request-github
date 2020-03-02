/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as LRUCache from 'lru-cache';
import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';
import { IAccount } from '../github/interface';
import { PullRequestManager, PRManagerState } from '../github/pullRequestManager';

export class StateManager {
	public readonly resolvedIssues: LRUCache<string, IssueModel> = new LRUCache(50); // 50 seems big enough
	public readonly userMap: Map<string, IAccount> = new Map();

	async initialize(manager: PullRequestManager, context: vscode.ExtensionContext) {
		return new Promise(resolve => {
			if (manager.state === PRManagerState.RepositoriesLoaded) {
				this.setUsers(manager);
				resolve();
			} else {
				const disposable = manager.onDidChangeState(() => {
					if (manager.state === PRManagerState.RepositoriesLoaded) {
						this.setUsers(manager);
						disposable.dispose();
						resolve();
					}
				});
				context.subscriptions.push(disposable);
			}
		});
	}

	async setUsers(manager: PullRequestManager) {
		const assignableUsers = await manager.getAssignableUsers();
		for (const remote in assignableUsers) {
			assignableUsers[remote].forEach(account => {
				this.userMap.set(account.login, account);
			});
		}
	}
}