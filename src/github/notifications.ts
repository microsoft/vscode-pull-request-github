/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OctokitResponse } from '@octokit/types';
import * as vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import Logger from '../common/logger';
import { NOTIFICATION_SETTING, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { createPRNodeUri } from '../common/uri';
import { PullRequestsTreeDataProvider } from '../view/prsTreeDataProvider';
import { CategoryTreeNode } from '../view/treeNodes/categoryNode';
import { PRNode } from '../view/treeNodes/pullRequestNode';
import { TreeNode } from '../view/treeNodes/treeNode';
import { CredentialStore, GitHub } from './credentials';
import { GitHubRepository } from './githubRepository';
import { PullRequestState } from './graphql';
import { PullRequestModel } from './pullRequestModel';
import { RepositoriesManager } from './repositoriesManager';
import { hasEnterpriseUri } from './utils';

const DEFAULT_POLLING_DURATION = 60;

export class Notification {
	public readonly identifier;
	public readonly threadId: number;
	public readonly repositoryName: string;
	public readonly pullRequestNumber: number;
	public pullRequestModel?: PullRequestModel;

	constructor(identifier: string, threadId: number, repositoryName: string,
		pullRequestNumber: number, pullRequestModel?: PullRequestModel) {

		this.identifier = identifier;
		this.threadId = threadId;
		this.repositoryName = repositoryName;
		this.pullRequestNumber = pullRequestNumber;
		this.pullRequestModel = pullRequestModel;
	}
}

export class NotificationProvider implements vscode.Disposable {
	private static ID = 'NotificationProvider';
	private readonly _gitHubPrsTree: PullRequestsTreeDataProvider;
	private readonly _credentialStore: CredentialStore;
	private _authProvider: AuthProvider | undefined;
	// The key uniquely identifies a PR from a Repository. The key is created with `getPrIdentifier`
	private _notifications: Map<string, Notification[]>;
	private readonly _reposManager: RepositoriesManager;

	private _pollingDuration: number;
	private _lastModified: string;
	private _pollingHandler: NodeJS.Timeout | null;

	private disposables: vscode.Disposable[] = [];

	private _onDidChangeNotifications: vscode.EventEmitter<vscode.Uri[]> = new vscode.EventEmitter();
	public onDidChangeNotifications = this._onDidChangeNotifications.event;

	constructor(
		gitHubPrsTree: PullRequestsTreeDataProvider,
		credentialStore: CredentialStore,
		reposManager: RepositoriesManager
	) {
		this._gitHubPrsTree = gitHubPrsTree;
		this._credentialStore = credentialStore;
		this._reposManager = reposManager;
		this._notifications = new Map<string, Notification[]>();

		this._lastModified = '';
		this._pollingDuration = DEFAULT_POLLING_DURATION;
		this._pollingHandler = null;

		this.registerAuthProvider(credentialStore);

		for (const manager of this._reposManager.folderManagers) {
			this.disposables.push(
				manager.onDidChangeGithubRepositories(() => {
					this.refreshOrLaunchPolling();
				})
			);
		}

		this.disposables.push(
			gitHubPrsTree.onDidChangeTreeData((node) => {
				if (NotificationProvider.isPRNotificationsOn()) {
					this.adaptPRNotifications(node);
				}
			})
		);
		this.disposables.push(
			gitHubPrsTree.onDidChange(() => {
				if (NotificationProvider.isPRNotificationsOn()) {
					this.adaptPRNotifications();
				}
			})
		);

		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${NOTIFICATION_SETTING}`)) {
					this.checkNotificationSetting();
				}
			})
		);
	}

	private static isPRNotificationsOn() {
		return (
			vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string>(NOTIFICATION_SETTING) ===
			'pullRequests'
		);
	}

	private registerAuthProvider(credentialStore: CredentialStore) {
		if (credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
			this._authProvider = AuthProvider.githubEnterprise;
		} else if (credentialStore.isAuthenticated(AuthProvider.github)) {
			this._authProvider = AuthProvider.github;
		}

		this.disposables.push(
			vscode.authentication.onDidChangeSessions(_ => {
				if (credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
					this._authProvider = AuthProvider.githubEnterprise;
				}

				if (credentialStore.isAuthenticated(AuthProvider.github)) {
					this._authProvider = AuthProvider.github;
				}
			})
		);
	}

	private getPrIdentifier(pullRequest: PullRequestModel | OctokitResponse<any>['data']): string {
		if (pullRequest instanceof PullRequestModel) {
			return `${pullRequest.remote.url}:${pullRequest.number}`;
		}
		const splitPrUrl = pullRequest.subject.url.split('/');
		const prNumber = splitPrUrl[splitPrUrl.length - 1];
		return `${pullRequest.repository.html_url}.git:${prNumber}`;
	}

	/* Takes a PullRequestModel or a PRIdentifier and
	returns true if there is a Notification for the corresponding PR */
	public hasNotification(pullRequest: PullRequestModel | string): boolean {
		const identifier = pullRequest instanceof PullRequestModel ?
			this.getPrIdentifier(pullRequest) :
			pullRequest;
		const prNotifications = this._notifications.get(identifier);
		return prNotifications !== undefined && prNotifications.length > 0;
	}

	private updateViewBadge() {
		const treeView = this._gitHubPrsTree.view;
		const singularMessage = vscode.l10n.t('1 notification');
		const pluralMessage = vscode.l10n.t('{0} notifications', this._notifications.size);
		treeView.badge = this._notifications.size !== 0 ? {
			tooltip: this._notifications.size === 1 ? singularMessage : pluralMessage,
			value: this._notifications.size
		} : undefined;
	}

	private adaptPRNotifications(node: TreeNode | void) {
		if (this._pollingHandler === undefined) {
			this.startPolling();
		}

		if (node instanceof PRNode) {
			const prNotifications = this._notifications.get(this.getPrIdentifier(node.pullRequestModel));
			if (prNotifications) {
				for (const prNotification of prNotifications) {
					if (prNotification) {
						prNotification.pullRequestModel = node.pullRequestModel;
						return;
					}
				}
			}
		}

		this._gitHubPrsTree.cachedChildren().then(async (catNodes: CategoryTreeNode[]) => {
			let allPrs: PullRequestModel[] = [];

			for (const catNode of catNodes) {
				if (catNode.id === 'All Open') {
					if (catNode.prs.length === 0) {
						for (const prNode of await catNode.cachedChildren()) {
							if (prNode instanceof PRNode) {
								allPrs.push(prNode.pullRequestModel);
							}
						}
					}
					else {
						allPrs = catNode.prs;
					}

				}
			}

			allPrs.forEach((pr) => {
				const prNotifications = this._notifications.get(this.getPrIdentifier(pr));
				if (prNotifications) {
					for (const prNotification of prNotifications) {
						prNotification.pullRequestModel = pr;
					}
				}
			});
		});
	}

	public refreshOrLaunchPolling() {
		this._lastModified = '';
		this.checkNotificationSetting();
	}

	private checkNotificationSetting() {
		const notificationsTurnedOn = NotificationProvider.isPRNotificationsOn();
		if (notificationsTurnedOn && this._pollingHandler === null) {
			this.startPolling();
		}
		else if (!notificationsTurnedOn && this._pollingHandler !== null) {
			clearInterval(this._pollingHandler);
			this._lastModified = '';
			this._pollingHandler = null;
			this._pollingDuration = DEFAULT_POLLING_DURATION;

			this._onDidChangeNotifications.fire(this.uriFromNotifications());
			this._notifications.clear();
			this.updateViewBadge();
		}
	}

	private uriFromNotifications(): vscode.Uri[] {
		const notificationUris: vscode.Uri[] = [];
		for (const [identifier, prNotifications] of this._notifications.entries()) {
			if (prNotifications.length) {
				notificationUris.push(createPRNodeUri(identifier));
			}
		}
		return notificationUris;
	}

	private getGitHub(): GitHub | undefined {
		return (this._authProvider !== undefined) ?
			this._credentialStore.getHub(this._authProvider) :
			undefined;
	}

	private async getNotifications() {
		const gitHub = this.getGitHub();
		if (gitHub === undefined)
			return undefined;
		const { data, headers } = await gitHub.octokit.call(gitHub.octokit.api.activity.listNotificationsForAuthenticatedUser, {});
		return { data: data, headers: headers };
	}

	private async markNotificationThreadAsRead(thredId) {
		const github = this.getGitHub();
		if (!github) {
			return;
		}
		await github.octokit.call(github.octokit.api.activity.markThreadAsRead, {
			thread_id: thredId
		});
	}

	public async markPrNotificationsAsRead(pullRequestModel: PullRequestModel) {
		const identifier = this.getPrIdentifier(pullRequestModel);
		const prNotifications = this._notifications.get(identifier);
		if (prNotifications && prNotifications.length) {
			for (const notification of prNotifications) {
				await this.markNotificationThreadAsRead(notification.threadId);
			}

			const uris = this.uriFromNotifications();
			this._onDidChangeNotifications.fire(uris);
			this._notifications.delete(identifier);
			this.updateViewBadge();
		}
	}

	private async pollForNewNotifications() {
		const response = await this.getNotifications();
		if (response === undefined) {
			return;
		}
		const { data, headers } = response;
		const pollTimeSuggested = Number(headers['x-poll-interval']);

		// Adapt polling interval if it has changed.
		if (pollTimeSuggested !== this._pollingDuration) {
			this._pollingDuration = pollTimeSuggested;
			if (this._pollingHandler && NotificationProvider.isPRNotificationsOn()) {
				Logger.appendLine('Notifications: Clearing interval');
				clearInterval(this._pollingHandler);
				Logger.appendLine(`Notifications: Starting new polling interval with ${this._pollingDuration}`);
				this.startPolling();
			}
		}

		// Only update if the user has new notifications
		if (this._lastModified === headers['last-modified']) {
			return;
		}
		this._lastModified = headers['last-modified'] ?? '';

		const prNodesToUpdate = this.uriFromNotifications();
		this._notifications.clear();

		const currentRepos = new Map<string, GitHubRepository>();

		this._reposManager.folderManagers.forEach(manager => {
			manager.gitHubRepositories.forEach(repo => {
				currentRepos.set(repo.remote.url, repo);
			});
		});

		await Promise.all(data.map(async (notification) => {

			const repoUrl = `${notification.repository.html_url}.git`;
			const githubRepo = currentRepos.get(repoUrl);

			if (githubRepo && notification.subject.type === 'PullRequest') {
				const splitPrUrl = notification.subject.url.split('/');
				const prNumber = Number(splitPrUrl[splitPrUrl.length - 1]);
				const identifier = this.getPrIdentifier(notification);

				const { remote, query, schema } = await githubRepo.ensure();

				const { data } = await query<PullRequestState>({
					query: schema.PullRequestState,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						number: prNumber,
					},
				});

				if (data.repository === null) {
					Logger.error('Unexpected null repository when getting notifications', NotificationProvider.ID);
				}

				// We only consider open PullRequests as these are displayed in the AllOpen PR category.
				// Other categories could have queries with closed PRs, but its hard to figure out if a PR
				// belongs to a query without loading each PR of that query.
				if (data.repository?.pullRequest.state === 'OPEN') {

					const newNotification = new Notification(
						identifier,
						Number(notification.id),
						notification.repository.name,
						Number(prNumber)
					);

					const currentPrNotifications = this._notifications.get(identifier);
					if (currentPrNotifications === undefined) {
						this._notifications.set(
							identifier, [newNotification]
						);
					}
					else {
						currentPrNotifications.push(newNotification);
					}
				}

			}
		}));

		this.adaptPRNotifications();

		this.updateViewBadge();
		for (const uri of this.uriFromNotifications()) {
			if (prNodesToUpdate.find(u => u.fsPath === uri.fsPath) === undefined) {
				prNodesToUpdate.push(uri);
			}
		}

		this._onDidChangeNotifications.fire(prNodesToUpdate);
	}

	private startPolling() {
		this.pollForNewNotifications();
		this._pollingHandler = setInterval(
			function (notificationProvider: NotificationProvider) {
				notificationProvider.pollForNewNotifications();
			},
			this._pollingDuration * 1000,
			this
		);
	}

	public dispose() {
		if (this._pollingHandler) {
			clearInterval(this._pollingHandler);
		}
		this.disposables.forEach(displosable => displosable.dispose());
	}
}