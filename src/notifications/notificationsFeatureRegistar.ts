/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ITelemetry } from '../common/telemetry';
import { CredentialStore } from '../github/credentials';
import { RepositoriesManager } from '../github/repositoriesManager';
import { NotificationsProvider } from './notificationsProvider';
import { NotificationsTreeData } from './notificationsView';

export class NotificationsFeatureRegister implements vscode.Disposable {

	private readonly _disposables: vscode.Disposable[] = [];

	constructor(
		credentialStore: CredentialStore,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _telemetry: ITelemetry
	) {
		const notificationsProvider = new NotificationsProvider(credentialStore, this._repositoriesManager);

		// View
		const dataProvider = new NotificationsTreeData(notificationsProvider);
		const view = vscode.window.createTreeView<any>('notifications:github', {
			treeDataProvider: dataProvider
		});
		this._disposables.push(view);

		// Commands
		this._disposables.push(
			vscode.commands.registerCommand(
				'notifications.prioritize',
				async () => {
					/* __GDPR__
						"notifications.prioritize" : {}
					*/
					this._telemetry.sendTelemetryEvent('notifications.prioritize');
					await notificationsProvider.prioritizeNotifications();
					return dataProvider.refresh();
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
					return dataProvider.refresh();
				},
				this,
			),
		);

		// Events
		this._repositoriesManager.onDidLoadAnyRepositories(() => {
			notificationsProvider.clearCache();
			dataProvider.refresh();
		});
	}

	dispose() {
		this._disposables.forEach(d => d.dispose());
	}
}
