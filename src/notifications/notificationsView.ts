/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { toNotificationUri } from '../common/uri';
import { dispose } from '../common/utils';
import { NotificationSubjectType } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { PullRequestModel } from '../github/pullRequestModel';
import { isNotificationTreeItem, NotificationTreeDataItem, NotificationTreeItem } from './notificationItem';
import { NotificationsManager } from './notificationsManager';

export class NotificationsTreeData implements vscode.TreeDataProvider<NotificationTreeDataItem>, vscode.Disposable {
	private readonly _disposables: vscode.Disposable[] = [];
	private _onDidChangeTreeData: vscode.EventEmitter<NotificationTreeDataItem | undefined | void> = new vscode.EventEmitter<NotificationTreeDataItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<NotificationTreeDataItem | undefined | void> = this._onDidChangeTreeData.event;

	private _pageCount: number = 1;
	private _computeNotifications: boolean = false;

	constructor(private readonly _notificationsManager: NotificationsManager) {
		this._disposables.push(this._onDidChangeTreeData);
		this._disposables.push(this._notificationsManager.onDidChangeNotifications(() => {
			this._onDidChangeTreeData.fire();
		}));
		this._disposables.push(this._notificationsManager.onDidChangeSortingMethod(() => {
			this.refresh(true);
		}));
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
				: new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('pullRequests.merged'));
		}
		item.description = `${notification.owner}/${notification.name}`;
		item.contextValue = notification.subject.type;
		item.resourceUri = toNotificationUri({ key: element.notification.key });
		item.command = {
			command: 'notification.chatSummarizeNotification',
			title: 'Summarize Notification',
			arguments: [element]
		};
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

	async getChildren(element?: unknown): Promise<NotificationTreeDataItem[] | undefined> {
		if (element !== undefined) {
			return undefined;
		}

		const notificationsData = await this._notificationsManager
			.getNotifications(this._computeNotifications, this._pageCount);
		this._computeNotifications = false;

		if (notificationsData === undefined) {
			return undefined;
		}

		if (notificationsData.hasNextPage) {
			return [...notificationsData.notifications, { kind: 'loadMoreNotifications' }];
		}

		return notificationsData.notifications;
	}

	loadMore(): void {
		this._pageCount++;
		this.refresh(true);
	}

	refresh(compute: boolean): void {
		this._computeNotifications = compute;
		this._onDidChangeTreeData.fire();
	}

	async markAsRead(notificationIdentifier: { threadId: string, notificationKey: string }): Promise<void> {
		await this._notificationsManager.markAsRead(notificationIdentifier);
		this.refresh(false);
	}

	async markAsDone(notificationIdentifier: { threadId: string, notificationKey: string }): Promise<void> {
		await this._notificationsManager.markAsDone(notificationIdentifier);
		this.refresh(false);
	}

	dispose() {
		dispose(this._disposables);
	}
}