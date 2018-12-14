/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
export { API, Repository, InputBox, RepositoryState, RepositoryUIState, Commit, Branch, Git, RefType, UpstreamRef, GitErrorCodes } from '../typings/git';
import { API, Repository, RepositoryState, Commit, Branch, Git, Ref, Remote, Submodule, Change } from '../typings/git';
import { getAPI as getLocalAPI } from './local';
import { LiveShare, SharedService, SharedServiceProxy } from 'vsls/vscode.js';
import { EXTENSION_ID } from '../constants';

const VSLS_REQUEST_NAME = 'git';
const VSLS_GIT_PR_SESSION_NAME = 'ghpr';
const VSLS_REPOSITORY_INITIALIZATION_NAME = 'initialize';
const VSLS_STATE_CHANGE_NOFITY_NAME = 'statechange';
async function getApi() {
	const liveshareExtension = vscode.extensions.getExtension('ms-vsliveshare.vsliveshare');
	if (!liveshareExtension) {
		// The extension is not installed.
		return null;
	}
	const extensionApi = liveshareExtension.isActive ?
		liveshareExtension.exports : await liveshareExtension.activate();
	if (!extensionApi) {
		// The extensibility API is not enabled.
		return null;
	}
	const liveShareApiVersion = liveshareExtension.packageJSON.version;
	// Support deprecated function name to preserve compatibility with older versions of VSLS.
	if (!extensionApi.getApi) {
		return extensionApi.getApiAsync(liveShareApiVersion);
	}
	return extensionApi.getApi(liveShareApiVersion);
}

export class CommonGitAPI implements API, vscode.Disposable {
	git: Git;
	repositories: Repository[];
	private _onDidOpenRepository = new vscode.EventEmitter<Repository>();
	readonly onDidOpenRepository: vscode.Event<Repository> = this._onDidOpenRepository.event;
	private _onDidCloseRepository = new vscode.EventEmitter<Repository>();
	readonly onDidCloseRepository: vscode.Event<Repository> = this._onDidCloseRepository.event;
	private _api: LiveShare;
	private _openRepositories: Repository[] = [];
	private _currentRole: number; //Role;
	private _sharedService: SharedService;
	private _sharedServiceProxy: SharedServiceProxy;
	private _gitApi: API;

	constructor() {
		this._api = null;
		this._currentRole = null;
		this._sharedService = null;
		this._sharedServiceProxy = null;
		this._gitApi = getLocalAPI();
		this.repositories = this._gitApi.repositories;
		this._gitApi.onDidCloseRepository(this._onDidCloseGitRepository);
		this._gitApi.onDidOpenRepository(this._onDidOpenGitRepository);

		this.initilize();
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

	async initilize() {
		if (!this._api) {
			this._api = await getApi();
		}

		this._api.onDidChangeSession(e => this._onDidChangeSession(e.session), this);
		if (this._api.session) {
			this._onDidChangeSession(this._api.session);
		}
	}

	async _onDidChangeSession(session) {
		if (this._sharedService) {
			this._sharedService = null;
		}

		this._currentRole = session.role;
		if (session.role === 1 /* Role.Host */) {
			this._sharedService = await this._api.shareService(VSLS_GIT_PR_SESSION_NAME);
			this._sharedService.onRequest(VSLS_REQUEST_NAME, this._gitHandler.bind(this));
			return;
		}

		if (session.role === 2 /* Role.Guest */) {
			this._sharedServiceProxy = await this._api.getSharedService(VSLS_GIT_PR_SESSION_NAME);
			vscode.workspace.workspaceFolders.forEach(async folder => {
				if (folder.uri.scheme === 'vsls') {
					await this.openVSLSRepository(folder);
				}
			});
		}
	}

	private async _gitHandler(args: any[]) {
		let type = args[0];
		let workspaceFolderUri = args[1];
		let localWorkSpaceFolderUri = this._api.convertSharedUriToLocal(vscode.Uri.parse(workspaceFolderUri));
		let localRepository = this.repositories.filter(repository => repository.rootUri.toString() === localWorkSpaceFolderUri.toString())[0];

		if (localRepository) {
			let commandArgs = args.slice(2);
			if (type === VSLS_REPOSITORY_INITIALIZATION_NAME) {
				localRepository.state.onDidChange(e => {
					this._sharedService.notify(VSLS_STATE_CHANGE_NOFITY_NAME, {
						HEAD: localRepository.state.HEAD,
						remotes: localRepository.state.remotes,
						refs: localRepository.state.refs
					});
				});
				return {
					HEAD: localRepository.state.HEAD,
					remotes: localRepository.state.remotes,
					refs: localRepository.state.refs,
					rootUri: localRepository.rootUri.toString()
				};
			}
			if (localRepository[type]) {
				return localRepository[type](...commandArgs);
			}
		} else {
			return null;
		}
	}

	async openVSLSRepository(folder: vscode.WorkspaceFolder) {
		if (this.getRepository(folder)) {
			return;
		}

		const liveShareRepository = new LiveShareRepository(folder, this._sharedServiceProxy);
		const repositoryProxyHandler = new LiveShareRepositoryProxyHandler();
		const repository = new Proxy(liveShareRepository, repositoryProxyHandler);
		await repository.initialize();
		this._openRepositories.push(repository);
		this._onDidOpenRepository.fire(repository);
	}

	getRepository(folder: vscode.WorkspaceFolder): Repository {
		return this._openRepositories.filter(repository => (repository as any).workspaceFolder === folder)[0];
	}

	dispose() {
		this._api = null;
		this._gitApi = null;
		this._currentRole = null;
		this._sharedService = null;
		this._sharedServiceProxy = null;
	}
}

export class LiveShareRepositoryProxyHandler {
	constructor() { }

	get (obj, prop) {
		if (prop in obj) {
			return obj[prop];
		}

		return function () {
			return obj._proxy.request(VSLS_REQUEST_NAME, [prop, obj.workspaceFolder.uri.toString(), ...arguments]);
		};
	}
}

export class LiveShareRepositoryState implements RepositoryState {
	HEAD: Branch;
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

	update(state: RepositoryState) {
		this.HEAD = state.HEAD;
		this.remotes = state.remotes;
		this.refs = state.refs;

		this._onDidChange.fire();
	}
}

export class LiveShareRepository {
	rootUri: vscode.Uri;
	// inputBox: InputBox;
	state: LiveShareRepositoryState;
	// ui: RepositoryUIState;

	constructor(
		public workspaceFolder: vscode.WorkspaceFolder,
		private _proxy: SharedServiceProxy
	) { }

	async initialize() {
		let result = await this._proxy.request(VSLS_REQUEST_NAME, [VSLS_REPOSITORY_INITIALIZATION_NAME, this.workspaceFolder.uri.toString()]);
		this.state = new LiveShareRepositoryState(result);
		this.rootUri = vscode.Uri.parse(result.rootUri);
		this._proxy.onNotify(VSLS_STATE_CHANGE_NOFITY_NAME, this.notifyHandler.bind(this));
	}

	notifyHandler(args: any) {
		this.state.update(args);
	}
}

const api = new CommonGitAPI();

export function getAPI(): API {
	return api;
}