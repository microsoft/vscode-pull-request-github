/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ViewedState } from '../common/comment';
import { GitChangeType } from '../common/file';
import { fromFileChangeNodeUri, fromPRUri } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { RepositoriesManager } from '../github/repositoriesManager';
import { ReviewManager } from './reviewManager';

export class FileTypeDecorationProvider implements vscode.FileDecorationProvider {
	private _disposables: vscode.Disposable[] = [];
	private _activePullRequestListeners: vscode.Disposable[] = [];
	private _fileViewedListeners: Map<FolderRepositoryManager, vscode.Disposable[]> = new Map();

	_onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeFileDecorations.event;


	constructor(private _repositoriesManager: RepositoriesManager, private _reviewManagers: ReviewManager[]) {
		this._disposables.push(vscode.window.registerFileDecorationProvider(this));
		this._registerListeners();
	}

	private _registerFileViewedListeners(folderManager: FolderRepositoryManager) {
		let viewedListeners: vscode.Disposable[] = [];
		if (this._fileViewedListeners.has(folderManager)) {
			this._fileViewedListeners.get(folderManager)?.forEach(disposable => disposable.dispose());
		}
		this._fileViewedListeners.set(folderManager, viewedListeners);
		if (folderManager.activePullRequest) {
			viewedListeners.push(folderManager.activePullRequest.onDidChangeFileViewedState(changed => {
				this._onDidChangeFileDecorations.fire(changed.changed.map(change => {
					const reviewManager = ReviewManager.getReviewManagerForFolderManager(this._reviewManagers, folderManager);
					const fileChangeNode = reviewManager?.reviewModel.localFileChangesMap.get(change.fileName);
					return fileChangeNode!.resourceUri;
				}));
			}));
		}
	}

	private _registerActivePullRequestListeners() {
		this._activePullRequestListeners.forEach(disposable => disposable.dispose());
		this._fileViewedListeners.forEach(dispose => dispose.forEach(dispose => dispose.dispose()));
		this._activePullRequestListeners.push(...this._repositoriesManager.folderManagers.map(folderManager => {
			this._registerFileViewedListeners(folderManager);
			return folderManager.onDidChangeActivePullRequest(() => {
				this._registerFileViewedListeners(folderManager);
			});
		}));
	}

	private _registerListeners() {
		this._registerActivePullRequestListeners();
		this._disposables.push(this._repositoriesManager.onDidChangeFolderRepositories(() => {
			this._registerActivePullRequestListeners();
		}));

	}

	private getViewedState(fileName: string, uri: vscode.Uri) {
		const manager = this._repositoriesManager.getManagerForFile(uri);
		return manager?.activePullRequest?.fileChangeViewedState[fileName] ?? ViewedState.UNVIEWED;
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
				color: this.color(fileChangeUriParams.status, this.getViewedState(fileChangeUriParams.fileName, uri))
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

	color(status: GitChangeType, viewedState?: ViewedState): vscode.ThemeColor | undefined {
		if (viewedState === ViewedState.VIEWED) {
			return undefined;
		}

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
		this._activePullRequestListeners.forEach(dispose => dispose.dispose());
		this._fileViewedListeners.forEach(dispose => dispose.forEach(dispose => dispose.dispose()));
	}
}
