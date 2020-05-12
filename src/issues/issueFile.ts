/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export class IssueFileSystemProvider implements vscode.FileSystemProvider {
	private content: Uint8Array | undefined;
	onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;
	watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
		return new vscode.Disposable(() => { });
	}
	stat(_uri: vscode.Uri): vscode.FileStat {
		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: 0,
			size: 0
		};
	}
	readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
		return [];
	}
	createDirectory(_uri: vscode.Uri): void { }
	readFile(_uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
		return this.content ?? new Uint8Array(0);
	}
	writeFile(_uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean; } = { create: false, overwrite: false }): void | Thenable<void> {
		this.content = content;
	}
	delete(_uri: vscode.Uri, _options: { recursive: boolean; }): void | Thenable<void> {
		this.content = undefined;
	}

	rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean; }): void | Thenable<void> { }
}