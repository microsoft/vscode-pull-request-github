/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { dispose } from '../common/utils';
import { NotificationsSortMethod, NotificationTreeItem } from './notificationItem';
import { NotificationsProvider } from './notificationsProvider';

export interface INotificationTreeItems {
	readonly notifications: NotificationTreeItem[];
	readonly hasNextPage: boolean
}

export class NotificationsManager {
	private readonly _onDidChangeNotifications = new vscode.EventEmitter<NotificationTreeItem[]>();
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
	private _notifications = new Map<string, NotificationTreeItem>();

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

	public async getNotifications(compute: boolean, pageCount: number): Promise<INotificationTreeItems | undefined> {
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
		const notificationItems = new Map<string, NotificationTreeItem>();
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

			notificationItems.set(notification.key, {
				notification, model, kind: 'notification'
			});
		}));

		// Calculate notification priority
		if (this.sortingMethod === NotificationsSortMethod.Priority) {
			const notificationsWithoutPriority = Array.from(notificationItems.values())
				.filter(notification => notification.priority === undefined);

			const notificationPriorities = await this._notificationProvider
				.getNotificationsPriority(notificationsWithoutPriority);

			for (const { key, priority, priorityReasoning } of notificationPriorities) {
				const notification = notificationItems.get(key);
				if (!notification) {
					continue;
				}

				notification.priority = priority;
				notification.priorityReason = priorityReasoning;

				notificationItems.set(key, notification);
			}
		}

		this._notifications = notificationItems;
		this._hasNextPage = notificationsData.hasNextPage;

		const notifications = Array.from(this._notifications.values());
		this._onDidChangeNotifications.fire(notifications);

		return {
			notifications: this._sortNotifications(notifications),
			hasNextPage: this._hasNextPage
		};
	}

	public getNotification(key: string): NotificationTreeItem | undefined {
		return this._notifications.get(key);
	}

	public getAllNotifications(): NotificationTreeItem[] {
		return Array.from(this._notifications.values());
	}

	public async markAsRead(notificationIdentifier: { threadId: string, notificationKey: string }): Promise<void> {
		await this._notificationProvider.markAsRead(notificationIdentifier);

		const notification = this._notifications.get(notificationIdentifier.notificationKey);
		if (notification) {
			this._onDidChangeNotifications.fire([notification]);
			this._notifications.delete(notificationIdentifier.notificationKey);
		}
	}

	public async markAsDone(notificationIdentifier: { threadId: string, notificationKey: string }): Promise<void> {
		await this._notificationProvider.markAsDone(notificationIdentifier);
		const notification = this._notifications.get(notificationIdentifier.notificationKey);
		if (notification) {
			this._onDidChangeNotifications.fire([notification]);
			this._notifications.delete(notificationIdentifier.notificationKey);
		}
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