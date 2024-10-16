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
import { INotificationItem, LoadMoreNotificationsTreeItem, NotificationsSortMethod, NotificationTreeDataItem } from './notificationItem';
import { NotificationItem, NotificationsManager } from './notificationsManager';
import { NotificationsProvider } from './notificationsProvider';

export class NotificationsTreeData implements vscode.TreeDataProvider<NotificationTreeDataItem>, vscode.Disposable {
	private readonly _disposables: vscode.Disposable[] = [];
	private _onDidChangeTreeData: vscode.EventEmitter<NotificationTreeDataItem | undefined | void> = new vscode.EventEmitter<NotificationTreeDataItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<NotificationTreeDataItem | undefined | void> = this._onDidChangeTreeData.event;

	private _sortingMethod: NotificationsSortMethod = NotificationsSortMethod.Timestamp;

	constructor(private readonly _notificationsProvider: NotificationsProvider, private readonly _notificationsManager: NotificationsManager) {
		this._disposables.push(this._onDidChangeTreeData);
		this._disposables.push(this._notificationsManager.onDidChangeNotifications(updates => {
			this._onDidChangeTreeData.fire(updates);
		}));
	}

	async getTreeItem(element: NotificationTreeDataItem): Promise<vscode.TreeItem> {
		if (element instanceof NotificationItem) {
			return this._resolveNotificationTreeItem(element);
		}
		return this._resolveLoadMoreNotificationsTreeItem();
	}

	private _resolveNotificationTreeItem(element: INotificationItem): vscode.TreeItem {
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

		// TODO: Issue webview needs polish before we do this
		// item.command = {
		// 	command: 'pr.openDescription',
		// 	title: 'Open Description',
		// 	arguments: [element.model]
		// };
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
		const result = await this._notificationsProvider.getNotifications(this._sortingMethod);
		if (!result) {
			return undefined;
		}
		const canLoadMoreNotifications = this._notificationsProvider.canLoadMoreNotifications;
		if (canLoadMoreNotifications) {
			return [...result, new LoadMoreNotificationsTreeItem()];
		}
		return result;
	}

	sortByTimestamp(): void {
		this._sortingMethod = NotificationsSortMethod.Timestamp;
		this.refresh();
	}

	sortByPriority(): void {
		this._sortingMethod = NotificationsSortMethod.Priority;
		this.refresh();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	loadMore(): void {
		this._notificationsProvider.loadMore();
		this._onDidChangeTreeData.fire();
	}

	dispose() {
		dispose(this._disposables);
	}
}