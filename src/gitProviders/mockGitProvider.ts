/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { APIState, GitAPI, GitExtension, PublishEvent } from '../@types/git';
import { IGit, Repository } from '../api/api';
import { MockRepository } from './mockRepository';

export class MockGitProvider implements IGit, vscode.Disposable {
	private _mockRepository: MockRepository;
	get repositories(): Repository[] {
		return [this._mockRepository];
	}

	get state(): APIState {
		return 'initialized';
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

	public constructor() {
		this._disposables = [];
		this._mockRepository = new MockRepository();
		this._mockRepository.addRemote('origin', 'https://anksinha@dev.azure.com/anksinha/test/_git/test');
		this._onDidCloseRepository.fire(this._mockRepository);
		this._onDidOpenRepository.fire(this._mockRepository);
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}
