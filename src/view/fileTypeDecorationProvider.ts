/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitChangeType } from '../common/file';
import { fromFileChangeNodeUri, fromPRUri } from '../common/uri';
import { GITHUB_FILE_SCHEME } from './compareChangesTreeDataProvider';

export class FileTypeDecorationProvider implements vscode.FileDecorationProvider {
	private _disposables: vscode.Disposable[];

	constructor() {
		this._disposables = [];
		this._disposables.push(vscode.window.registerFileDecorationProvider(this));
	}

	provideFileDecoration(
		uri: vscode.Uri,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.FileDecoration> {
		if (uri.scheme !== 'filechange' && uri.scheme !== GITHUB_FILE_SCHEME) {
			return;
		}

		const fileChangeUriParams = fromFileChangeNodeUri(uri);
		if (fileChangeUriParams && fileChangeUriParams.status !== undefined) {
			return {
				propagate: false,
				badge: this.letter(fileChangeUriParams.status),
				color: this.color(fileChangeUriParams.status)
			};
		}

		const prParams = fromPRUri(uri);

		if (prParams && prParams.status !== undefined) {
			return {
				propagate: false,
				badge: this.letter(prParams.status),
				color: this.color(prParams.status)
			};
		}

		return undefined;
	}

	color(status: GitChangeType): vscode.ThemeColor | undefined {
		let color: string | undefined;
		switch (status) {
			case GitChangeType.MODIFY:
				color = 'gitDecoration.modifiedResourceForeground';
				break;
			case GitChangeType.ADD:
				color = 'gitDecoration.addedResourceForeground';
				break;
			case GitChangeType.DELETE:
				color = 'gitDecoration.deletedResourceForeground';
				break;
			case GitChangeType.RENAME:
				color = 'gitDecoration.renamedResourceForeground';
				break;
			case GitChangeType.UNKNOWN:
				color = undefined;
				break;
			case GitChangeType.UNMERGED:
				color = 'gitDecoration.conflictingResourceForeground';
				break;
		}
		return color ? new vscode.ThemeColor(color) : undefined;
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
