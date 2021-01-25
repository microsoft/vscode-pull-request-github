/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { API, IGit, Repository } from './api';
import { TernarySearchTree } from '../common/utils';
import { APIState, PublishEvent } from '../typings/git';

export class GitApiImpl implements API, IGit, vscode.Disposable {
	private static _handlePool: number = 0;
	private _providers = new Map<number, IGit>();

	public get repositories(): Repository[] {
		const ret: Repository[] = [];

		this._providers.forEach(provider => {
			if (provider.repositories) {
				ret.push(...provider.repositories);
			}
		});

		return ret;
	}

	public get state(): APIState | undefined {
		let state: APIState | undefined;

		this._providers.forEach(provider => {
			if (provider.state) {
				state = provider.state;
			}
		});

		return state;
	}

	private _onDidOpenRepository = new vscode.EventEmitter<Repository>();
	readonly onDidOpenRepository: vscode.Event<Repository> = this._onDidOpenRepository.event;
	private _onDidCloseRepository = new vscode.EventEmitter<Repository>();
	readonly onDidCloseRepository: vscode.Event<Repository> = this._onDidCloseRepository.event;
	private _onDidChangeState = new vscode.EventEmitter<APIState>();
	readonly onDidChangeState: vscode.Event<APIState> = this._onDidChangeState.event;
	private _onDidPublish = new vscode.EventEmitter<PublishEvent>();
	readonly onDidPublish: vscode.Event<PublishEvent> = this._onDidPublish.event;

	private _disposables: vscode.Disposable[];
	constructor() {
		this._disposables = [];
	}

	registerGitProvider(provider: IGit): vscode.Disposable {
		const handler = this._nextHandle();
		this._providers.set(handler, provider);

		this._disposables.push(provider.onDidCloseRepository(e => this._onDidCloseRepository.fire(e)));
		this._disposables.push(provider.onDidOpenRepository(e => this._onDidOpenRepository.fire(e)));
		if (provider.onDidChangeState) {
			this._disposables.push(provider.onDidChangeState(e => this._onDidChangeState.fire(e)));
		}
		if (provider.onDidPublish) {
			this._disposables.push(provider.onDidPublish(e => this._onDidPublish.fire(e)));
		}

		provider.repositories.forEach(repository => {
			this._onDidOpenRepository.fire(repository);
		});

		return {
			dispose: () => {
				if (provider && provider.repositories) {
					provider.repositories.forEach(repository => {
						this._onDidCloseRepository.fire(repository);
					});
				}
				this._providers.delete(handler);
			}
		};
	}

	getGitProvider(uri: vscode.Uri): IGit | undefined {
		const foldersMap = TernarySearchTree.forPaths<IGit>();

		this._providers.forEach(provider => {
			if (provider.repositories) {
				const repositories = provider.repositories;

				for (const repository of repositories) {
					foldersMap.set(repository.rootUri.toString(), provider);
				}
			}
		});

		return foldersMap.findSubstr(uri.toString());
	}

	private _nextHandle(): number {
		return GitApiImpl._handlePool++;
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}