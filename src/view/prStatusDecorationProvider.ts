/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createPRNodeUri, fromPRNodeUri, Schemes } from '../common/uri';
import { dispose } from '../common/utils';
import { PrsTreeModel, UnsatisfiedChecks } from './prsTreeModel';

export class PRStatusDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
	private _disposables: vscode.Disposable[] = [];

	private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;

	constructor(private readonly _prsTreeModel: PrsTreeModel) {
		this._disposables.push(vscode.window.registerFileDecorationProvider(this));
		this._disposables.push(
			this._prsTreeModel.onDidChangePrStatus(identifiers => {
				this._onDidChangeFileDecorations.fire(identifiers.map(id => createPRNodeUri(id)));
			})
		);
	}

	provideFileDecoration(
		uri: vscode.Uri,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.FileDecoration> {
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

		return this._getDecoration(status.status) as vscode.FileDecoration;
	}

	private _getDecoration(status: UnsatisfiedChecks): vscode.FileDecoration2 | undefined {
		if ((status & UnsatisfiedChecks.CIFailed) && (status & UnsatisfiedChecks.ReviewRequired)) {
			return {
				propagate: false,
				badge: new vscode.ThemeIcon('close', new vscode.ThemeColor('list.errorForeground')),
				tooltip: 'Review required and some checks have failed'
			};
		} else if (status & UnsatisfiedChecks.CIFailed) {
			return {
				propagate: false,
				badge: new vscode.ThemeIcon('close', new vscode.ThemeColor('list.errorForeground')),
				tooltip: 'Some checks have failed'
			};
		} else if (status & UnsatisfiedChecks.ChangesRequested) {
			return {
				propagate: false,
				badge: new vscode.ThemeIcon('request-changes', new vscode.ThemeColor('list.errorForeground')),
				tooltip: 'Changes requested'
			};
		} else if (status & UnsatisfiedChecks.CIPending) {
			return {
				propagate: false,
				badge: new vscode.ThemeIcon('sync', new vscode.ThemeColor('list.warningForeground')),
				tooltip: 'Checks pending'
			};
		} else if (status & UnsatisfiedChecks.ReviewRequired) {
			return {
				propagate: false,
				badge: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('list.warningForeground')),
				tooltip: 'Review required'
			};
		} else if (status === UnsatisfiedChecks.None) {
			return {
				propagate: false,
				badge: new vscode.ThemeIcon('check-all', new vscode.ThemeColor('issues.open')),
				tooltip: 'All checks passed'
			};
		}

	}

	dispose() {
		dispose(this._disposables);
	}

}