/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Branch, BranchQuery, Change, Commit, CommitOptions, FetchOptions, InputBox, Ref, RefQuery, Repository, RepositoryState, RepositoryUIState } from './api';

export class RemoteOnlyRepository implements Repository, vscode.Disposable {
	private readonly _onDidChangeState = new vscode.EventEmitter<void>();
	private readonly _onDidChangeUiState = new vscode.EventEmitter<void>();

	readonly inputBox: InputBox = { value: '' };
	readonly rootUri = vscode.Uri.from({ scheme: 'github-remote', authority: 'github.com' });
	readonly state: RepositoryState = {
		HEAD: undefined,
		remotes: [],
		submodules: [],
		worktrees: undefined,
		rebaseCommit: undefined,
		mergeChanges: [],
		indexChanges: [],
		workingTreeChanges: [],
		onDidChange: this._onDidChangeState.event,
	};
	readonly ui: RepositoryUIState = {
		selected: false,
		onDidChange: this._onDidChangeUiState.event,
	};

	dispose(): void {
		this._onDidChangeState.dispose();
		this._onDidChangeUiState.dispose();
	}

	getConfigs(): Promise<{ key: string; value: string }[]> {
		return Promise.resolve([]);
	}

	getConfig(_key: string): Promise<string> {
		return Promise.resolve('');
	}

	setConfig(_key: string, _value: string): Promise<string> {
		return this.unsupported('set Git configuration');
	}

	getGlobalConfig(_key: string): Promise<string> {
		return Promise.resolve('');
	}

	getObjectDetails(_treeish: string, _path: string): Promise<{ mode: string; object: string; size: number }> {
		return this.unsupported('read Git object details');
	}

	detectObjectType(_object: string): Promise<{ mimetype: string; encoding?: string }> {
		return this.unsupported('detect a Git object type');
	}

	buffer(_ref: string, _path: string): Promise<Buffer> {
		return this.unsupported('read a Git object');
	}

	show(_ref: string, _path: string): Promise<string> {
		return this.unsupported('show a Git object');
	}

	getCommit(_ref: string): Promise<Commit> {
		return this.unsupported('read a Git commit');
	}

	clean(_paths: string[]): Promise<void> {
		return this.unsupported('clean files');
	}

	apply(_patch: string, _reverse?: boolean): Promise<void> {
		return this.unsupported('apply a patch');
	}

	diff(_cached?: boolean): Promise<string> {
		return this.unsupported('create a diff');
	}

	diffWithHEAD(): Promise<Change[]>;
	diffWithHEAD(_path: string): Promise<string>;
	diffWithHEAD(_path?: string): Promise<Change[] | string> {
		return this.unsupported('create a diff with HEAD');
	}

	diffWith(_ref: string): Promise<Change[]>;
	diffWith(_ref: string, _path: string): Promise<string>;
	diffWith(_ref: string, _path?: string): Promise<Change[] | string> {
		return this.unsupported('create a diff with a ref');
	}

	diffIndexWithHEAD(): Promise<Change[]>;
	diffIndexWithHEAD(_path: string): Promise<string>;
	diffIndexWithHEAD(_path?: string): Promise<Change[] | string> {
		return this.unsupported('create an index diff with HEAD');
	}

	diffIndexWith(_ref: string): Promise<Change[]>;
	diffIndexWith(_ref: string, _path: string): Promise<string>;
	diffIndexWith(_ref: string, _path?: string): Promise<Change[] | string> {
		return this.unsupported('create an index diff with a ref');
	}

	diffBlobs(_object1: string, _object2: string): Promise<string> {
		return this.unsupported('diff Git objects');
	}

	diffBetween(_ref1: string, _ref2: string): Promise<Change[]>;
	diffBetween(_ref1: string, _ref2: string, _path: string): Promise<string>;
	diffBetween(_ref1: string, _ref2: string, _path?: string): Promise<Change[] | string> {
		return this.unsupported('create a diff between refs');
	}

	hashObject(_data: string): Promise<string> {
		return this.unsupported('hash an object');
	}

	createBranch(_name: string, _checkout: boolean, _ref?: string): Promise<void> {
		return this.unsupported('create a branch');
	}

	deleteBranch(_name: string, _force?: boolean): Promise<void> {
		return this.unsupported('delete a branch');
	}

	getBranch(_name: string): Promise<Branch> {
		return this.unsupported('read a branch');
	}

	getBranches(_query: BranchQuery): Promise<Ref[]> {
		return Promise.resolve([]);
	}

	getBranchBase(_name: string): Promise<Branch | undefined> {
		return Promise.resolve(undefined);
	}

	setBranchUpstream(_name: string, _upstream: string): Promise<void> {
		return this.unsupported('set a branch upstream');
	}

	getRefs(_query: RefQuery, _cancellationToken?: vscode.CancellationToken): Promise<Ref[]> {
		return Promise.resolve([]);
	}

	getMergeBase(_ref1: string, _ref2: string): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}

	status(): Promise<void> {
		return this.unsupported('read Git status');
	}

	checkout(_treeish: string): Promise<void> {
		return this.unsupported('check out a ref');
	}

	addRemote(_name: string, _url: string): Promise<void> {
		return this.unsupported('add a remote');
	}

	removeRemote(_name: string): Promise<void> {
		return this.unsupported('remove a remote');
	}

	renameRemote(_name: string, _newName: string): Promise<void> {
		return this.unsupported('rename a remote');
	}

	fetch(_options?: FetchOptions): Promise<void>;
	fetch(_remote?: string, _ref?: string, _depth?: number): Promise<void>;
	fetch(_optionsOrRemote?: FetchOptions | string, _ref?: string, _depth?: number): Promise<void> {
		return this.unsupported('fetch');
	}

	pull(_unshallow?: boolean): Promise<void> {
		return this.unsupported('pull');
	}

	push(_remoteName?: string, _branchName?: string, _setUpstream?: boolean): Promise<void> {
		return this.unsupported('push');
	}

	blame(_path: string): Promise<string> {
		return this.unsupported('blame a file');
	}

	log(_options?: { range?: string; maxEntries?: number; path?: string; sortByAuthorDate?: boolean }): Promise<Commit[]> {
		return this.unsupported('read Git history');
	}

	commit(_message: string, _opts?: CommitOptions): Promise<void> {
		return this.unsupported('commit');
	}

	add(_paths: string[]): Promise<void> {
		return this.unsupported('add files');
	}

	merge(_ref: string): Promise<void> {
		return this.unsupported('merge');
	}

	mergeAbort(): Promise<void> {
		return this.unsupported('abort a merge');
	}

	private unsupported<T>(operation: string): Promise<T> {
		return Promise.reject(new Error(`Cannot ${operation} without a local Git repository.`));
	}
}
