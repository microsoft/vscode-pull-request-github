/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export abstract class ReadonlyFileSystemProvider implements vscode.FileSystemProvider {
	protected _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	onDidChangeFile = this._onDidChangeFile.event;

	constructor() {}

	watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
		/** no op */
		return { dispose: () => {} };
	}

	stat(_uri: any): vscode.FileStat {
		/** mock stat as they are not necessarily needed */
		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: 0,
			size: 0
		};
	}

	readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(_uri: vscode.Uri): void {
		/** no op */
	}

	abstract readFile(_uri: vscode.Uri): Promise<Uint8Array>;

	writeFile(_uri: vscode.Uri, _content: Uint8Array, _options: { create: boolean; overwrite: boolean; }): void {
		/** no op */
	}

	delete(_uri: vscode.Uri, _options: { recursive: boolean; }): void {
		/** no op */
	}

	rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean; }): void {
		/** no op */
	}
}