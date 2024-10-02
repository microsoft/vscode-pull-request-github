/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { fromFileChangeNodeUri, Schemes } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { TreeDecorationProvider } from './treeDecorationProviders';

export class CommentDecorationProvider extends TreeDecorationProvider {

	constructor(private readonly _repositoriesManager: RepositoriesManager) {
		super();
	}

	registerPullRequestPropertyChangedListeners(folderManager: FolderRepositoryManager, model: PullRequestModel): vscode.Disposable {
		return model.onDidChangeReviewThreads(changed => {
			[...changed.added, ...changed.removed].forEach(change => {
				this._handlePullRequestPropertyChange(folderManager, model, change);
			});
		});
	}

	provideFileDecoration(
		uri: vscode.Uri,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.FileDecoration> {
		if ((uri.scheme !== Schemes.Pr) && (uri.scheme !== Schemes.File) && (uri.scheme !== Schemes.Review) && (uri.scheme !== Schemes.FileChange)) {
			return undefined;
		}

		const query = fromFileChangeNodeUri(uri);
		const folderManager = this._repositoriesManager.getManagerForFile(uri);
		if (query && folderManager) {
			for (const repo of folderManager.gitHubRepositories) {
				const pr = repo.pullRequestModels.get(query.prNumber);
				if (pr && pr.reviewThreadsCache.some(c => c.path === query.fileName)) {
					return {
						propagate: false,
						tooltip: 'Commented',
						// allow-any-unicode-next-line
						badge: '💬',
					};
				}
			}
		}
		return undefined;
	}

}

