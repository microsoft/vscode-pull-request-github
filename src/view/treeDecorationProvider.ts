/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { fromFileChangeNodeUri } from '../common/uri';

class TreeDecorationProvider implements vscode.DecorationProvider {
	private fileHasComments: Map<string, boolean> = new Map<string, boolean>();

	updateFileComments(resourceUri: vscode.Uri, prNumber: number, fileName: string, hasComments: boolean): void {
		const key = `${prNumber}:${fileName}`;
		const oldValue = this.fileHasComments.get(key);
		if (oldValue !== hasComments) {
			this.fileHasComments.set(`${prNumber}:${fileName}`, hasComments);
			this._onDidChangeDecorations.fire(resourceUri);
		}
	}

	_onDidChangeDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
	onDidChangeDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeDecorations.event;
	provideDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Decoration> {
		const query = fromFileChangeNodeUri(uri);
		if (query) {
			const key = `${query.prNumber}:${query.fileName}`;
			if (this.fileHasComments.get(key)) {
				return {
					bubble: false,
					title: 'Commented',
					letter: '◆',
					priority: 2
				};
			}
		}

		return undefined;
	}
}

export const DecorationProvider = new TreeDecorationProvider();