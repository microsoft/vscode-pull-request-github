/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { API, IGit, Repository } from './api';
import { TernarySearchTree } from './map';

export class ApiImpl implements API, IGit, vscode.Disposable {
	public get repositories(): Repository[] {
		let ret: Repository[] = [];

		this._providers.forEach(provider => {
			if (provider.repositories) {
				ret.push(...provider.repositories);
			}
		});

		return ret;
	}

	private _onDidOpenRepository = new vscode.EventEmitter<Repository>();
	readonly onDidOpenRepository: vscode.Event<Repository> = this._onDidOpenRepository.event;
	private _onDidCloseRepository = new vscode.EventEmitter<Repository>();
	readonly onDidCloseRepository: vscode.Event<Repository> = this._onDidCloseRepository.event;

	private _providers: IGit[];
	private _disposables: vscode.Disposable[];
	constructor() {
		this._providers = [];
		this._disposables = [];
	}

	registerGitProvider(provider: IGit): void {
		this._providers.push(provider);
		this._disposables.push(provider.onDidCloseRepository(e => this._onDidCloseRepository.fire(e)));
		this._disposables.push(provider.onDidOpenRepository(e => this._onDidOpenRepository.fire(e)));

		provider.repositories.forEach(repository => {
			this._onDidCloseRepository.fire(repository);
		});
	}

	getGitProvider(uri: vscode.Uri): IGit | undefined {
		let foldersMap = TernarySearchTree.forPaths<IGit>();

		this._providers.forEach(provider => {
			if (provider.repositories) {
				let repositories = provider.repositories;

				for (const repository of repositories) {
					foldersMap.set(repository.rootUri.toString(), provider);
				}
			}
		});

		return foldersMap.findSubstr(uri.toString());
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}