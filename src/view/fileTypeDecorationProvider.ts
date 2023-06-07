/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { GitChangeType } from '../common/file';
import { FileChangeNodeUriParams, fromFileChangeNodeUri, fromPRUri, PRUriParams, Schemes, toResourceUri } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';

export class FileTypeDecorationProvider implements vscode.FileDecorationProvider {
	private _disposables: vscode.Disposable[] = [];
	private _gitHubReposListeners: vscode.Disposable[] = [];
	private _pullRequestListeners: vscode.Disposable[] = [];
	private _fileViewedListeners: vscode.Disposable[] = [];

	_onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;


	constructor(private _repositoriesManager: RepositoriesManager) {
		this._disposables.push(vscode.window.registerFileDecorationProvider(this));
		this._registerListeners();
	}

	private _registerFileViewedListeners(folderManager: FolderRepositoryManager, model: PullRequestModel) {
		return model.onDidChangeFileViewedState(changed => {
			changed.changed.forEach(change => {
				const uri = vscode.Uri.joinPath(folderManager.repository.rootUri, change.fileName);
				const fileChange = model.fileChanges.get(change.fileName);
				if (fileChange) {
					const fileChangeUri = toResourceUri(uri, model.number, change.fileName, fileChange.status, fileChange.previousFileName);
					this._onDidChangeFileDecorations.fire(fileChangeUri);
					this._onDidChangeFileDecorations.fire(fileChangeUri.with({ scheme: folderManager.repository.rootUri.scheme }));
					this._onDidChangeFileDecorations.fire(fileChangeUri.with({ scheme: Schemes.Pr, authority: '' }));
				}
			});
		});
	}

	private _registerPullRequestAddedListeners(folderManager: FolderRepositoryManager) {
		folderManager.gitHubRepositories.forEach(gitHubRepo => {
			this._pullRequestListeners.push(gitHubRepo.onDidAddPullRequest(model => {
				this._fileViewedListeners.push(this._registerFileViewedListeners(folderManager, model));
			}));
			this._fileViewedListeners.push(...Array.from(gitHubRepo.pullRequestModels.values()).map(model => {
				return this._registerFileViewedListeners(folderManager, model);
			}));
		});
	}

	private _registerRepositoriesChangedListeners() {
		this._gitHubReposListeners.forEach(disposable => disposable.dispose());
		this._gitHubReposListeners = [];
		this._pullRequestListeners.forEach(disposable => disposable.dispose());
		this._pullRequestListeners = [];
		this._fileViewedListeners.forEach(disposable => disposable.dispose());
		this._fileViewedListeners = [];
		this._repositoriesManager.folderManagers.forEach(folderManager => {
			this._gitHubReposListeners.push(folderManager.onDidChangeRepositories(() => {
				this._registerPullRequestAddedListeners(folderManager,);
			}));
		});
	}

	private _registerListeners() {
		this._registerRepositoriesChangedListeners();
		this._disposables.push(this._repositoriesManager.onDidChangeFolderRepositories(() => {
			this._registerRepositoriesChangedListeners();
		}));

	}

	provideFileDecoration(
		uri: vscode.Uri,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.FileDecoration> {
		if (!uri.query) {
			return;
		}

		const fileChangeUriParams = fromFileChangeNodeUri(uri);
		if (fileChangeUriParams && fileChangeUriParams.status !== undefined) {
			return {
				propagate: false,
				badge: this.letter(fileChangeUriParams.status),
				color: this.color(fileChangeUriParams.status),
				tooltip: this.tooltip(fileChangeUriParams)
			};
		}

		const prParams = fromPRUri(uri);

		if (prParams && prParams.status !== undefined) {
			return {
				propagate: false,
				badge: this.letter(prParams.status),
				color: this.color(prParams.status),
				tooltip: this.tooltip(prParams)
			};
		}

		return undefined;
	}

	gitColors(status: GitChangeType): string | undefined {
		switch (status) {
			case GitChangeType.MODIFY:
				return 'gitDecoration.modifiedResourceForeground';
			case GitChangeType.ADD:
				return 'gitDecoration.addedResourceForeground';
			case GitChangeType.DELETE:
				return 'gitDecoration.deletedResourceForeground';
			case GitChangeType.RENAME:
				return 'gitDecoration.renamedResourceForeground';
			case GitChangeType.UNKNOWN:
				return undefined;
			case GitChangeType.UNMERGED:
				return 'gitDecoration.conflictingResourceForeground';
		}
	}

	remoteReposColors(status: GitChangeType): string | undefined {
		switch (status) {
			case GitChangeType.MODIFY:
				return 'remoteHub.decorations.modifiedForegroundColor';
			case GitChangeType.ADD:
				return 'remoteHub.decorations.addedForegroundColor';
			case GitChangeType.DELETE:
				return 'remoteHub.decorations.deletedForegroundColor';
			case GitChangeType.RENAME:
				return 'remoteHub.decorations.incomingRenamedForegroundColor';
			case GitChangeType.UNKNOWN:
				return undefined;
			case GitChangeType.UNMERGED:
				return 'remoteHub.decorations.conflictForegroundColor';
		}
	}

	color(status: GitChangeType): vscode.ThemeColor | undefined {
		let color: string | undefined = vscode.extensions.getExtension('vscode.git') ? this.gitColors(status) : this.remoteReposColors(status);
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

	tooltip(change: FileChangeNodeUriParams | PRUriParams) {
		if ((change.status === GitChangeType.RENAME) && change.previousFileName) {
			return `Renamed ${change.previousFileName} to ${path.basename(change.fileName)}`;
		}
	}

	dispose() {
		this._disposables.forEach(dispose => dispose.dispose());
		this._gitHubReposListeners.forEach(dispose => dispose.dispose());
		this._pullRequestListeners.forEach(dispose => dispose.dispose());
		this._fileViewedListeners.forEach(dispose => dispose.dispose());
	}
}
