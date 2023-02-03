/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { GitApiImpl } from '../api/api1';
import { DiffChangeType, getModifiedContentFromDiffHunk } from '../common/diffHunk';
import { GitChangeType, InMemFileChange, SlimFileChange } from '../common/file';
import Logger from '../common/logger';
import { fromPRUri, PRUriParams } from '../common/uri';
import { CredentialStore } from '../github/credentials';
import { FolderRepositoryManager, ReposManagerState } from '../github/folderRepositoryManager';
import { IResolvedPullRequestModel, PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { FileChangeModel, InMemFileChangeModel, RemoteFileChangeModel } from './fileChangeModel';
import { RepositoryFileSystemProvider } from './repositoryFileSystemProvider';

export class InMemPRFileSystemProvider extends RepositoryFileSystemProvider {
	private _prFileChangeContentProviders: { [key: number]: (uri: vscode.Uri) => Promise<string> } = {};

	constructor(private reposManagers: RepositoriesManager, gitAPI: GitApiImpl, credentialStore: CredentialStore) {
		super(gitAPI, credentialStore);
	}

	registerTextDocumentContentProvider(
		prNumber: number,
		provider: (uri: vscode.Uri) => Promise<string>,
	): vscode.Disposable {
		this._prFileChangeContentProviders[prNumber] = provider;

		return {
			dispose: () => {
				delete this._prFileChangeContentProviders[prNumber];
			},
		};
	}

	private resolveChanges(rawChanges: (SlimFileChange | InMemFileChange)[], pr: PullRequestModel,
		folderRepositoryManager: FolderRepositoryManager,
		mergeBase: string): (RemoteFileChangeModel | InMemFileChangeModel)[] {
		const isCurrentPR = pr.equals(folderRepositoryManager.activePullRequest);

		return rawChanges.map(change => {
			if (change instanceof SlimFileChange) {
				return new RemoteFileChangeModel(folderRepositoryManager, change, pr);
			}
			return new InMemFileChangeModel(folderRepositoryManager,
				pr as (PullRequestModel & IResolvedPullRequestModel),
				change, isCurrentPR, mergeBase);
		});
	}

	private waitForGitHubRepos(folderRepositoryManager: FolderRepositoryManager, milliseconds: number) {
		return new Promise<void>(resolve => {
			const timeout = setTimeout(() => {
				disposable.dispose();
				resolve();
			}, milliseconds);
			const disposable = folderRepositoryManager.onDidLoadRepositories(e => {
				if (e === ReposManagerState.RepositoriesLoaded) {
					clearTimeout(timeout);
					disposable.dispose();
					resolve();
				}
			});
		});
	}

	private async tryRegisterNewProvider(uri: vscode.Uri, prUriParams: PRUriParams) {
		await this.waitForAuth();
		if ((this.gitAPI.state !== 'initialized') || (this.gitAPI.repositories.length === 0)) {
			await this.waitForRepos(4000);
		}
		const folderRepositoryManager = this.reposManagers.getManagerForFile(uri);
		if (!folderRepositoryManager) {
			return;
		}
		let repo = folderRepositoryManager.findRepo(repo => repo.remote.remoteName === prUriParams.remoteName);
		if (!repo) {
			// Depending on the git provider, we might not have a GitHub repo right away, even if we already have git repos.
			// This can take a long time.
			await this.waitForGitHubRepos(folderRepositoryManager, 10000);
			repo = folderRepositoryManager.findRepo(repo => repo.remote.remoteName === prUriParams.remoteName);
		}
		if (!repo) {
			return;
		}
		const pr = await folderRepositoryManager.resolvePullRequest(repo.remote.owner, repo.remote.repositoryName, prUriParams.prNumber);
		if (!pr) {
			return;
		}
		const rawChanges = await pr.getFileChangesInfo();
		const mergeBase = pr.mergeBase;
		if (!mergeBase) {
			return;
		}
		const changes = this.resolveChanges(rawChanges, pr, folderRepositoryManager, mergeBase);
		this.registerTextDocumentContentProvider(pr.number, async (uri: vscode.Uri) => {
			const params = fromPRUri(uri);
			if (!params) {
				return '';
			}
			const fileChange = changes.find(
				contentChange => contentChange.fileName === params.fileName,
			);

			if (!fileChange) {
				Logger.error(`Cannot find content for document ${uri.toString()}`, 'PR');
				return '';
			}

			return provideDocumentContentForChangeModel(folderRepositoryManager, pr, params, fileChange);
		});
	}

	private async readFileWithProvider(uri: vscode.Uri, prNumber: number): Promise<Uint8Array | undefined> {
		const provider = this._prFileChangeContentProviders[prNumber];
		if (provider) {
			const content = await provider(uri);
			return new TextEncoder().encode(content);
		}
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const prUriParams = fromPRUri(uri);
		if (!prUriParams || (prUriParams.prNumber === undefined)) {
			return new TextEncoder().encode('');
		}
		const providerResult = await this.readFileWithProvider(uri, prUriParams.prNumber);
		if (providerResult) {
			return providerResult;
		}

		await this.tryRegisterNewProvider(uri, prUriParams);
		return (await this.readFileWithProvider(uri, prUriParams.prNumber)) ?? new TextEncoder().encode('');
	}
}

let inMemPRFileSystemProvider: InMemPRFileSystemProvider | undefined;

export function getInMemPRFileSystemProvider(initialize?: { reposManager: RepositoriesManager, gitAPI: GitApiImpl, credentialStore: CredentialStore }): InMemPRFileSystemProvider | undefined {
	if (!inMemPRFileSystemProvider && initialize) {
		inMemPRFileSystemProvider = new InMemPRFileSystemProvider(initialize.reposManager, initialize.gitAPI, initialize.credentialStore);
	}
	return inMemPRFileSystemProvider;
}

export async function provideDocumentContentForChangeModel(folderRepoManager: FolderRepositoryManager, pullRequestModel: PullRequestModel, params: PRUriParams, fileChange: FileChangeModel): Promise<string> {
	if (
		(params.isBase && fileChange.status === GitChangeType.ADD) ||
		(!params.isBase && fileChange.status === GitChangeType.DELETE)
	) {
		return '';
	}

	if ((fileChange instanceof RemoteFileChangeModel) || ((fileChange instanceof InMemFileChangeModel) && await fileChange.isPartial())) {
		try {
			if (params.isBase) {
				return pullRequestModel.getFile(
					fileChange.previousFileName || fileChange.fileName,
					params.baseCommit,
				);
			} else {
				return pullRequestModel.getFile(fileChange.fileName, params.headCommit);
			}
		} catch (e) {
			Logger.error(`Fetching file content failed: ${e}`, 'PR');
			vscode.window
				.showWarningMessage(
					'Opening this file locally failed. Would you like to view it on GitHub?',
					'Open on GitHub',
				)
				.then(result => {
					if ((result === 'Open on GitHub') && fileChange.blobUrl) {
						vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(fileChange.blobUrl));
					}
				});
			return '';
		}
	}

	if (fileChange instanceof InMemFileChangeModel) {
		const readContentFromDiffHunk =
			fileChange.status === GitChangeType.ADD || fileChange.status === GitChangeType.DELETE;

		if (readContentFromDiffHunk) {
			if (params.isBase) {
				// left
				const left: string[] = [];
				const diffHunks = await fileChange.diffHunks();
				for (let i = 0; i < diffHunks.length; i++) {
					for (let j = 0; j < diffHunks[i].diffLines.length; j++) {
						const diffLine = diffHunks[i].diffLines[j];
						if (diffLine.type === DiffChangeType.Add) {
							// nothing
						} else if (diffLine.type === DiffChangeType.Delete) {
							left.push(diffLine.text);
						} else if (diffLine.type === DiffChangeType.Control) {
							// nothing
						} else {
							left.push(diffLine.text);
						}
					}
				}

				return left.join('\n');
			} else {
				const right: string[] = [];
				const diffHunks = await fileChange.diffHunks();
				for (let i = 0; i < diffHunks.length; i++) {
					for (let j = 0; j < diffHunks[i].diffLines.length; j++) {
						const diffLine = diffHunks[i].diffLines[j];
						if (diffLine.type === DiffChangeType.Add) {
							right.push(diffLine.text);
						} else if (diffLine.type === DiffChangeType.Delete) {
							// nothing
						} else if (diffLine.type === DiffChangeType.Control) {
							// nothing
						} else {
							right.push(diffLine.text);
						}
					}
				}

				return right.join('\n');
			}
		} else {
			const originalFileName =
				fileChange.status === GitChangeType.RENAME ? fileChange.previousFileName : fileChange.fileName;
			const originalFilePath = vscode.Uri.joinPath(
				folderRepoManager.repository.rootUri,
				originalFileName!,
			);
			const originalContent = await folderRepoManager.repository.show(
				params.baseCommit,
				originalFilePath.fsPath,
			);

			if (params.isBase) {
				return originalContent;
			} else {
				return getModifiedContentFromDiffHunk(originalContent, fileChange.patch);
			}
		}
	}

	return '';
}