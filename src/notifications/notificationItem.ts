/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Notification } from '../github/interface';
import { IssueModel } from '../github/issueModel';

export interface NotificationsPaginationRange {
	startPage: number;
	endPage: number;
}

export enum NotificationsSortMethod {
	Timestamp = 'Timestamp',
	Priority = 'Priority'
}

export type NotificationTreeDataItem = INotificationItem | LoadMoreNotificationsTreeItem;

export class LoadMoreNotificationsTreeItem { }

export interface INotificationItem {
	notification: Notification;
	model: IssueModel;
	getPriority(): { priority: string, priorityReasoning: string } | undefined;
}
