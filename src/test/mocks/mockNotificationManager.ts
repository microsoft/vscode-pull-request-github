/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Event, EventEmitter } from 'vscode';
import { PullRequestModel } from '../../github/pullRequestModel';
import { NotificationTreeDataItem, NotificationTreeItem } from '../../notifications/notificationItem';

export class MockNotificationManager {
	onDidChangeTreeData: Event<void | NotificationTreeDataItem | undefined> = new EventEmitter<void | NotificationTreeDataItem | undefined>().event;
	onDidChangeNotifications: Event<NotificationTreeItem[]> = new EventEmitter<NotificationTreeItem[]>().event;
	hasNotification(_issueModel: PullRequestModel): boolean { return false; }
	markPrNotificationsAsRead(_issueModel: PullRequestModel): void { /* no-op */ }
	dispose(): void { /* no-op */ }
}
