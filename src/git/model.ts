/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { API, Repository } from '../typings/git';
import { GitExtension } from '../typings/git';

export function getAPI() {
	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git').exports;
	const git = gitExtension.getAPI(1);
	return git;
}

export class Model implements vscode.Disposable {
	repositories: Repository[];
	private _onDidOpenRepository = new vscode.EventEmitter<Repository>();
	readonly onDidOpenRepository: vscode.Event<Repository> = this._onDidOpenRepository.event;
	private _onDidCloseRepository = new vscode.EventEmitter<Repository>();
	readonly onDidCloseRepository: vscode.Event<Repository> = this._onDidCloseRepository.event;
	private _gitApi: API;
	private _openRepositories: Repository[] = [];
	get openRepositoryes(): Repository[] {
		return this._openRepositories;
	}
	private _disposables: vscode.Disposable[];

	constructor() {
		this._disposables = [];
		this._gitApi = getAPI();
		this.repositories = this._gitApi.repositories;
		this._disposables.push(this._gitApi.onDidCloseRepository(this._onDidCloseGitRepository.bind(this)));
		this._disposables.push(this._gitApi.onDidOpenRepository(this._onDidOpenGitRepository.bind(this)));
	}

	private _onDidCloseGitRepository(repository: Repository) {
		this.repositories = this._gitApi.repositories;
		this.repositories = this.repositories.filter(e => e !== repository);
		this._onDidCloseRepository.fire(repository);
	}

	private _onDidOpenGitRepository(repository: Repository) {
		this.repositories = this._gitApi.repositories;
		this._onDidOpenRepository.fire(repository);
	}

	public openRepository(repository: Repository) {
		this._openRepositories.push(repository);
		this._onDidOpenRepository.fire(repository);
	}

	public closeRepository(repository: Repository) {
		this._openRepositories = this._openRepositories.filter(e => e !== repository);
		this._onDidCloseRepository.fire(repository);
	}

	public getRepository(folder: vscode.WorkspaceFolder): Repository {
		return this._openRepositories.filter(repository => (repository as any).workspaceFolder === folder)[0];
	}

	public dispose() {
		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
		this._gitApi = null;
		this._openRepositories = [];
	}
}
