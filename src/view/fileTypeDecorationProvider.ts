/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { fromFileChangeNodeUri, fromPRUri } from '../common/uri';
import { GitChangeType } from '../common/file';

export class FileTypeDecorationProvider implements vscode.FileDecorationProvider {
	private _disposables: vscode.Disposable[];

	constructor(
	) {
		this._disposables = [];
		this._disposables.push(vscode.window.registerFileDecorationProvider(this));
	}

	provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
		const fileChangeUriParams = fromFileChangeNodeUri(uri);
		if (fileChangeUriParams && fileChangeUriParams.status !== undefined) {
			return {
				propagate: false,
				badge: this.letter(fileChangeUriParams.status)
			};
		}

		const prParams = fromPRUri(uri);

		if (prParams && prParams.status !== undefined) {
			return {
				propagate: false,
				badge: this.letter(prParams.status)
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

	dispose() {
		this._disposables.forEach(dispose => dispose.dispose());
	}
}
