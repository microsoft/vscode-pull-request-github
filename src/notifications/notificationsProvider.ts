/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthProvider } from "../common/authentication";
import { CredentialStore, GitHub } from "../github/credentials";
import { hasEnterpriseUri } from '../github/utils';

export type Notification = {
	readonly id: string;
	readonly subject: {
		readonly title: string;
		readonly type: 'Issue' | 'PullRequest';
		readonly url: string;
	};
	readonly repository: {
		readonly name: string;
		readonly owner: {
			readonly login: string;
		}
	}
	readonly unread: boolean;
};

export class NotificationsProvider implements vscode.Disposable {
	private _authProvider: AuthProvider | undefined;
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(private readonly _credentialStore: CredentialStore) {
		if (_credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
			this._authProvider = AuthProvider.githubEnterprise;
		} else if (_credentialStore.isAuthenticated(AuthProvider.github)) {
			this._authProvider = AuthProvider.github;
		}

		this._disposables.push(
			vscode.authentication.onDidChangeSessions(_ => {
				if (_credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
					this._authProvider = AuthProvider.githubEnterprise;
				}

				if (_credentialStore.isAuthenticated(AuthProvider.github)) {
					this._authProvider = AuthProvider.github;
				}
			})
		);
	}
	private _getGitHub(): GitHub | undefined {
		return (this._authProvider !== undefined) ?
			this._credentialStore.getHub(this._authProvider) :
			undefined;
	}

	async getNotifications(): Promise<{ data: any[], headers: any } | undefined> {
		const gitHub = this._getGitHub();
		if (gitHub === undefined) {
			return undefined;
		}

		const { data, headers } = await gitHub.octokit.call(gitHub.octokit.api.activity.listNotificationsForAuthenticatedUser, { all: true });
		return { data: data, headers: headers };
	}

	dispose() {
		this._disposables.forEach(d => d.dispose());
	}
}