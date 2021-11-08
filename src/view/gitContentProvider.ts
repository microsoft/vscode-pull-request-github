/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as pathLib from 'path';
import * as vscode from 'vscode';
import { GitApiImpl } from '../api/api1';
import { fromReviewUri } from '../common/uri';
import { getRepositoryForFile } from '../github/utils';
import { ReadonlyFileSystemProvider } from './readonlyFileSystemProvider';

export class GitContentFileSystemProvider extends ReadonlyFileSystemProvider {
	private _fallback?: (uri: vscode.Uri) => Promise<string>;

	constructor(private gitAPI: GitApiImpl) {
		super();
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		if (!this._fallback) {
			return new TextEncoder().encode('');
		}

		const { path, commit, rootPath } = fromReviewUri(uri.query);

		if (!path || !commit) {
			return new TextEncoder().encode('');
		}

		const repository = getRepositoryForFile(this.gitAPI, vscode.Uri.file(rootPath));
		if (!repository) {
			vscode.window.showErrorMessage(`We couldn't find an open repository for ${commit} locally.`);
			return new TextEncoder().encode('');
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
					vscode.window.showErrorMessage(
						`We couldn't find commit ${commit} locally. You may want to sync the branch with remote. Sometimes commits can disappear after a force-push`,
					);
				}
			}
		}

		return new TextEncoder().encode(content || '');
	}

	registerTextDocumentContentFallback(provider: (uri: vscode.Uri) => Promise<string>) {
		this._fallback = provider;
	}
}
