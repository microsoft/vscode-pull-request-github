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

export type NotificationTreeDataItem = NotificationTreeItem | LoadMoreNotificationsTreeItem;

export class LoadMoreNotificationsTreeItem { }

export class NotificationTreeItem {

	public priority: string | undefined;

	public priorityReasoning: string | undefined;

	constructor(
		public readonly notification: Notification,
		readonly model: IssueModel
	) { }
}