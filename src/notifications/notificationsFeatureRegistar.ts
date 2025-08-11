/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import { ITelemetry } from '../common/telemetry';
import { onceEvent } from '../common/utils';
import { EXTENSION_ID } from '../constants';
import { CredentialStore } from '../github/credentials';
import { RepositoriesManager } from '../github/repositoriesManager';
import { chatCommand } from '../lm/utils';
import { NotificationsDecorationProvider } from './notificationDecorationProvider';
import { isNotificationTreeItem, NotificationID, NotificationTreeDataItem } from './notificationItem';
import { NotificationsManager, NotificationsSortMethod } from './notificationsManager';
import { NotificationsProvider } from './notificationsProvider';

export class NotificationsFeatureRegister extends Disposable {


	constructor(
		readonly credentialStore: CredentialStore,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _telemetry: ITelemetry,
		private readonly _context: vscode.ExtensionContext
	) {
		super();
		const notificationsProvider = new NotificationsProvider(credentialStore, this._repositoriesManager);
		this._register(notificationsProvider);

		const notificationsManager = new NotificationsManager(notificationsProvider, credentialStore, this._repositoriesManager, this._context);
		this._register(notificationsManager);

		// Decorations
		const decorationsProvider = new NotificationsDecorationProvider(notificationsManager);
		this._register(vscode.window.registerFileDecorationProvider(decorationsProvider));

		// View
		this._register(vscode.window.createTreeView<any>('notifications:github', {
			treeDataProvider: notificationsManager
		}));
		notificationsManager.refresh();

		// Commands
		this._register(
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
		this._register(
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
		this._register(
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
		this._register(
			vscode.commands.registerCommand('notifications.loadMore', () => {
				/* __GDPR__
					"notifications.loadMore" : {}
				*/
				this._telemetry.sendTelemetryEvent('notifications.loadMore');
				notificationsManager.loadMore();
			})
		);
		this._register(
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
		this._register(
			vscode.commands.registerCommand('notification.markAsRead', (options: NotificationTreeDataItem) => {
				const { threadId, notificationKey } = this._extractMarkAsCommandOptions(options);
				/* __GDPR__
					"notification.markAsRead" : {}
				*/
				this._telemetry.sendTelemetryEvent('notification.markAsRead');
				notificationsManager.markAsRead({ threadId, notificationKey });
			})
		);
		this._register(
			vscode.commands.registerCommand('notification.markAsDone', (options: NotificationTreeDataItem) => {
				const { threadId, notificationKey } = this._extractMarkAsCommandOptions(options);
				/* __GDPR__
					"notification.markAsDone" : {}
				*/
				this._telemetry.sendTelemetryEvent('notification.markAsDone');
				notificationsManager.markAsDone({ threadId, notificationKey });
			})
		);

		this._register(
			vscode.commands.registerCommand('notifications.markPullRequestsAsRead', () => {
				/* __GDPR__
					"notifications.markPullRequestsAsRead" : {}
				*/
				this._telemetry.sendTelemetryEvent('notifications.markPullRequestsAsRead');
				return notificationsManager.markPullRequests();
			})
		);

		this._register(
			vscode.commands.registerCommand('notifications.markPullRequestsAsDone', () => {
				/* __GDPR__
					"notifications.markPullRequestsAsDone" : {}
				*/
				this._telemetry.sendTelemetryEvent('notifications.markPullRequestsAsDone');
				return notificationsManager.markPullRequests(true);
			})
		);
		this._register(
			vscode.commands.registerCommand('notifications.configureNotificationsViewlet', () => {
				/* __GDPR__
					"notifications.configureNotificationsViewlet" : {}
				*/
				this._telemetry.sendTelemetryEvent('notifications.configureNotificationsViewlet');
				return vscode.commands.executeCommand(
					'workbench.action.openSettings',
					`@ext:${EXTENSION_ID} notifications`,
				);
			})
		);

		// Events
		this._register(onceEvent(this._repositoriesManager.onDidLoadAnyRepositories)(() => {
			notificationsManager.refresh();
		}));
	}

	private _extractMarkAsCommandOptions(options: NotificationTreeDataItem | NotificationID | unknown): { threadId: string, notificationKey: string } {
		let threadId: string;
		let notificationKey: string;
		const asID = options as Partial<NotificationID>;
		if (isNotificationTreeItem(options)) {
			threadId = options.notification.id;
			notificationKey = options.notification.key;
		} else if (asID.threadId !== undefined && asID.notificationKey !== undefined) {
			threadId = asID.threadId;
			notificationKey = asID.notificationKey;
		} else {
			throw new Error(`Invalid arguments for command notification.markAsRead : ${JSON.stringify(options)}`);
		}
		return { threadId, notificationKey };
	}
}
