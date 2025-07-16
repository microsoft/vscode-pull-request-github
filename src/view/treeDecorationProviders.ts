/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable, disposeAll } from '../common/lifecycle';
import { Schemes, toResourceUri } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';

export abstract class TreeDecorationProvider extends Disposable implements vscode.FileDecorationProvider {
	private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = this._register(new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>());
	onDidChangeFileDecorations?: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> | undefined = this._onDidChangeFileDecorations.event;

	constructor() {
		super();
		this._register(vscode.window.registerFileDecorationProvider(this));
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
}

export class TreeDecorationProviders extends Disposable {
	private _gitHubReposListeners: vscode.Disposable[] = [];
	private _pullRequestListeners: vscode.Disposable[] = [];
	private _pullRequestPropertyChangeListeners: vscode.Disposable[] = [];

	private _providers: TreeDecorationProvider[] = [];

	constructor(private _repositoriesManager: RepositoriesManager) {
		super();
	}

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
			const models = gitHubRepo.pullRequestModels;
			const listeners = models.map(model => {
				return this._registerPullRequestPropertyListeners(folderManager, model);
			}).flat();
			this._pullRequestPropertyChangeListeners.push(...listeners);
		});
	}

	private _registerRepositoriesChangedListeners() {
		disposeAll(this._gitHubReposListeners);
		disposeAll(this._pullRequestListeners);
		disposeAll(this._pullRequestPropertyChangeListeners);
		this._repositoriesManager.folderManagers.forEach(folderManager => {
			this._gitHubReposListeners.push(folderManager.onDidChangeRepositories(() => {
				this._registerPullRequestAddedListeners(folderManager);
			}));
		});
	}

	private _registerListeners() {
		this._registerRepositoriesChangedListeners();
		this._register(this._repositoriesManager.onDidChangeFolderRepositories(() => {
			this._registerRepositoriesChangedListeners();
		}));

	}

	override dispose() {
		super.dispose();
		disposeAll(this._gitHubReposListeners);
		disposeAll(this._pullRequestListeners);
		disposeAll(this._pullRequestPropertyChangeListeners);
		disposeAll(this._providers);
	}
}
