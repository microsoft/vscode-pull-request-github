/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import * as pathLib from 'path';
import { Repository } from '../typings/git';
import { fromReviewUri } from '../common/uri';

export class GitContentProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> { return this._onDidChange.event; }

	private _fallback: (uri: vscode.Uri) => Promise<string> = null;

	constructor(private repository: Repository) { }

	async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
		let { path, commit } = fromReviewUri(uri);

		if (!path || !commit) {
			return '';
		}

		const absolutePath = pathLib.join(this.repository.rootUri.fsPath, path);
		let content = await this.repository.show(commit, absolutePath);

		if (!content) {
			content = await this._fallback(uri);
			if (!content) {
				// Content does not exist for the base or modified file for a file deletion or addition.
				// Manually check if the commit exists before notifying the user.

				try {
					await this.repository.getCommit(commit);
				} catch (err) {
					vscode.window.showErrorMessage(`We couldn't find commit ${commit} locally. You may want to sync the branch with remote. Sometimes commits can disappear after a force-push`);
				}
			}
		}

		return content || '';
	}

	registerTextDocumentContentFallback(provider: (uri: vscode.Uri) => Promise<string>) {
		this._fallback = provider;
	}
}
