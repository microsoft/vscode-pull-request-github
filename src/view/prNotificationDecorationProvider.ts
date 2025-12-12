/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import { fromPRNodeUri } from '../common/uri';
import { NotificationProvider } from '../github/notifications';

export class PRNotificationDecorationProvider extends Disposable implements vscode.FileDecorationProvider {
	private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;


	constructor(private readonly _notificationProvider: NotificationProvider) {
		super();
		this._register(vscode.window.registerFileDecorationProvider(this));
		this._register(
			this._notificationProvider.onDidChangeNotifications(PRNodeUris => this._onDidChangeFileDecorations.fire(PRNodeUris))
		);
	}

	provideFileDecoration(
		uri: vscode.Uri,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.FileDecoration> {
		if (!uri.query) {
			return;
		}

		const prNodeParams = fromPRNodeUri(uri);

		if (prNodeParams && this._notificationProvider.hasNotification(prNodeParams.prIdentifier)) {
			return {
				propagate: false,
				color: new vscode.ThemeColor('pullRequests.notification'),
				badge: '●',
				tooltip: 'unread notification'
			};
		}

		return undefined;
	}
}
