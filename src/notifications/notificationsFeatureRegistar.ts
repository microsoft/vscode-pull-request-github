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
import { NotificationFilterMethod, NotificationsSortMethod } from './notificationItem';
import { NotificationItem, NotificationsManager } from './notificationsManager';
import { NotificationsProvider } from './notificationsProvider';
import { NotificationsTreeData } from './notificationsView';

export class NotificationsFeatureRegister implements vscode.Disposable {

	private readonly _disposables: vscode.Disposable[] = [];

	constructor(
		credentialStore: CredentialStore,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _telemetry: ITelemetry
	) {
		const notificationsManager = new NotificationsManager();
		this._disposables.push(notificationsManager);
		const notificationsProvider = new NotificationsProvider(credentialStore, this._repositoriesManager, notificationsManager);

		// View
		const dataProvider = new NotificationsTreeData(notificationsProvider, notificationsManager);
		this._disposables.push(dataProvider);
		const view = vscode.window.createTreeView<any>('notifications:github', {
			treeDataProvider: dataProvider
		});
		this._disposables.push(view);

		// Decorations
		const decorationsProvider = new NotificationsDecorationProvider(notificationsManager, notificationsProvider);
		this._disposables.push(vscode.window.registerFileDecorationProvider(decorationsProvider));

		// Commands
		this._disposables.push(
			vscode.commands.registerCommand(
				'notifications.sortByTimestamp',
				async () => {
					/* __GDPR__
						"notifications.sortByTimestamp" : {}
					*/
					this._telemetry.sendTelemetryEvent('notifications.sortByTimestamp');
					notificationsProvider.sortingMethod = NotificationsSortMethod.Timestamp;
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
					notificationsProvider.sortingMethod = NotificationsSortMethod.Priority;
				},
				this,
			),
		);
		this._disposables.push(
			vscode.commands.registerCommand(
				'notifications.filterByAll',
				async () => {
					/* __GDPR__
						"notifications.filterByAll" : {}
					*/
					this._telemetry.sendTelemetryEvent('notifications.filterByAll');
					notificationsProvider.filterMethod = NotificationFilterMethod.All;
				},
				this,
			),
		);
		this._disposables.push(
			vscode.commands.registerCommand(
				'notifications.filterByOpen',
				async () => {
					/* __GDPR__
						"notifications.filterByOpen" : {}
					*/
					this._telemetry.sendTelemetryEvent('notifications.filterByOpen');
					notificationsProvider.filterMethod = NotificationFilterMethod.Open;
				},
				this,
			),
		);
		this._disposables.push(
			vscode.commands.registerCommand(
				'notifications.filterByClosed',
				async () => {
					/* __GDPR__
						"notifications.filterByClosed" : {}
					*/
					this._telemetry.sendTelemetryEvent('notifications.filterByClosed');
					notificationsProvider.filterMethod = NotificationFilterMethod.Closed;
				},
				this,
			),
		);
		this._disposables.push(
			vscode.commands.registerCommand(
				'notifications.filterByIssues',
				async () => {
					/* __GDPR__
						"notifications.filterByIssues" : {}
					*/
					this._telemetry.sendTelemetryEvent('notifications.filterByIssues');
					notificationsProvider.filterMethod = NotificationFilterMethod.Issues;
				},
				this,
			),
		);
		this._disposables.push(
			vscode.commands.registerCommand(
				'notifications.filterByPullRequests',
				async () => {
					/* __GDPR__
						"notifications.filterByPullRequests" : {}
					*/
					this._telemetry.sendTelemetryEvent('notifications.filterByPullRequests');
					notificationsProvider.filterMethod = NotificationFilterMethod.PullRequests;
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
					notificationsProvider.clearCache();
					return dataProvider.computeAndRefresh();
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
				dataProvider.loadMore();
			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('notification.chatSummarizeNotification', (notification: any) => {
				if (!(notification instanceof NotificationItem)) {
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
			vscode.commands.registerCommand('notification.markAsRead', async (options: any) => {
				let threadId: string;
				let notificationKey: string;
				if (options instanceof NotificationItem) {
					threadId = options.notification.id;
					notificationKey = options.notification.key;
				} else if ('threadId' in options && 'notificationKey' in options && typeof options.threadId === 'number' && typeof options.notificationKey === 'string') {
					threadId = options.threadId;
					notificationKey = options.notificationKey;
				} else {
					throw new Error(`Invalid arguments for command notification.markAsRead : ${JSON.stringify(options)}`);
				}
				/* __GDPR__
					"notification.markAsRead" : {}
				*/
				this._telemetry.sendTelemetryEvent('notification.markAsRead');
				return dataProvider.markAsRead({ threadId, notificationKey });
			})
		);

		// Events
		onceEvent(this._repositoriesManager.onDidLoadAnyRepositories)(() => {
			notificationsProvider.clearCache();
			dataProvider.computeAndRefresh();
		}, this, this._disposables);
	}

	dispose() {
		dispose(this._disposables);
	}
}
