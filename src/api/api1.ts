/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { APIState, PublishEvent } from '../@types/git';
import Logger from '../common/logger';
import { TernarySearchTree } from '../common/utils';
import { API, IGit, Repository } from './api';

export const enum RefType {
	Head,
	RemoteHead,
	Tag,
}

export const enum GitErrorCodes {
	BadConfigFile = 'BadConfigFile',
	AuthenticationFailed = 'AuthenticationFailed',
	NoUserNameConfigured = 'NoUserNameConfigured',
	NoUserEmailConfigured = 'NoUserEmailConfigured',
	NoRemoteRepositorySpecified = 'NoRemoteRepositorySpecified',
	NotAGitRepository = 'NotAGitRepository',
	NotAtRepositoryRoot = 'NotAtRepositoryRoot',
	Conflict = 'Conflict',
	StashConflict = 'StashConflict',
	UnmergedChanges = 'UnmergedChanges',
	PushRejected = 'PushRejected',
	RemoteConnectionError = 'RemoteConnectionError',
	DirtyWorkTree = 'DirtyWorkTree',
	CantOpenResource = 'CantOpenResource',
	GitNotFound = 'GitNotFound',
	CantCreatePipe = 'CantCreatePipe',
	CantAccessRemote = 'CantAccessRemote',
	RepositoryNotFound = 'RepositoryNotFound',
	RepositoryIsLocked = 'RepositoryIsLocked',
	BranchNotFullyMerged = 'BranchNotFullyMerged',
	NoRemoteReference = 'NoRemoteReference',
	InvalidBranchName = 'InvalidBranchName',
	BranchAlreadyExists = 'BranchAlreadyExists',
	NoLocalChanges = 'NoLocalChanges',
	NoStashFound = 'NoStashFound',
	LocalChangesOverwritten = 'LocalChangesOverwritten',
	NoUpstreamBranch = 'NoUpstreamBranch',
	IsInSubmodule = 'IsInSubmodule',
	WrongCase = 'WrongCase',
	CantLockRef = 'CantLockRef',
	CantRebaseMultipleBranches = 'CantRebaseMultipleBranches',
	PatchDoesNotApply = 'PatchDoesNotApply',
}

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

	private _updateReposContext() {
		const reposCount = Array.from(this._providers.values()).reduce((prev, current) => {
			return prev + current.repositories.length;
		}, 0);
		vscode.commands.executeCommand('setContext', 'azdoOpenRepositoryCount', reposCount);
	}

	registerGitProvider(provider: IGit): vscode.Disposable {
		Logger.appendLine(`Registering git provider`);
		const handler = this._nextHandle();
		this._providers.set(handler, provider);

		this._disposables.push(provider.onDidCloseRepository(e => this._onDidCloseRepository.fire(e)));
		this._disposables.push(
			provider.onDidOpenRepository(e => {
				Logger.appendLine(`Repository ${e.rootUri} has been opened`);
				this._updateReposContext();
				this._onDidOpenRepository.fire(e);
			}),
		);
		if (provider.onDidChangeState) {
			this._disposables.push(provider.onDidChangeState(e => this._onDidChangeState.fire(e)));
		}
		if (provider.onDidPublish) {
			this._disposables.push(provider.onDidPublish(e => this._onDidPublish.fire(e)));
		}
		this._updateReposContext();

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
			},
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
