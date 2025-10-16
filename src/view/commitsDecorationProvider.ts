/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TreeDecorationProvider } from './treeDecorationProviders';
import { createCommitsNodeUri, fromCommitsNodeUri, Schemes } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';

export class CommitsDecorationProvider extends TreeDecorationProvider {

	constructor() {
		super();
	}

	registerPullRequestPropertyChangedListeners(_folderManager: FolderRepositoryManager, model: PullRequestModel): vscode.Disposable {
		return model.onDidChange(e => {
			if (e.timeline) {
				// Timeline changed, which may include new commits, so update the decoration
				const uri = createCommitsNodeUri(model.remote.owner, model.remote.repositoryName, model.number, model.item.commits.length);
				this._onDidChangeFileDecorations.fire(uri);
			}
		});
	}

	provideFileDecoration(
		uri: vscode.Uri,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.FileDecoration> {
		if (uri.scheme !== Schemes.CommitsNode) {
			return undefined;
		}

		const params = fromCommitsNodeUri(uri);
		if (!params) {
			return undefined;
		}

		return {
			badge: params.commitsCount.toString(),
			tooltip: vscode.l10n.t('{0} commits', params.commitsCount)
		};
	}

}
