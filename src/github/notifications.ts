/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OctokitResponse } from '@octokit/types';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { PullRequestsTreeDataProvider } from '../view/prsTreeDataProvider';
import { CategoryTreeNode } from '../view/treeNodes/categoryNode';
import { PRNode } from '../view/treeNodes/pullRequestNode';
import { TreeNode } from '../view/treeNodes/treeNode';
import { AuthProvider, CredentialStore, GitHub } from './credentials';
import { SETTINGS_NAMESPACE } from './folderRepositoryManager';
import { GitHubRepository } from './githubRepository';
import { PullRequestState } from './graphql';
import { PullRequestModel } from './pullRequestModel';
import { RepositoriesManager } from './repositoriesManager';

export const NOTIFICATION_SETTING = 'notifications';

const DEFAULT_POLLING_DURATION = 60;

export class Notification {
	public identifier;
	public threadId: number;
	public reason: string;
	public repositoryName: string;
	public pullRequestNumber: number;
	public pullRequestModel?: PullRequestModel;

	constructor(identifier: string, threadId: number, reason: string, repositoryName: string,
		pullRequestNumber: number, pullRequestModel?: PullRequestModel) {

		this.identifier = identifier;
		this.threadId = threadId;
		this.reason = reason;
		this.repositoryName = repositoryName;
		this.pullRequestNumber = pullRequestNumber;
		this.pullRequestModel = pullRequestModel;
	}
}

export class NotificationProvider {
	private _gitHubPrsTree: PullRequestsTreeDataProvider;
	private _credentialStore: CredentialStore;
	private _authProvider: AuthProvider | undefined;
	private _notifications: Map<string, Notification[]>;
	private _reposManager: RepositoriesManager;

	private _pollingDuration: number;
	private _lastModified: string;
	private _pollingHandler: NodeJS.Timeout | null;

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


		// TODO: CHANGE THIS BEFORE MEREGE
		this.publicRegsiterAuthProvider(AuthProvider.github);

		for (const manager of this._reposManager.folderManagers) {
			manager.onDidCreateGithubRepository(() => {
				this.refreshOrLaunchPolling();
			});
		};

		gitHubPrsTree.onDidChangeTreeData((node) => {
			if (vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<boolean>(NOTIFICATION_SETTING)) {
				this.adaptPRNotifications(node);
			}
		});

