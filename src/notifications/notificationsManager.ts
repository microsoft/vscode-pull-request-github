/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { dispose } from '../common/utils';
import { Notification } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { INotificationItem } from './notificationItem';

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
	private readonly _disposable: vscode.Disposable[] = [];

	private readonly _notifications = new Map<string, NotificationItem>();

	constructor() {
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

	public getNotification(key: string): INotificationItem | undefined {
		return this._notifications.get(key);
	}

	public removeNotification(key: string): void {
		this._notifications.delete(key);
	}

	public setNotifications(notifications: NotificationItem[]) {
		const newNotifications: INotificationItem[] = [];
		for (const notification of notifications) {
			this._notifications.set(notification.notification.key, notification);
			newNotifications.push(notification);
		}
		this._onDidChangeNotifications.fire(newNotifications);
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
}