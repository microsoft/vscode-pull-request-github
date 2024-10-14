/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';
import { PullRequestModel } from '../github/pullRequestModel';
import { NotificationsProvider } from './notificationsProvider';
import { LoadMoreNotificationsTreeItem, NotificationsSortMethod, NotificationTreeDataItem, NotificationTreeItem } from './notificationsUtils';

const devMode = false; // Boolean("true");

export class NotificationsTreeData implements vscode.TreeDataProvider<NotificationTreeDataItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<NotificationTreeDataItem | undefined | void> = new vscode.EventEmitter<NotificationTreeDataItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<NotificationTreeDataItem | undefined | void> = this._onDidChangeTreeData.event;

	private _sortByMethod: NotificationsSortMethod = NotificationsSortMethod.Timestamp;

	constructor(private readonly _notificationsProvider: NotificationsProvider) { }

	async getTreeItem(element: NotificationTreeDataItem): Promise<vscode.TreeItem> {
		if (element instanceof NotificationTreeItem) {
			return this._resolveNotificationTreeItem(element);
		}
		return this._resolveLoadMoreNotificationsTreeItem();
	}

	private _resolveNotificationTreeItem(element: NotificationTreeItem): vscode.TreeItem {
		const label = devMode ? `${element.priority}% - ${element.subject.title}` : element.subject.title;
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

		if (element.subject.type === 'Issue' && element.model instanceof IssueModel) {
			item.iconPath = element.model.isOpen
				? new vscode.ThemeIcon('issues', new vscode.ThemeColor('issues.open'))
				: new vscode.ThemeIcon('issue-closed', new vscode.ThemeColor('issues.closed'));
		}
		if (element.subject.type === 'PullRequest' && element.model instanceof PullRequestModel) {
			item.iconPath = element.model.isOpen
				? new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('pullRequests.open'))
				: new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('pullRequests.merged'));
		}
		item.description = `${element.repository.owner.login}/${element.repository.name}`;
		item.contextValue = element.subject.type;
		return item;
	}

	private _resolveLoadMoreNotificationsTreeItem(): vscode.TreeItem {
		const item = new vscode.TreeItem(`Load More Notifications...`, vscode.TreeItemCollapsibleState.None);
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
		const result = await this._notificationsProvider.getNotifications(this._sortByMethod);
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
		this._sortByMethod = NotificationsSortMethod.Timestamp;
		this.refresh();
	}

	sortByPriority(): void {
		this._sortByMethod = NotificationsSortMethod.Priority;
		this.refresh();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	loadMore(): void {
		this._notificationsProvider.loadMore();
		this._onDidChangeTreeData.fire();
	}
}