		gitHubPrsTree.onDidChange(() => {
			if (vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<boolean>(NOTIFICATION_SETTING)) {
				this.adaptPRNotifications();
			}
		});

		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(`${SETTINGS_NAMESPACE}.${NOTIFICATION_SETTING}`)) {
				this.checkNotificationSetting();
			}
		});
	}

	public publicRegsiterAuthProvider(authProvider: AuthProvider) {
		this._authProvider = authProvider;
	}

	public getPrIdentifier(pullRequest: PullRequestModel | OctokitResponse<any>['data']): string {
		if (pullRequest instanceof PullRequestModel) {
			return `${pullRequest.remote.url}:${pullRequest.number}`;
		}
		const splitPrUrl = pullRequest.subject.url.split('/');
		const prNumber = splitPrUrl[splitPrUrl.length - 1];
		return `${pullRequest.repository.html_url}.git:${prNumber}`;
	}

	public updateViewBadge(treeView: vscode.TreeView<TreeNode>) {
		treeView.badge = this._notifications.size !== 0 ? {
			tooltip: `${this._notifications.size} Notifications`,
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
						prNotification.pullRequestModel.hasNotifications = true;
						return;
					}
				}
			}

			node.pullRequestModel.hasNotifications = false;
		}

		this._gitHubPrsTree.getChildren().then(async (catNodes: CategoryTreeNode[]) => {
			let allPrs: PullRequestModel[] = [];

			for (const catNode of catNodes) {
				if (catNode.id === 'All Open') {
					if (catNode.prs.length === 0) {
						const prNodes = (await catNode.getChildren()) as PRNode[];

						for (const prNode of prNodes) {
							allPrs.push(prNode.pullRequestModel);
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
						prNotification.pullRequestModel.hasNotifications = true;
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
		const notificationsTurnedOn = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get(NOTIFICATION_SETTING);
		if (notificationsTurnedOn && this._pollingHandler === null) {
			this.startPolling();
		}
		else if (!notificationsTurnedOn && this._pollingHandler !== null) {
			clearInterval(this._pollingHandler);
			this._lastModified = '';
			this._pollingHandler = null;
			this._pollingDuration = DEFAULT_POLLING_DURATION;
			for (const prNotifications of this._notifications.values()) {
				for (const prNotification of prNotifications) {
					if (prNotification.pullRequestModel) {
						prNotification.pullRequestModel.hasNotifications = false;
					}
				}
			}
			this._notifications.clear();
			this._gitHubPrsTree.updateNotificationBadge(this);
			this._gitHubPrsTree.refresh();
		}
	}

	private getGitHub(): GitHub | undefined {
		return (this._authProvider !== undefined) ?
			this._credentialStore.getHub(this._authProvider) :
			undefined;
	}

	public async getNotifications() {
		const gitHub = this.getGitHub();
		if (gitHub === undefined)
			return undefined;
		const { data, headers } = await gitHub.octokit.request('GET /notifications', {});
		return { data: data, headers: headers };
	}

	public async markNotifcationsAsReadByTime(lastReadTime: string) {
		const gitHub = this.getGitHub();
		await gitHub?.octokit.request('PUT /notifications', {
			last_read_at: lastReadTime,
			read: true
		});
	}

	public async markAllNotificationsAsRead(owner, repo) {
		const gitHub = this.getGitHub();
		await gitHub?.octokit.request('PUT /repos/{owner}/{repo}/notifications', {
			owner: owner,
			repo: repo
		});
	}

	public async getNotificationThread(thredId) {
		const gitHub = this.getGitHub();
		if (gitHub === undefined) {
			return undefined;
		}

		const { data, headers } = await gitHub.octokit.request('GET /notifications/threads/{thread_id}', {
			thread_id: thredId
		});
		return { data: data, headers: headers };
	}

	public async markNotificationThreadAsRead(thredId) {
		await this.getGitHub()?.octokit.request('PATCH /notifications/threads/{thread_id}', {
			thread_id: thredId
		});
	}

	public async markPrNotificationsAsRead(pullRequestModel: PullRequestModel) {
		const identifier = this.getPrIdentifier(pullRequestModel);
		const prNotifications = this._notifications.get(identifier);
		if (prNotifications) {
			for (const notification of prNotifications) {
				await this.markNotificationThreadAsRead(notification.threadId);
			}
			pullRequestModel.hasNotifications = false;
			this._notifications.delete(identifier);
			this._gitHubPrsTree.updateNotificationBadge(this);
			this._gitHubPrsTree.refresh();
		}

	}

	public async pollForNewNotifications() {
		const response = await this.getNotifications();
		if (response === undefined) {
			return;
		}
		const { data, headers } = response;
		const pollTimeSuggested = Number(headers['x-poll-interval']);

		// Adapt polling interval if it has changed
		if (pollTimeSuggested !== this._pollingDuration) {
			this._pollingDuration = pollTimeSuggested;
			if (this._pollingHandler && vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get(NOTIFICATION_SETTING)) {
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
		this._lastModified = headers['last-modified'];

		for (const prNotifications of this._notifications.values()) {
			for (const notification of prNotifications) {
				if (notification.pullRequestModel) {
					notification.pullRequestModel.hasNotifications = false;
				}
			}
		}
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
				const prNumber = splitPrUrl[splitPrUrl.length - 1];
				const identifier = this.getPrIdentifier(notification);

				/* const { remote, query, schema } = await githubRepo.ensure();

				const response = await query<PullRequestState>({
					query: schema.PullRequestState,
					variables: {
						owner: remote.owner,
						name: remote.repositoryName,
						number: prNumber,
					},
				});

				const { data } = response;

				if (data.repository.pullRequest.state === 'OPEN') { */

				const newNotification = new Notification(
					identifier,
					Number(notification.id),
					notification.reason,
					notification.repository.name,
					Number(prNumber)
				);

				const currentPrNotifications = this._notifications.get(identifier);
				if (currentPrNotifications === undefined) {
					this._notifications.set(identifier, [newNotification]);
				}
				else {
					currentPrNotifications.push(newNotification);
				}
				//}

			}
		}));

		this.adaptPRNotifications();

		this._gitHubPrsTree.updateNotificationBadge(this);
		this._gitHubPrsTree.refresh();
	}

	public startPolling() {
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
	}
}