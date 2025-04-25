/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { GitApiImpl } from '../api/api1';
import { Disposable } from '../common/lifecycle';
import { ITelemetry } from '../common/telemetry';
import { Schemes } from '../common/uri';
import { isDescendant } from '../common/utils';
import { CredentialStore } from '../github/credentials';
import { RepositoriesManager } from '../github/repositoriesManager';
import { GitContentFileSystemProvider } from './gitContentProvider';
import { PullRequestChangesTreeDataProvider } from './prChangesTreeDataProvider';
import { PullRequestsTreeDataProvider } from './prsTreeDataProvider';
import { ReviewManager } from './reviewManager';

export class ReviewsManager extends Disposable {
	public static ID = 'Reviews';

	constructor(
		private _context: vscode.ExtensionContext,
		private _reposManager: RepositoriesManager,
		private _reviewManagers: ReviewManager[],
		private _prsTreeDataProvider: PullRequestsTreeDataProvider,
		private _prFileChangesProvider: PullRequestChangesTreeDataProvider,
		private _telemetry: ITelemetry,
		private _credentialStore: CredentialStore,
		private _gitApi: GitApiImpl,
	) {
		super();
		const gitContentProvider = new GitContentFileSystemProvider(_gitApi, _credentialStore, () => this._reviewManagers);
		gitContentProvider.registerTextDocumentContentFallback(this.provideTextDocumentContent.bind(this));
		this._register(vscode.workspace.registerFileSystemProvider(Schemes.Review, gitContentProvider, { isReadonly: true }));
		this.registerListeners();
		this._register(this._prsTreeDataProvider);
	}

	get reviewManagers(): ReviewManager[] {
		return this._reviewManagers;
	}

	private registerListeners(): void {
		this._register(vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration('githubPullRequests.showInSCM')) {
				if (this._prFileChangesProvider) {
					this._prFileChangesProvider.dispose();
					this._prFileChangesProvider = new PullRequestChangesTreeDataProvider(this._gitApi, this._reposManager);

					for (const reviewManager of this._reviewManagers) {
						reviewManager.updateState(true);
					}
				}

				this._prsTreeDataProvider.dispose();
				this._prsTreeDataProvider = this._register(new PullRequestsTreeDataProvider(this._telemetry, this._context, this._reposManager));
				this._prsTreeDataProvider.initialize(this._reviewManagers.map(manager => manager.reviewModel), this._credentialStore);
			}
		}));
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string | undefined> {
		for (const reviewManager of this._reviewManagers) {
			if (isDescendant(reviewManager.repository.rootUri.fsPath, uri.fsPath)) {
				return reviewManager.provideTextDocumentContent(uri);
			}
		}
		return '';
	}

	public addReviewManager(reviewManager: ReviewManager) {
		// Try to insert in workspace folder order
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders) {
			const index = workspaceFolders.findIndex(
				folder => folder.uri.toString() === reviewManager.repository.rootUri.toString(),
			);
			if (index > -1) {
				const arrayEnd = this._reviewManagers.slice(index, this._reviewManagers.length);
				this._reviewManagers = this._reviewManagers.slice(0, index);
				this._reviewManagers.push(reviewManager);
				this._reviewManagers.push(...arrayEnd);
				return;
			}
		}
		this._reviewManagers.push(reviewManager);
	}

	public removeReviewManager(repo: Repository) {
		const reviewManagerIndex = this._reviewManagers.findIndex(
			manager => manager.repository.rootUri.toString() === repo.rootUri.toString(),
		);
		if (reviewManagerIndex >= 0) {
			const manager = this._reviewManagers[reviewManagerIndex];
			this._reviewManagers.splice(reviewManagerIndex);
			manager.dispose();
		}
	}
}
