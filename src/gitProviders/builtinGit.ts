/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGit, Repository } from '../api/api';
import { GitAPI, GitExtension, APIState, PublishEvent } from '../typings/git';

export class BuiltinGitProvider implements IGit, vscode.Disposable {
	get repositories(): Repository[] {
		return this._gitAPI.repositories as any[];
	}

	get state(): APIState {
		return this._gitAPI.state;
	}

	private _onDidOpenRepository = new vscode.EventEmitter<Repository>();
	readonly onDidOpenRepository: vscode.Event<Repository> = this._onDidOpenRepository.event;
	private _onDidCloseRepository = new vscode.EventEmitter<Repository>();
	readonly onDidCloseRepository: vscode.Event<Repository> = this._onDidCloseRepository.event;
	private _onDidChangeState = new vscode.EventEmitter<APIState>();
	readonly onDidChangeState: vscode.Event<APIState> = this._onDidChangeState.event;
	private _onDidPublish = new vscode.EventEmitter<PublishEvent>();
	readonly onDidPublish: vscode.Event<PublishEvent> = this._onDidPublish.event;

	private _gitAPI: GitAPI;
	private _disposables: vscode.Disposable[];

	private constructor(extension: vscode.Extension<GitExtension>) {
		const gitExtension = extension.exports;
		this._gitAPI = gitExtension.getAPI(1);
		this._disposables = [];
		this._disposables.push(this._gitAPI.onDidCloseRepository(e => this._onDidCloseRepository.fire(e as any)));
		this._disposables.push(this._gitAPI.onDidOpenRepository(e => this._onDidOpenRepository.fire(e as any)));
		this._disposables.push(this._gitAPI.onDidChangeState(e => this._onDidChangeState.fire(e)));
		this._disposables.push(this._gitAPI.onDidPublish(e => this._onDidPublish.fire(e)));
	}

	static createProvider(): BuiltinGitProvider | undefined {
		const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
		if (extension) {
			return new BuiltinGitProvider(extension);
		}
		return undefined;
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}
