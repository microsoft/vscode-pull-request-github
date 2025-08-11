/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import { Protocol } from '../common/protocol';
import { COPILOT_QUERY, createPRNodeUri, fromPRNodeUri, parsePRNodeIdentifier, PRNodeUriParams, Schemes } from '../common/uri';
import { CopilotRemoteAgentManager } from '../github/copilotRemoteAgent';
import { getStatusDecoration } from '../github/markdownUtils';
import { PrsTreeModel } from './prsTreeModel';

export class PRStatusDecorationProvider extends Disposable implements vscode.FileDecorationProvider {

	private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;

	constructor(private readonly _prsTreeModel: PrsTreeModel, private readonly _copilotManager: CopilotRemoteAgentManager) {
		super();
		this._register(vscode.window.registerFileDecorationProvider(this));
		this._register(
			this._prsTreeModel.onDidChangePrStatus(identifiers => {
				this._onDidChangeFileDecorations.fire(identifiers.map(id => createPRNodeUri(id)));
			})
		);

		this._register(this._copilotManager.onDidChangeNotifications(items => {
			const uris = [COPILOT_QUERY];
			for (const item of items) {
				uris.push(createPRNodeUri(item));
			}
			this._onDidChangeFileDecorations.fire(uris);
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
				badge: new vscode.ThemeIcon('copilot') as any,
				color: new vscode.ThemeColor('pullRequests.notification')
			};
		}
	}

	private _queryDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
		if (uri.path === 'copilot') {
			if (this._copilotManager.notificationsCount > 0) {
				return {
					tooltip: vscode.l10n.t('Coding agent has made changes', this._copilotManager.notificationsCount),
					badge: new vscode.ThemeIcon('copilot') as any,
					color: new vscode.ThemeColor('pullRequests.notification'),
				};
			}
		}
	}
}