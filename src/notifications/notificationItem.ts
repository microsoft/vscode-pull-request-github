/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Notification } from '../github/interface';
import { IssueModel } from '../github/issueModel';

export enum NotificationsSortMethod {
	Timestamp = 'Timestamp',
	Priority = 'Priority'
}

export enum NotificationFilterMethod {
	All = 'All',
	Open = 'open',
	Closed = 'closed',
	Issues = 'issues',
	PullRequests = 'pullRequests'
}

export type NotificationTreeDataItem = NotificationTreeItem | LoadMoreNotificationsTreeItem;

export interface LoadMoreNotificationsTreeItem {
	readonly kind: 'loadMoreNotifications';
}

export interface NotificationTreeItem {
	readonly notification: Notification;
	readonly model: IssueModel;
	priority?: string;
	priorityReason?: string;
	readonly kind: 'notification';
}

export function isNotificationTreeItem(item: any): item is NotificationTreeItem {
	return item.kind === 'notification';
}