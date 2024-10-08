/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import { CredentialStore, GitHub } from '../github/credentials';
import { IssueModel } from '../github/issueModel';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { hasEnterpriseUri } from '../github/utils';

export type Notification = {
	readonly id: string;
	readonly subject: {
		readonly title: string;
		readonly type: 'Issue' | 'PullRequest';
		readonly url: string;
	};
	readonly reason: string;
	readonly repository: {
		readonly name: string;
		readonly owner: {
			readonly login: string;
		}
	}
	readonly unread: boolean;
	readonly updated_at: string;
	readonly last_read_at: string | null;
	readonly model: IssueModel | PullRequestModel | undefined;
};

function getNotificationOwner(notification: Notification): { owner: string, name: string } {
	const owner = notification.repository.owner.login;
	const name = notification.repository.name;

	return { owner, name };
}

export class NotificationsProvider implements vscode.Disposable {
	private _authProvider: AuthProvider | undefined;
	private readonly _notifications = new Map<string, Notification>();

	private readonly _disposables: vscode.Disposable[] = [];

	constructor(
		private readonly _credentialStore: CredentialStore,
		private readonly _repositoriesManager: RepositoriesManager
	) {
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

	private _getKey(notification: Notification): string {
		const id = notification.subject.url.split('/').pop();
		const { owner, name } = getNotificationOwner(notification);

		return `${owner}/${name}#${id}`;
	}

	clearCache(): void {
		this._notifications.clear();
	}

	async getNotifications(): Promise<Notification[] | undefined> {
		const gitHub = this._getGitHub();
		if (gitHub === undefined) {
			return undefined;
		}
		if (this._repositoriesManager.folderManagers.length === 0) {
			return undefined;
		}

		const { data } = await gitHub.octokit.call(gitHub.octokit.api.activity.listNotificationsForAuthenticatedUser, {
			per_page: 10
		});

		// Resolve issues/pull request
		const result = await Promise.all(data.map(async (notification: any): Promise<Notification> => {
			const id = notification.subject.url.split('/').pop();
			const { owner, name } = getNotificationOwner(notification);

			const cachedNotificationKey = this._getKey(notification);
			const cachedNotification = this._notifications.get(cachedNotificationKey);
			if (cachedNotification && cachedNotification.updated_at === notification.updated_at) {
				return cachedNotification;
			}

			const folderManager = this._repositoriesManager.getManagerForRepository(owner, name) ??
				this._repositoriesManager.folderManagers[0];

			const model = notification.subject.type === 'Issue' ?
				await folderManager.resolveIssue(owner, name, parseInt(id), true) :
				await folderManager.resolvePullRequest(owner, name, parseInt(id));

			const resolvedNotification = {
				id: notification.id,
				subject: {
					title: notification.subject.title,
					type: notification.subject.type,
					url: notification.subject.url,
				},
				reason: notification.reason,
				repository: {
					name: name,
					owner: {
						login: owner,
					}
				},
				unread: notification.unread,
				updated_at: notification.updated_at,
				last_read_at: notification.last_read_at,
				model: model
			};

			this._notifications.set(cachedNotificationKey, resolvedNotification);
			return resolvedNotification;
		}));

		return result;
	}

	async prioritizeNotifications(): Promise<void> {
	}

	dispose() {
		this._disposables.forEach(d => d.dispose());
	}
}