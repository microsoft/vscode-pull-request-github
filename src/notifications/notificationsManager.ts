/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { commands, contexts } from '../common/executeCommands';
import { Disposable } from '../common/lifecycle';
import { EventType, TimelineEvent } from '../common/timelineEvent';
import { toNotificationUri } from '../common/uri';
import { CredentialStore } from '../github/credentials';
import { NotificationSubjectType } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { PullRequestModel } from '../github/pullRequestModel';
import { isNotificationTreeItem, NotificationTreeDataItem, NotificationTreeItem } from './notificationItem';
import { NotificationsProvider } from './notificationsProvider';

export interface INotificationTreeItems {
	readonly notifications: NotificationTreeItem[];
	readonly hasNextPage: boolean
}

export enum NotificationsSortMethod {
	Timestamp = 'Timestamp',
	Priority = 'Priority'
}

export class NotificationsManager extends Disposable implements vscode.TreeDataProvider<NotificationTreeDataItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<NotificationTreeDataItem | undefined | void> = this._register(new vscode.EventEmitter<NotificationTreeDataItem | undefined | void>());
	readonly onDidChangeTreeData: vscode.Event<NotificationTreeDataItem | undefined | void> = this._onDidChangeTreeData.event;

	private readonly _onDidChangeNotifications = this._register(new vscode.EventEmitter<NotificationTreeItem[]>());
	readonly onDidChangeNotifications = this._onDidChangeNotifications.event;

	private _pageCount: number = 1;
	private _hasNextPage: boolean = false;
	private _dateTime: Date = new Date();
	private _fetchNotifications: boolean = false;
	private _notifications = new Map<string, NotificationTreeItem>();

	private _sortingMethod: NotificationsSortMethod = NotificationsSortMethod.Timestamp;
	get sortingMethod(): NotificationsSortMethod { return this._sortingMethod; }

	constructor(private readonly _notificationProvider: NotificationsProvider, private readonly _credentialStore: CredentialStore) {
		super();
		this._register(this._onDidChangeTreeData);
		this._register(this._onDidChangeNotifications);
	}

	//#region TreeDataProvider

	async getChildren(element?: unknown): Promise<NotificationTreeDataItem[] | undefined> {
		if (element !== undefined) {
			return undefined;
		}

		const notificationsData = await this.getNotifications();
		if (notificationsData === undefined) {
			return undefined;
		}

		if (notificationsData.hasNextPage) {
			return [...notificationsData.notifications, { kind: 'loadMoreNotifications' }];
		}

		return notificationsData.notifications;
	}

	async getTreeItem(element: NotificationTreeDataItem): Promise<vscode.TreeItem> {
		if (isNotificationTreeItem(element)) {
			return this._resolveNotificationTreeItem(element);
		}
		return this._resolveLoadMoreNotificationsTreeItem();
	}

	private _resolveNotificationTreeItem(element: NotificationTreeItem): vscode.TreeItem {
		const label = element.notification.subject.title;
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		const notification = element.notification;
		const model = element.model;

		if (notification.subject.type === NotificationSubjectType.Issue && model instanceof IssueModel) {
			item.iconPath = element.model.isOpen
				? new vscode.ThemeIcon('issues', new vscode.ThemeColor('issues.open'))
				: new vscode.ThemeIcon('issue-closed', new vscode.ThemeColor('issues.closed'));
		}
		if (notification.subject.type === NotificationSubjectType.PullRequest && model instanceof PullRequestModel) {
			item.iconPath = model.isOpen
				? new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('pullRequests.open'))
				: (model.isMerged
					? new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('pullRequests.merged'))
					: new vscode.ThemeIcon('git-pull-request-closed', new vscode.ThemeColor('pullRequests.closed')));
		}
		item.description = `${notification.owner}/${notification.name}`;
		item.contextValue = notification.subject.type;
		item.resourceUri = toNotificationUri({ key: element.notification.key });
		if (element.model instanceof PullRequestModel) {
			item.command = {
				command: 'pr.openDescription',
				title: vscode.l10n.t('Open Pull Request Description'),
				arguments: [element.model]
			};
		} else {
			item.command = {
				command: 'issue.openDescription',
				title: vscode.l10n.t('Open Issue Description'),
				arguments: [element.model]
			};
		}
		return item;
	}

	private _resolveLoadMoreNotificationsTreeItem(): vscode.TreeItem {
		const item = new vscode.TreeItem(vscode.l10n.t('Load More Notifications...'), vscode.TreeItemCollapsibleState.None);
		item.command = {
			title: 'Load More Notifications',
			command: 'notifications.loadMore'
		};
		item.contextValue = 'loadMoreNotifications';
		return item;
	}

	//#endregion

	public async getNotifications(): Promise<INotificationTreeItems | undefined> {
		if (this._fetchNotifications) {
			// Get raw notifications
			const notificationsData = await this._notificationProvider.getNotifications(this._dateTime.toISOString(), this._pageCount);
			if (!notificationsData) {
				return undefined;
			}

			// Resolve notifications
			const notificationTreeItems = new Map<string, NotificationTreeItem>();
			await Promise.all(notificationsData.notifications.map(async notification => {
				const model = await this._notificationProvider.getNotificationModel(notification);
				if (!model) {
					return;
				}

				notificationTreeItems.set(notification.key, {
					notification, model, kind: 'notification'
				});
			}));

			for (const [key, value] of notificationTreeItems.entries()) {
				this._notifications.set(key, value);
			}
			this._hasNextPage = notificationsData.hasNextPage;

			this._fetchNotifications = false;
		}

		// Calculate notification priority
		if (this._sortingMethod === NotificationsSortMethod.Priority) {
			const notificationsWithoutPriority = Array.from(this._notifications.values())
				.filter(notification => notification.priority === undefined);

			const notificationPriorities = await this._notificationProvider
				.getNotificationsPriority(notificationsWithoutPriority);

			for (const { key, priority, priorityReasoning } of notificationPriorities) {
				const notification = this._notifications.get(key);
				if (!notification) {
					continue;
				}

				notification.priority = priority;
				notification.priorityReason = priorityReasoning;

				this._notifications.set(key, notification);
			}
		}

		const notifications = Array.from(this._notifications.values());
		this._updateContext();
		this._onDidChangeNotifications.fire(notifications);

		return {
			notifications: this._sortNotifications(notifications),
			hasNextPage: this._hasNextPage
		};
	}

	private _updateContext(): void {
		const notificationCount = this._notifications.size;
		commands.setContext(contexts.NOTIFICATION_COUNT, notificationCount === 0 ? -1 : notificationCount);
	}


	public getNotification(key: string): NotificationTreeItem | undefined {
		return this._notifications.get(key);
	}

	public getAllNotifications(): NotificationTreeItem[] {
		return Array.from(this._notifications.values());
	}

	public refresh(): void {
		if (this._notifications.size !== 0) {
			const updates = Array.from(this._notifications.values());
			this._onDidChangeNotifications.fire(updates);
		}

		this._pageCount = 1;
		this._dateTime = new Date();
		this._notifications.clear();

		this._refresh(true);
	}

	public loadMore(): void {
		this._pageCount++;
		this._refresh(true);
	}

	public _refresh(fetch: boolean): void {
		this._fetchNotifications = fetch;
		this._onDidChangeTreeData.fire();
	}

	public async markAsRead(notificationIdentifier: { threadId: string, notificationKey: string }): Promise<void> {
		const notification = this._notifications.get(notificationIdentifier.notificationKey);
		if (notification) {
			await this._notificationProvider.markAsRead(notificationIdentifier);

			this._onDidChangeNotifications.fire([notification]);
			this._notifications.delete(notificationIdentifier.notificationKey);
			this._updateContext();

			this._refresh(false);
		}
	}

	public async markAsDone(notificationIdentifier: { threadId: string, notificationKey: string }): Promise<void> {
		const notification = this._notifications.get(notificationIdentifier.notificationKey);
		if (notification) {
			await this._notificationProvider.markAsDone(notificationIdentifier);

			this._onDidChangeNotifications.fire([notification]);
			this._notifications.delete(notificationIdentifier.notificationKey);
			this._updateContext();

			this._refresh(false);
		}
	}

	private _getMeaningfulEventTime(event: TimelineEvent, currentUser: string, isCurrentUser: boolean): Date | undefined {
		const userCheck = (testUser?: string) => {
			if (isCurrentUser) {
				return testUser === currentUser;
			} else if (!isCurrentUser) {
				return testUser !== currentUser;
			}
		};

		if (event.event === EventType.Committed) {
			if (userCheck(event.author.login)) {
				return new Date(event.authoredDate);
			}
		} else if (event.event === EventType.Commented) {
			if (userCheck(event.user?.login)) {
				return new Date(event.createdAt);
			}
		} else if (event.event === EventType.Reviewed) {
			// We only count empty reviews as meaningful if the user is the current user
			if (isCurrentUser || (event.comments.length > 0 || event.body.length > 0)) {
				if (userCheck(event.user?.login)) {
					return new Date(event.submittedAt);
				}
			}
		}
	}

	public async markPullRequests(markAsDone: boolean = false): Promise<void> {
		const filteredNotifications = Array.from(this._notifications.values()).filter(notification => notification.notification.subject.type === NotificationSubjectType.PullRequest);
		const timlines = await Promise.all(filteredNotifications.map(notification => (notification.model as PullRequestModel).getTimelineEvents()));

		const markPromises: Promise<void>[] = [];

		for (const [index, notification] of filteredNotifications.entries()) {
			const currentUser = await this._credentialStore.getCurrentUser(notification.model.remote.authProviderId);

			// Check that there have been no comments, reviews, or commits, since last read
			const timeline = timlines[index];
			let userLastEvent: Date | undefined = undefined;
			let nonUserLastEvent: Date | undefined = undefined;
			for (let i = timeline.length - 1; i >= 0; i--) {
				const event = timeline[i];
				if (!userLastEvent) {
					userLastEvent = this._getMeaningfulEventTime(event, currentUser.login, true);
				}
				if (!nonUserLastEvent) {
					nonUserLastEvent = this._getMeaningfulEventTime(event, currentUser.login, false);
				}
				if (userLastEvent && nonUserLastEvent) {
					break;
				}
			}

			if (!nonUserLastEvent || (userLastEvent && (userLastEvent.getTime() > nonUserLastEvent.getTime()))) {
				if (markAsDone) {
					markPromises.push(this._notificationProvider.markAsDone({ threadId: notification.notification.id, notificationKey: notification.notification.key }));
				} else {
					markPromises.push(this._notificationProvider.markAsRead({ threadId: notification.notification.id, notificationKey: notification.notification.key }));
				}
				this._notifications.delete(notification.notification.key);
			}
		}
		await Promise.all(markPromises);
		this.refresh();
	}

	public sortNotifications(method: NotificationsSortMethod): void {
		if (this._sortingMethod === method) {
			return;
		}

		this._sortingMethod = method;
		this._refresh(false);
	}

	private _sortNotifications(notifications: NotificationTreeItem[]): NotificationTreeItem[] {
		if (this._sortingMethod === NotificationsSortMethod.Timestamp) {
			return notifications.sort((n1, n2) => n2.notification.updatedAd.getTime() - n1.notification.updatedAd.getTime());
		} else if (this._sortingMethod === NotificationsSortMethod.Priority) {
			return notifications.sort((n1, n2) => Number(n2.priority) - Number(n1.priority));
		}

		return notifications;
	}
}