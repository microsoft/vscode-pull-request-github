/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as pathLib from 'path';
import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { GitApiImpl } from '../api/api1';
import Logger from '../common/logger';
import { fromReviewUri } from '../common/uri';
import { CredentialStore } from '../github/credentials';
import { getRepositoryForFile } from '../github/utils';
import { RepositoryFileSystemProvider } from './repositoryFileSystemProvider';
import { ReviewManager } from './reviewManager';

export class GitContentFileSystemProvider extends RepositoryFileSystemProvider {
	private _fallback?: (uri: vscode.Uri) => Promise<string>;

	constructor(gitAPI: GitApiImpl, credentialStore: CredentialStore, private readonly reviewManagers: ReviewManager[]) {
		super(gitAPI, credentialStore);
	}

	private getChangeModelForFile(file: vscode.Uri) {
		for (const manager of this.reviewManagers) {
			for (const change of manager.reviewModel.localFileChanges) {
				if ((change.changeModel.filePath.authority === file.authority) && (change.changeModel.filePath.path === file.path)) {
					return change.changeModel;
				}
			}
		}
	}

	private async getRepositoryForFile(file: vscode.Uri): Promise<Repository | undefined> {
		await this.waitForAuth();
		if ((this.gitAPI.state !== 'initialized') || (this.gitAPI.repositories.length === 0)) {
			await this.waitForRepos(4000);
		}

		return getRepositoryForFile(this.gitAPI, file);
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		if (!this._fallback) {
			return new TextEncoder().encode('');
		}

		const { path, commit, rootPath } = fromReviewUri(uri.query);

		if (!path || !commit) {
			return new TextEncoder().encode('');
		}

		const repository = await this.getRepositoryForFile(vscode.Uri.file(rootPath));
		if (!repository) {
			vscode.window.showErrorMessage(`We couldn't find an open repository for ${commit} locally.`);
			return new TextEncoder().encode('');
		}

		const absolutePath = pathLib.join(repository.rootUri.fsPath, path).replace(/\\/g, '/');
		let content: string | undefined;
		try {
			Logger.appendLine(`Getting change model (${repository.rootUri}) content for commit ${commit} and path ${absolutePath}`, 'GitContentFileSystemProvider');
			content = await this.getChangeModelForFile(uri)?.showBase();
			if (!content) {
				Logger.appendLine(`Getting repository (${repository.rootUri}) content for commit ${commit} and path ${absolutePath}`, 'GitContentFileSystemProvider');
				content = await repository.show(commit, absolutePath);
			}
			if (!content) {
				throw new Error();
			}
		} catch (_) {
			Logger.appendLine('Using fallback content provider.', 'GitContentFileSystemProvider');
			content = await this._fallback(uri);
			if (!content) {
				// Content does not exist for the base or modified file for a file deletion or addition.
				// Manually check if the commit exists before notifying the user.

				try {
					await repository.getCommit(commit);
				} catch (err) {
					Logger.error(err);
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
