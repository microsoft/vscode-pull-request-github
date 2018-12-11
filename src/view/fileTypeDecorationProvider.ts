/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { fromFileChangeNodeUri, fromPRUri } from '../common/uri';
import { GitChangeType } from '../common/file';

export class FileTypeDecorationProvider implements vscode.DecorationProvider {
	private _disposables: vscode.Disposable[];

	constructor(
	) {
		this._disposables = [];
		this._disposables.push(vscode.window.registerDecorationProvider(this));
	}

	_onDidChangeDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
	onDidChangeDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeDecorations.event;
	provideDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DecorationData> {
		let fileChangeUriParams = fromFileChangeNodeUri(uri);
		if (fileChangeUriParams && fileChangeUriParams.status !== undefined) {
			return {
				bubble: false,
				letter: this.letter(fileChangeUriParams.status),
				priority: this.priority(fileChangeUriParams.status)
			};
		}

		let prParams = fromPRUri(uri);

		if (prParams && prParams.status !== undefined) {
			return {
				bubble: false,
				letter: this.letter(prParams.status),
				priority: this.priority(prParams.status)
			};
		}

		return undefined;
	}

	letter(status: GitChangeType): string {
		switch (status) {
			case GitChangeType.MODIFY:
				return 'M';
			case GitChangeType.ADD:
				return 'A';
			case GitChangeType.DELETE:
				return 'D';
			case GitChangeType.RENAME:
				return 'R';
			case GitChangeType.UNKNOWN:
				return 'U';
			case GitChangeType.UNMERGED:
				return 'C';
		}

		return '';
	}

	priority(status: GitChangeType): number {
		switch (status) {
			case GitChangeType.MODIFY:
			case GitChangeType.RENAME:
				return 2;
			case GitChangeType.UNKNOWN:
				return 3;
			case GitChangeType.UNMERGED:
				return 4;
			default:
				return 1;
		}
	}

	dispose() {
		this._disposables.forEach(dispose => dispose.dispose());
	}
}
