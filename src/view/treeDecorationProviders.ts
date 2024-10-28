/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Schemes, toResourceUri } from '../common/uri';
import { dispose } from '../common/utils';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';

export abstract class TreeDecorationProvider implements vscode.FileDecorationProvider {
	private _disposables: vscode.Disposable[] = [];
	private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	onDidChangeFileDecorations?: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> | undefined = this._onDidChangeFileDecorations.event;

	constructor() {
		this._disposables.push(vscode.window.registerFileDecorationProvider(this));
	}

	abstract provideFileDecoration(uri: unknown, token: unknown): vscode.ProviderResult<vscode.FileDecoration>;

	abstract registerPullRequestPropertyChangedListeners(folderManager: FolderRepositoryManager, model: PullRequestModel): vscode.Disposable;

	protected _handlePullRequestPropertyChange(folderManager: FolderRepositoryManager, model: PullRequestModel, changed: { path: string }) {
		const path = changed.path;
		const uri = vscode.Uri.joinPath(folderManager.repository.rootUri, path);
		const fileChange = model.fileChanges.get(path);
		if (fileChange) {
			const fileChangeUri = toResourceUri(uri, model.number, path, fileChange.status, fileChange.previousFileName);
			this._onDidChangeFileDecorations.fire(fileChangeUri);
			this._onDidChangeFileDecorations.fire(fileChangeUri.with({ scheme: folderManager.repository.rootUri.scheme }));
			this._onDidChangeFileDecorations.fire(fileChangeUri.with({ scheme: Schemes.Pr, authority: '' }));
		}
	}

	dispose() {
		dispose(this._disposables);
	}
}

export class TreeDecorationProviders {
	private _disposables: vscode.Disposable[] = [];
	private _gitHubReposListeners: vscode.Disposable[] = [];
	private _pullRequestListeners: vscode.Disposable[] = [];
	private _pullRequestPropertyChangeListeners: vscode.Disposable[] = [];

	private _providers: TreeDecorationProvider[] = [];

	constructor(private _repositoriesManager: RepositoriesManager) { }

	public registerProviders(provider: TreeDecorationProvider[]) {
		this._providers.push(...provider);
		this._registerListeners();
	}

	private _registerPullRequestPropertyListeners(folderManager: FolderRepositoryManager, model: PullRequestModel): vscode.Disposable[] {
		return this._providers.map(provider => provider.registerPullRequestPropertyChangedListeners(folderManager, model));
	}

	private _registerPullRequestAddedListeners(folderManager: FolderRepositoryManager) {
		folderManager.gitHubRepositories.forEach(gitHubRepo => {
			this._pullRequestListeners.push(gitHubRepo.onDidAddPullRequest(model => {
				this._pullRequestPropertyChangeListeners.push(...this._registerPullRequestPropertyListeners(folderManager, model));
			}));
			const models = Array.from(gitHubRepo.pullRequestModels.values());
			const listeners = models.map(model => {
				return this._registerPullRequestPropertyListeners(folderManager, model);
			}).flat();
			this._pullRequestPropertyChangeListeners.push(...listeners);
		});
	}

	private _registerRepositoriesChangedListeners() {
		this._gitHubReposListeners.forEach(disposable => disposable.dispose());
		this._gitHubReposListeners = [];
		this._pullRequestListeners.forEach(disposable => disposable.dispose());
		this._pullRequestListeners = [];
		this._pullRequestPropertyChangeListeners.forEach(disposable => disposable.dispose());
		this._pullRequestPropertyChangeListeners = [];
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

	dispose() {
		dispose(this._disposables);
		dispose(this._gitHubReposListeners);
		dispose(this._pullRequestListeners);
		dispose(this._pullRequestPropertyChangeListeners);
		dispose(this._providers);
	}
}
