/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PrsTreeModel } from './prsTreeModel';
import { Disposable } from '../common/lifecycle';
import { Protocol } from '../common/protocol';
import { NOTIFICATION_SETTING, NotificationVariants, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { createPRNodeUri, fromPRNodeUri, fromQueryUri, parsePRNodeIdentifier, PRNodeUriParams, Schemes, toQueryUri } from '../common/uri';
import { CopilotRemoteAgentManager } from '../github/copilotRemoteAgent';
import { getStatusDecoration } from '../github/markdownUtils';
import { PullRequestModel } from '../github/pullRequestModel';
import { NotificationsManager } from '../notifications/notificationsManager';

export class PRStatusDecorationProvider extends Disposable implements vscode.FileDecorationProvider {

	private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;

	constructor(private readonly _prsTreeModel: PrsTreeModel, private readonly _copilotManager: CopilotRemoteAgentManager, private readonly _notificationProvider: NotificationsManager) {
		super();
		this._register(vscode.window.registerFileDecorationProvider(this));
		this._register(
			this._prsTreeModel.onDidChangePrStatus(identifiers => {
				this._onDidChangeFileDecorations.fire(identifiers.map(id => createPRNodeUri(id)));
			})
		);

		this._register(this._copilotManager.onDidChangeNotifications(items => {
			const repoItems = new Set<string>();
			const uris: vscode.Uri[] = [];
			for (const item of items) {
				const queryUri = toQueryUri({ remote: { owner: item.remote.owner, repositoryName: item.remote.repositoryName }, isCopilot: true });
				if (!repoItems.has(queryUri.toString())) {
					repoItems.add(queryUri.toString());
					uris.push(queryUri);
				}
				uris.push(createPRNodeUri(item));
			}
			this._onDidChangeFileDecorations.fire(uris);
		}));

		this._register(
			this._notificationProvider.onDidChangeNotifications(notifications => {
				let uris: vscode.Uri[] = [];
				for (const notification of notifications) {
					if (notification.model instanceof PullRequestModel) {
						uris.push(createPRNodeUri(notification.model));
					}
				}
				this._onDidChangeFileDecorations.fire(uris);
			})
		);

		// if the notification setting changes, refresh the decorations for the nodes with notifications
		this._register(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${PR_SETTINGS_NAMESPACE}.${NOTIFICATION_SETTING}`)) {
				const uris: vscode.Uri[] = [];
				for (const pr of this._notificationProvider.getAllNotifications()) {
					if (pr.model instanceof PullRequestModel) {
						uris.push(createPRNodeUri(pr.model));
					}
				}
				this._onDidChangeFileDecorations.fire(uris);
			}
		}));
	}

	provideFileDecoration(
		uri: vscode.Uri,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.FileDecoration> {
		if (uri.scheme === Schemes.PRQuery) {
			return this._queryDecoration(uri);
		}

		if (uri.scheme !== Schemes.PRNode) {
			return;
		}
		const params = fromPRNodeUri(uri);
		if (!params) {
			return;
		}

		const copilotDecoration = this._getCopilotDecoration(params);
		if (copilotDecoration) {
			return copilotDecoration;
		}

		const notificationDecoration = this._getNotificationDecoration(params);
		if (notificationDecoration) {
			return notificationDecoration;
		}

		const status = this._prsTreeModel.cachedPRStatus(params.prIdentifier);
		if (!status) {
			return;
		}

		const decoration = getStatusDecoration(status.status) as vscode.FileDecoration;
		return decoration;
	}

	private _getCopilotDecoration(params: PRNodeUriParams): vscode.FileDecoration | undefined {
		const idParts = parsePRNodeIdentifier(params.prIdentifier);
		if (!idParts) {
			return;
		}
		const protocol = new Protocol(idParts.remote);
		if (this._copilotManager.hasNotification(protocol.owner, protocol.repositoryName, idParts.prNumber)) {
			return {
				badge: new vscode.ThemeIcon('copilot') as unknown as string,
				color: new vscode.ThemeColor('pullRequests.notification')
			};
		}
	}

	private _queryDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
		const params = fromQueryUri(uri);
		if (!params?.isCopilot || !params.remote) {
			return;
		}
		const counts = this._copilotManager.getNotificationsCount(params.remote.owner, params.remote.repositoryName);
		if (counts === 0) {
			return;
		}

		return {
			tooltip: vscode.l10n.t('Coding agent has made changes'),
			badge: new vscode.ThemeIcon('copilot') as unknown as string,
			color: new vscode.ThemeColor('pullRequests.notification'),
		};
	}

	private _getNotificationDecoration(params: PRNodeUriParams): vscode.FileDecoration | undefined {
		if (!this.notificationSettingValue()) {
			return;
		}
		const idParts = parsePRNodeIdentifier(params.prIdentifier);
		if (!idParts) {
			return;
		}
		const protocol = new Protocol(idParts.remote);
		if (this._notificationProvider.hasNotification({ owner: protocol.owner, repo: protocol.repositoryName, number: idParts.prNumber })) {
			return {
				propagate: false,
				color: new vscode.ThemeColor('pullRequests.notification'),
				badge: '●',
				tooltip: 'unread notification'
			};
		}
	}

	private notificationSettingValue(): boolean {
		return vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<NotificationVariants>(NOTIFICATION_SETTING, 'off') === 'pullRequests';
	}
}