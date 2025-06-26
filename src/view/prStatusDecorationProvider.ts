/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import { COPILOT_QUERY, createPRNodeUri, fromPRNodeUri, Schemes } from '../common/uri';
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

		this._register(this._copilotManager.onDidChangeNotifications(() => {
			this._onDidChangeFileDecorations.fire(COPILOT_QUERY);
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
		const status = this._prsTreeModel.cachedPRStatus(params.prIdentifier);
		if (!status) {
			return;
		}

		return getStatusDecoration(status.status) as vscode.FileDecoration;
	}

	private _queryDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
		if (uri.path === 'copilot') {
			if (this._copilotManager.notifications.size > 0) {
				return {
					tooltip: vscode.l10n.t('Coding agent has made changes', this._copilotManager.notifications.size),
					badge: new vscode.ThemeIcon('copilot') as any,
					color: new vscode.ThemeColor('pullRequests.notification'),
				};
			}
		}
	}
}