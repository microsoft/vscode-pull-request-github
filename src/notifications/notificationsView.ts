/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Notification, NotificationsProvider } from './notificationsProvider';

export class NotificationsTreeData implements vscode.TreeDataProvider<Notification> {
	private _onDidChangeTreeData: vscode.EventEmitter<Notification | undefined | void> = new vscode.EventEmitter<Notification | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<Notification | undefined | void> = this._onDidChangeTreeData.event;

	constructor(
		private readonly _notificationsProvider: NotificationsProvider
	) { }

	async getTreeItem(element: Notification): Promise<vscode.TreeItem> {
		const item = new vscode.TreeItem(element.subject.title, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon(element.subject.type === 'Issue' ? 'issues' : 'git-pull-request');
		item.description = `${element.repository.owner.login}/${element.repository.name}`;

		return item;
	}

	async getChildren(element?: unknown): Promise<Notification[] | undefined> {
		const result = await this._notificationsProvider.getNotifications();
		if (result === undefined) {
			return undefined;
		}

		return result.data;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}