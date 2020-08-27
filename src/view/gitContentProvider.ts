/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import * as pathLib from 'path';
import { fromReviewUri } from '../common/uri';
import { getRepositoryForFile } from '../github/utils';
import { GitApiImpl } from '../api/api1';

export class GitContentProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> { return this._onDidChange.event; }

	private _fallback?: ((uri: vscode.Uri) => Promise<string>);

	constructor(private gitAPI: GitApiImpl) { }

	async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
		if (!this._fallback) {
			return '';
		}

		const { path, commit, rootPath } = fromReviewUri(uri);

		if (!path || !commit) {
			return '';
		}

		const repository = getRepositoryForFile(this.gitAPI, vscode.Uri.file(rootPath));
		if (!repository) {
			vscode.window.showErrorMessage(`We couldn't find an open repository for ${commit} locally.`);
			return '';
		}

		const absolutePath = pathLib.join(repository.rootUri.fsPath, path).replace(/\\/g, '/');
		let content: string;
		try {
			content = await repository.show(commit, absolutePath);
			if (!content) {
				throw new Error();
			}
		} catch (_) {
			content = await this._fallback(uri);
			if (!content) {
				// Content does not exist for the base or modified file for a file deletion or addition.
				// Manually check if the commit exists before notifying the user.

				try {
					await repository.getCommit(commit);
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
