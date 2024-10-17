/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { commands } from '../common/executeCommands';
import { ITelemetry } from '../common/telemetry';
import { dispose } from '../common/utils';
import { CredentialStore } from '../github/credentials';
import { RepositoriesManager } from '../github/repositoriesManager';
import { NotificationsDecorationProvider } from './notificationDecorationProvider';
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

		// Decorations
		this._disposables.push(vscode.window.registerFileDecorationProvider(new NotificationsDecorationProvider(notificationsManager)));

		// View
		const dataProvider = new NotificationsTreeData(notificationsProvider, notificationsManager);
		this._disposables.push(dataProvider);
		const view = vscode.window.createTreeView<any>('notifications:github', {
			treeDataProvider: dataProvider
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
					return dataProvider.sortByTimestamp();
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
					return dataProvider.sortByPriority();
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
					return dataProvider.refresh();
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
				vscode.commands.executeCommand(commands.OPEN_CHAT, vscode.l10n.t('@githubpr Summarize notification with thread ID {0}', notification.notification.id));
			})
		);

		// Events
		this._repositoriesManager.onDidLoadAnyRepositories(() => {
			notificationsProvider.clearCache();
			dataProvider.refresh();
		});
	}

	dispose() {
		dispose(this._disposables);
	}
}
