/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestManager } from '../github/pullRequestManager';

export const NEW_ISSUE_SCHEME = 'newIssue';
export const NEW_ISSUE_FILE = 'NewIssue.md';
export const ASSIGNEES = 'Assignees:';
export const LABELS = 'Labels:';

export class IssueFileSystemProvider implements vscode.FileSystemProvider {
	private content: Uint8Array | undefined;
	private createTime: number = 0;
	private modifiedTime: number = 0;
	private _onDidChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]> = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;
	watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
		const disposable = this.onDidChangeFile(e => {
			if (e.length === 0 && e[0].type === vscode.FileChangeType.Deleted) {
				disposable.dispose();
			}
		});
		return disposable;
	}
	stat(_uri: vscode.Uri): vscode.FileStat {
		return {
			type: vscode.FileType.File,
			ctime: this.createTime,
			mtime: this.modifiedTime,
			size: this.content?.length ?? 0
		};
	}
	readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
		return [];
	}
	createDirectory(_uri: vscode.Uri): void { }
	readFile(_uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
		return this.content ?? new Uint8Array(0);
	}
	writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean; } = { create: false, overwrite: false }): void | Thenable<void> {
		const oldContent = this.content;
		this.content = content;
		if (oldContent === undefined) {
			this.createTime = new Date().getTime();
			this._onDidChangeFile.fire([{ uri: uri, type: vscode.FileChangeType.Created }]);
		} else {
			this.modifiedTime = new Date().getTime();
			this._onDidChangeFile.fire([{ uri: uri, type: vscode.FileChangeType.Changed }]);
		}
	}
	delete(uri: vscode.Uri, _options: { recursive: boolean; }): void | Thenable<void> {
		this.content = undefined;
		this.createTime = 0;
		this.modifiedTime = 0;
		this._onDidChangeFile.fire([{ uri: uri, type: vscode.FileChangeType.Deleted }]);
	}

	rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean; }): void | Thenable<void> { }
}

export class LabelCompletionProvider implements vscode.CompletionItemProvider {

	constructor(private manager: PullRequestManager) { }

	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionItem[]> {
		if (!document.lineAt(position.line).text.startsWith(LABELS)) {
			return [];
		}
		const defaults = await this.manager.getPullRequestDefaults();
		const labels = await this.manager.getLabels(undefined, defaults);
		return labels.map(label => {
			const item = new vscode.CompletionItem(label.name, vscode.CompletionItemKind.Keyword);
			item.documentation = new vscode.MarkdownString();
			item.documentation.appendMarkdown(`<span style="background-color:#${label.color};">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>`);
			item.documentation.isTrusted = true;
			return item;
		});
	}

}