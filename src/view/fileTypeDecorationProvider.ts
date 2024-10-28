/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { GitChangeType } from '../common/file';
import { FileChangeNodeUriParams, fromFileChangeNodeUri, fromPRUri, PRUriParams } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { TreeDecorationProvider } from './treeDecorationProviders';

export class FileTypeDecorationProvider extends TreeDecorationProvider {
	constructor() {
		super();
	}

	registerPullRequestPropertyChangedListeners(folderManager: FolderRepositoryManager, model: PullRequestModel): vscode.Disposable {
		return model.onDidChangeFileViewedState(changed => {
			changed.changed.forEach(change => {
				this._handlePullRequestPropertyChange(folderManager, model, { path: change.fileName });
			});
		});
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
}
