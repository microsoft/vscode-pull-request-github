/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LiveShare, SharedServiceProxy } from 'vsls/vscode.js';
import { Model } from './model';
import { VSLS_GIT_PR_SESSION_NAME, VSLS_REQUEST_NAME, VSLS_REPOSITORY_INITIALIZATION_NAME, VSLS_STATE_CHANGE_NOFITY_NAME } from '../constants';
import { RepositoryState, Commit, Branch, Ref, Remote, Submodule, Change } from '../typings/git';

export class VSLSGuest implements vscode.Disposable {
	private _sharedServiceProxy?: SharedServiceProxy;
	private _disposables: vscode.Disposable[];
	constructor(private _api: LiveShare, private _model: Model) {
		this._disposables = [];
	}

	public async initialize() {
		this._sharedServiceProxy = await this._api.getSharedService(VSLS_GIT_PR_SESSION_NAME) || undefined;

		if (!this._sharedServiceProxy) {
			return;
		}

		if (this._sharedServiceProxy.isServiceAvailable) {
			await this._refreshWorkspaces(true);
		}
		this._disposables.push(this._sharedServiceProxy.onDidChangeIsServiceAvailable(async e => {
			await this._refreshWorkspaces(e);
		}));
		this._disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(this._onDidChangeWorkspaceFolders.bind(this)));
	}

	private async _onDidChangeWorkspaceFolders(e: vscode.WorkspaceFoldersChangeEvent) {
		e.added.forEach(async folder => {
			if (folder.uri.scheme === 'vsls' && this._sharedServiceProxy && this._sharedServiceProxy.isServiceAvailable) {
				await this.openVSLSRepository(folder);
			}
		});

		e.removed.forEach(async folder => {
			if (folder.uri.scheme === 'vsls' && this._sharedServiceProxy && this._sharedServiceProxy.isServiceAvailable) {
				await this.closeVSLSRepository(folder);
			}
		});
	}

	private async _refreshWorkspaces(available: boolean) {
		if (vscode.workspace.workspaceFolders) {
			vscode.workspace.workspaceFolders.forEach(async (folder) => {
				if (folder.uri.scheme === 'vsls') {
					if (available) {
						await this.openVSLSRepository(folder);
					} else {
						await this.closeVSLSRepository(folder);
					}
				}
			});
		}
	}

	public async openVSLSRepository(folder: vscode.WorkspaceFolder): Promise<void> {
		let existingRepository = this._model.getRepository(folder);
		if (existingRepository) {
			return;
		}
		const liveShareRepository = new LiveShareRepository(folder, this._sharedServiceProxy!);
		const repositoryProxyHandler = new LiveShareRepositoryProxyHandler();
		const repository = new Proxy(liveShareRepository, repositoryProxyHandler);
		await repository.initialize();
		this._model.openRepository(repository);
	}

	public async closeVSLSRepository(folder: vscode.WorkspaceFolder): Promise<void> {
		let existingRepository = this._model.getRepository(folder);
		if (!existingRepository) {
			return;
		}

		this._model.closeRepository(existingRepository);
	}

	public dispose() {
		this._sharedServiceProxy = undefined;
		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}
}

class LiveShareRepositoryProxyHandler {
	constructor() { }

	get (obj: any, prop: any) {
		if (prop in obj) {
			return obj[prop];
		}

		return function () {
			return obj.proxy.request(VSLS_REQUEST_NAME, [prop, obj.workspaceFolder.uri.toString(), ...arguments]);
		};
	}
}

class LiveShareRepositoryState implements RepositoryState {
	HEAD: Branch | undefined;
	refs: Ref[];
	remotes: Remote[];
	submodules: Submodule[];
	rebaseCommit: Commit;
	mergeChanges: Change[];
	indexChanges: Change[];
	workingTreeChanges: Change[];
	_onDidChange = new vscode.EventEmitter<void>();
	onDidChange = this._onDidChange.event;

	constructor(state: RepositoryState) {
		this.HEAD = state.HEAD;
		this.remotes = state.remotes;
		this.refs = state.refs;
	}

	public update(state: RepositoryState) {
		this.HEAD = state.HEAD;
		this.remotes = state.remotes;
		this.refs = state.refs;

		this._onDidChange.fire();
	}
}

class LiveShareRepository {
	rootUri: vscode.Uri;
	state: LiveShareRepositoryState;

	constructor(
		public workspaceFolder: vscode.WorkspaceFolder,
		public proxy: SharedServiceProxy
	) { }

	public async initialize() {
		let result = await this.proxy.request(VSLS_REQUEST_NAME, [VSLS_REPOSITORY_INITIALIZATION_NAME, this.workspaceFolder.uri.toString()]);
		this.state = new LiveShareRepositoryState(result);
		this.rootUri = vscode.Uri.parse(result.rootUri);
		this.proxy.onNotify(VSLS_STATE_CHANGE_NOFITY_NAME, this._notifyHandler.bind(this));
	}

	private _notifyHandler(args: any) {
		this.state.update(args);
	}
}
