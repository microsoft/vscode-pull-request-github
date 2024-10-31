/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ITelemetry } from '../common/telemetry';
import { dispose, onceEvent } from '../common/utils';
import { CredentialStore } from '../github/credentials';
import { RepositoriesManager } from '../github/repositoriesManager';
import { chatCommand } from '../lm/utils';
import { NotificationsDecorationProvider } from './notificationDecorationProvider';
import { isNotificationTreeItem, NotificationTreeDataItem } from './notificationItem';
import { NotificationsManager, NotificationsSortMethod } from './notificationsManager';
import { NotificationsProvider } from './notificationsProvider';

export class NotificationsFeatureRegister implements vscode.Disposable {

	private readonly _disposables: vscode.Disposable[] = [];

	constructor(
		credentialStore: CredentialStore,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _telemetry: ITelemetry
	) {
		const notificationsProvider = new NotificationsProvider(credentialStore, this._repositoriesManager);
		this._disposables.push(notificationsProvider);

		const notificationsManager = new NotificationsManager(notificationsProvider);
		this._disposables.push(notificationsManager);

		// Decorations
		const decorationsProvider = new NotificationsDecorationProvider(notificationsManager);
		this._disposables.push(vscode.window.registerFileDecorationProvider(decorationsProvider));

		// View
		const view = vscode.window.createTreeView<any>('notifications:github', {
			treeDataProvider: notificationsManager
		});
		this._disposables.push(view);

		// Commands
		this._disposables.push(
			vscode.commands.registerCommand(
				'notifications.sortByTimestamp',
				async () => {
					/* __GDPR__
						"notifications.sortByTimestamp" : {}
					*/
					this._telemetry.sendTelemetryEvent('notifications.sortByTimestamp');
					notificationsManager.sortNotifications(NotificationsSortMethod.Timestamp);
				},
				this,
			),
		);
		this._disposables.push(
			vscode.commands.registerCommand(
				'notifications.sortByPriority',
				async () => {
					/* __GDPR__
						"notifications.sortByTimestamp" : {}
					*/
					this._telemetry.sendTelemetryEvent('notifications.sortByTimestamp');
					notificationsManager.sortNotifications(NotificationsSortMethod.Priority);
				},
				this,
			),
		);
		this._disposables.push(
			vscode.commands.registerCommand(
				'notifications.refresh',
				() => {
					/* __GDPR__
						"notifications.refresh" : {}
					*/
					this._telemetry.sendTelemetryEvent('notifications.refresh');
					notificationsManager.refresh();
				},
				this,
			),
		);
		this._disposables.push(
			vscode.commands.registerCommand('notifications.loadMore', () => {
				/* __GDPR__
					"notifications.loadMore" : {}
				*/
				this._telemetry.sendTelemetryEvent('notifications.loadMore');
				notificationsManager.loadMore();
			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('notification.chatSummarizeNotification', (notification: NotificationTreeDataItem) => {
				if (!isNotificationTreeItem(notification)) {
					return;
				}
				/* __GDPR__
					"notification.chatSummarizeNotification" : {}
				*/
				this._telemetry.sendTelemetryEvent('notification.chatSummarizeNotification');
				vscode.commands.executeCommand(chatCommand(), vscode.l10n.t('@githubpr Summarize notification with thread ID #{0}', notification.notification.id));
			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('notification.markAsRead', (options: any) => {
				const { threadId, notificationKey } = this._extractMarkAsCommandOptions(options);
				/* __GDPR__
					"notification.markAsRead" : {}
				*/
				this._telemetry.sendTelemetryEvent('notification.markAsRead');
				notificationsManager.markAsRead({ threadId, notificationKey });
			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('notification.markAsDone', (options: any) => {
				const { threadId, notificationKey } = this._extractMarkAsCommandOptions(options);
				/* __GDPR__
					"notification.markAsDone" : {}
				*/
				this._telemetry.sendTelemetryEvent('notification.markAsDone');
				dataProvider.markAsDone({ threadId, notificationKey });
			})
		);

		// Events
		onceEvent(this._repositoriesManager.onDidLoadAnyRepositories)(() => {
			notificationsManager.refresh();
		}, this, this._disposables);
	}

	private _extractMarkAsCommandOptions(options: any): { threadId: string, notificationKey: string } {
		let threadId: string;
		let notificationKey: string;
		if (isNotificationTreeItem(options)) {
			threadId = options.notification.id;
			notificationKey = options.notification.key;
		} else if ('threadId' in options && 'notificationKey' in options && typeof options.threadId === 'number' && typeof options.notificationKey === 'string') {
			threadId = options.threadId;
			notificationKey = options.notificationKey;
		} else {
			throw new Error(`Invalid arguments for command : ${JSON.stringify(options)}`);
		}
		return { threadId, notificationKey };
	}

	dispose() {
		dispose(this._disposables);
	}
}
