/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TreeDecorationProvider } from './treeDecorationProviders';
import { fromCommitsNodeUri, Schemes } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';

export class CommitsDecorationProvider extends TreeDecorationProvider {

	constructor() {
		super();
	}

	registerPullRequestPropertyChangedListeners(_folderManager: FolderRepositoryManager, _model: PullRequestModel): vscode.Disposable {
		// No need to listen for changes since commit count doesn't change dynamically
		return { dispose: () => { } };
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
