/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { fromFileChangeNodeUri } from '../common/uri';

class TreeDecorationProvider implements vscode.FileDecorationProvider {
	private fileHasComments: Map<string, boolean> = new Map<string, boolean>();

	updateFileComments(resourceUri: vscode.Uri, prNumber: number, fileName: string, hasComments: boolean): void {
		const key = `${prNumber}:${fileName}`;
		const oldValue = this.fileHasComments.get(key);
		if (oldValue !== hasComments) {
			this.fileHasComments.set(`${prNumber}:${fileName}`, hasComments);
			this._onDidChangeFileDecorations.fire(resourceUri);
		}
	}

	_onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
	onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;
	provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
		const query = fromFileChangeNodeUri(uri);
		if (query) {
			const key = `${query.prNumber}:${query.fileName}`;
			if (this.fileHasComments.get(key)) {
				return {
					propagate: false,
					tooltip: 'Commented',
					badge: '◆'
				};
			}
		}

		return undefined;
	}
}

export const DecorationProvider = new TreeDecorationProvider();