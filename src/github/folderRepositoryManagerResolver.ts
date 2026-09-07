/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { RepositoriesManager } from './repositoriesManager';
import { GitApiImpl } from '../api/api1';
import { RemoteOnlyRepository } from '../api/remoteOnlyRepository';
import { Disposable } from '../common/lifecycle';
import { ITelemetry } from '../common/telemetry';
import { IThemeWatcher } from '../themeWatcher';
import { CreatePullRequestHelper } from '../view/createPullRequestHelper';
import { ThemeData } from '../view/theme';

export class FolderRepositoryManagerResolver extends Disposable {
	private _remoteFolderRepositoryManager: FolderRepositoryManager | undefined;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _telemetry: ITelemetry,
	) {
		super();
	}

	getManagerForRepository(owner: string, repo: string): FolderRepositoryManager {
		const existingManager = this._repositoriesManager.getManagerForRepository(owner, repo)
			?? this._repositoriesManager.folderManagers[0];
		if (existingManager) {
			return existingManager;
		}
		if (this._remoteFolderRepositoryManager) {
			return this._remoteFolderRepositoryManager;
		}

		const repository = this._register(new RemoteOnlyRepository());
		const git = this._register(new GitApiImpl(this._repositoriesManager));
		const createPullRequestHelper = this._register(new CreatePullRequestHelper());
		const onDidChangeTheme = this._register(new vscode.EventEmitter<ThemeData | undefined>());
		const themeWatcher: IThemeWatcher = {
			onDidChangeTheme: onDidChangeTheme.event,
			themeData: undefined,
		};
		this._remoteFolderRepositoryManager = this._register(new FolderRepositoryManager(
			-1,
			this._context,
			repository,
			this._telemetry,
			git,
			this._repositoriesManager.credentialStore,
			createPullRequestHelper,
			themeWatcher,
		));
		return this._remoteFolderRepositoryManager;
	}
}
