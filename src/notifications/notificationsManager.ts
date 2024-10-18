/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { dispose } from '../common/utils';
import { Notification } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { INotificationItem, NotificationsSortMethod } from './notificationItem';
import { NotificationsProvider } from './notificationsProvider';

export class NotificationItem implements INotificationItem {
	private _priority: string | undefined;
	private _priorityReasoning: string | undefined;

	get priority() {
		return this._priority;
	}
	set priority(value: string | undefined) {
		if (this._priority !== value) {
			this._priority = value;
		}
	}

	get priorityReasoning() {
		return this._priorityReasoning;
	}
	set priorityReasoning(value: string | undefined) {
		if (this._priorityReasoning !== value) {
			this._priorityReasoning = value;
		}
	}

	getPriority(): { priority: string; priorityReasoning: string; } | undefined {
		if (this._priority && this._priorityReasoning) {
			return { priority: this._priority, priorityReasoning: this._priorityReasoning };
		}
	}

	constructor(
		public readonly notification: Notification,
		readonly model: IssueModel
	) { }
}

export interface NotificationUpdate {
	key: string;
	priority: string | undefined;
	priorityReasoning: string | undefined;
}

export class NotificationsManager {
	private readonly _onDidChangeNotifications = new vscode.EventEmitter<INotificationItem[]>();
	readonly onDidChangeNotifications = this._onDidChangeNotifications.event;

	private _sortingMethod: NotificationsSortMethod = NotificationsSortMethod.Timestamp;
	public get sortingMethod(): NotificationsSortMethod { return this._sortingMethod; }
	public set sortingMethod(value: NotificationsSortMethod) {
		if (this._sortingMethod === value) {
			return;
		}

		this._sortingMethod = value;
		this._onDidChangeSortingMethod.fire();
	}

	private readonly _onDidChangeSortingMethod = new vscode.EventEmitter<void>();
	readonly onDidChangeSortingMethod = this._onDidChangeSortingMethod.event;

	private _hasNextPage: boolean = false;
	private _notifications = new Map<string, NotificationItem>();

	private readonly _disposable: vscode.Disposable[] = [];

	constructor(private readonly _notificationProvider: NotificationsProvider) {
		this._disposable.push(this._onDidChangeNotifications);
	}

	dispose() {
		dispose(this._disposable);
	}

	public clear() {
		if (this._notifications.size === 0) {
			return;
		}
		const updates = Array.from(this._notifications.values());
		this._notifications.clear();
		this._onDidChangeNotifications.fire(updates);
	}

	public async getNotifications(compute: boolean, pageCount: number): Promise<{ notifications: INotificationItem[]; hasNextPage: boolean } | undefined> {
		if (!compute) {
			const notifications = Array.from(this._notifications.values());

			return {
				notifications: this._sortNotifications(notifications),
				hasNextPage: this._hasNextPage
			};
		}

		// Get raw notifications
		const notificationsData = await this._notificationProvider.computeNotifications(pageCount);
		if (!notificationsData) {
			return undefined;
		}

		// Resolve notifications
		const notificationItems = new Map<string, NotificationItem>();
		await Promise.all(notificationsData.notifications.map(async notification => {
			const cachedNotification = this._notifications.get(notification.key);
			if (cachedNotification && cachedNotification.notification.updatedAd.getTime() === notification.updatedAd.getTime()) {
				notificationItems.set(notification.key, cachedNotification);
				return;
			}

			const model = await this._notificationProvider.getNotificationModel(notification);
			if (!model) {
				return;
			}

			notificationItems.set(notification.key, new NotificationItem(notification, model));
		}));

		this._notifications = notificationItems;
		this._hasNextPage = notificationsData.hasNextPage;

		const notifications = Array.from(this._notifications.values());
		this._onDidChangeNotifications.fire(notifications);

		return {
			notifications: this._sortNotifications(notifications),
			hasNextPage: this._hasNextPage
		};
	}

	public getNotification(key: string): INotificationItem | undefined {
		return this._notifications.get(key);
	}

	public getAllNotifications(): INotificationItem[] {
		return Array.from(this._notifications.values());
	}

	public updateNotificationPriority(updates: NotificationUpdate[]) {
		const updated: INotificationItem[] = [];
		for (const update of updates) {

			const notification = this._notifications.get(update.key);
			if (notification) {
				notification.priority = update.priority;
				notification.priorityReasoning = update.priorityReasoning;
				updated.push(notification);
			}
		}
		this._onDidChangeNotifications.fire(updated);
	}

	public async markAsRead(notificationIdentifier: { threadId: string, notificationKey: string }): Promise<void> {
		await this._notificationProvider.markAsRead(notificationIdentifier);

		const notification = this._notifications.get(notificationIdentifier.notificationKey);
		if (notification) {
			this._onDidChangeNotifications.fire([notification]);
			this._notifications.delete(notificationIdentifier.notificationKey);
		}
	}

	private _sortNotifications(notifications: INotificationItem[]): INotificationItem[] {
		if (this._sortingMethod === NotificationsSortMethod.Timestamp) {
			return this._sortNotificationsByTimestamp(notifications);
		}

		return notifications;
	}

	private _sortNotificationsByTimestamp(notifications: INotificationItem[]): INotificationItem[] {
		return notifications.sort((n1, n2) => n2.notification.updatedAd.getTime() - n1.notification.updatedAd.getTime());
	}
}