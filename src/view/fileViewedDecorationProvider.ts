/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ViewedState } from '../common/comment';
import { fromFileChangeNodeUri } from '../common/uri';
import { URI_SCHEME_RESOURCE } from '../constants';

export class DecorationProvider implements vscode.FileDecorationProvider {
	private fileViewedState: Map<string, ViewedState> = new Map<string, ViewedState>();

	_onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;

	updateFileViewedState(resourceUri: vscode.Uri, prNumber: number, fileName: string, viewedState: ViewedState): void {
		this.fileViewedState.set(`${prNumber}:${fileName}`, viewedState);
		this._onDidChangeFileDecorations.fire(resourceUri);
	}

	provideFileDecoration(uri: vscode.Uri, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
		if (uri.scheme !== URI_SCHEME_RESOURCE) {
			return;
		}

		const fileChangeUriParams = fromFileChangeNodeUri(uri);
		if (fileChangeUriParams) {
			const key = `${fileChangeUriParams.prNumber}:${fileChangeUriParams.fileName}`;
			if (this.fileViewedState.get(key) === ViewedState.VIEWED) {
				return {
					propagate: false,
					badge: '✓',
					tooltip: 'Viewed',
				};
			}
		}

		return undefined;
	}
}

export const FileViewedDecorationProvider = new DecorationProvider();
