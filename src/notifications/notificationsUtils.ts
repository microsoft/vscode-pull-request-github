/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Issue } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { PullRequestModel } from '../github/pullRequestModel';

export interface NotificationsPaginationRange {
	startPage: number;
	endPage: number;
}

export class LoadMoreNotificationsTreeItem { }

export type NotificationTreeDataItem = NotificationTreeItem | LoadMoreNotificationsTreeItem;

export enum NotificationsSortMethod {
	Timestamp = 'Timestamp',
	Priority = 'Priority'
}

export class NotificationTreeItem {

	public sortMethod: NotificationsSortMethod = NotificationsSortMethod.Timestamp;

	public priority: string | undefined;

	constructor(
		readonly id: string,
		readonly subject: {
			readonly title: string,
			readonly type: 'Issue' | 'PullRequest',
			readonly url: string,
		},
		readonly reason: string,
		readonly repository: {
			readonly name: string,
			readonly owner: {
				readonly login: string,
			}
		},
		readonly unread: boolean,
		readonly updated_at: string,
		readonly last_read_at: string | null,
		readonly model: IssueModel | PullRequestModel
	) { }

	static fromOctokitCall(notification: any, model: IssueModel<Issue>, owner: string, name: string): NotificationTreeItem {
		return new NotificationTreeItem(
			notification.id,
			{
				title: notification.subject.title,
				type: notification.subject.type,
				url: notification.subject.url,
			},
			notification.reason,
			{
				name: name,
				owner: {
					login: owner,
				}
			},
			notification.unread,
			notification.updated_at,
			notification.last_read_at,
			model
		);
	}
}