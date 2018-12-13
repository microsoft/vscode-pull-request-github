/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
export { API, Repository, InputBox, RepositoryState, RepositoryUIState, Commit, Branch, Git, RefType, UpstreamRef, GitErrorCodes } from '../typings/git';
import { API, Repository, InputBox, RepositoryState, RepositoryUIState, Commit, Branch, Git, Ref, Remote, Submodule, Change } from '../typings/git';
import { getAPI as getLocalAPI } from './local';
import { LiveShare, SharedService, SharedServiceProxy } from 'vsls/vscode.js';
import { EXTENSION_ID } from '../constants';

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
	const liveShareApiVersion = '0.3.1013';
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
	private _openRepositories: LiveShareRepository[] = [];
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

		this._onDidCloseRepository.fire(repository);
	}

	private _onDidOpenGitRepository(repository: Repository) {
		this.repositories = this._gitApi.repositories;

		if (repository.rootUri.scheme === 'vsls') {

		}
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
		this._currentRole = session.role;
		if (session.role === 1 /* Role.Host */) {
			this._sharedService = await this._api.shareService(EXTENSION_ID);
			this._sharedService.onRequest('git', this._gitHandler.bind(this));
			return;
		}

		if (session.role === 2 /* Role.Guest */) {
			this._sharedServiceProxy = await this._api.getSharedService(`${EXTENSION_ID}.${EXTENSION_ID}`);
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
			if (type === 'state') {
				return {
					HEAD: localRepository.state.HEAD,
					remotes: localRepository.state.remotes,
					refs: localRepository.state.refs
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

		const repository = new LiveShareRepository(folder, this._sharedServiceProxy);
		await repository.initialize();
		this._openRepositories.push(repository);
		this._onDidOpenRepository.fire(repository);
	}

	getRepository(folder: vscode.WorkspaceFolder): LiveShareRepository {
		return this._openRepositories.filter(repository => repository.workspaceFolder === folder)[0];
	}

	dispose() {
		this._api = null;
		this._gitApi = null;
		this._currentRole = null;
		this._sharedService = null;
		this._sharedServiceProxy = null;
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
}
export class LiveShareRepository implements Repository {
	rootUri: vscode.Uri;
	inputBox: InputBox;
	state: RepositoryState;
	ui: RepositoryUIState;

	constructor(
		public workspaceFolder: vscode.WorkspaceFolder,
		private _proxy: SharedServiceProxy
	) { }

	async initialize() {
		let state = await this._proxy.request('git', ['state', this.workspaceFolder.uri.toString()]);
		this.state = new LiveShareRepositoryState(state);
	}

	getConfigs(): Promise<{ key: string; value: string; }[]> {
		return this._proxy.request('git', ['getConfigs', this.workspaceFolder.uri.toString()]);
	}
	getConfig(key: string): Promise<string> {
		return this._proxy.request('git', ['getConfig', this.workspaceFolder.uri.toString(), key]);
	}
	setConfig(key: string, value: string): Promise<string> {
		return this._proxy.request('git', ['setConfig', this.workspaceFolder.uri.toString(), key, value]);
	}
	getObjectDetails(treeish: string, path: string): Promise<{ mode: string; object: string; size: number; }> {
		return this._proxy.request('git', ['getObjectDetails', this.workspaceFolder.uri.toString(), treeish, path]);
	}
	detectObjectType(object: string): Promise<{ mimetype: string; encoding?: string; }> {
		return this._proxy.request('git', ['detectObjectType', this.workspaceFolder.uri.toString(), object]);
	}
	buffer(ref: string, path: string): Promise<Buffer> {
		return this._proxy.request('git', ['buffer', this.workspaceFolder.uri.toString(), ref, path]);
	}
	show(ref: string, path: string): Promise<string> {
		return this._proxy.request('git', ['show', this.workspaceFolder.uri.toString(), ref, path]);
	}
	getCommit(ref: string): Promise<Commit> {
		return this._proxy.request('git', ['getCommit', this.workspaceFolder.uri.toString(), ref]);
	}
	clean(paths: string[]): Promise<void> {
		return this._proxy.request('git', ['clean', this.workspaceFolder.uri.toString(), paths]);
	}
	apply(patch: string, reverse?: boolean): Promise<void> {
		return this._proxy.request('git', ['apply', this.workspaceFolder.uri.toString(), patch, reverse]);
	}
	diff(cached?: boolean): Promise<string> {
		return this._proxy.request('git', ['diff', this.workspaceFolder.uri.toString(), cached]);
	}
	diffWithHEAD(path: string): Promise<string> {
		return this._proxy.request('git', ['diffWithHEAD', this.workspaceFolder.uri.toString(), path]);
	}
	diffWith(ref: string, path: string): Promise<string> {
		return this._proxy.request('git', ['diffWith', this.workspaceFolder.uri.toString(), ref, path]);
	}
	diffIndexWithHEAD(path: string): Promise<string> {
		return this._proxy.request('git', ['diffIndexWithHEAD', this.workspaceFolder.uri.toString(), path]);
	}
	diffIndexWith(ref: string, path: string): Promise<string> {
		return this._proxy.request('git', ['diffIndexWith', this.workspaceFolder.uri.toString(), ref, path]);
	}
	diffBlobs(object1: string, object2: string): Promise<string> {
		return this._proxy.request('git', ['diffBlobs', this.workspaceFolder.uri.toString(), object1, object2]);
	}
	diffBetween(ref1: string, ref2: string, path: string): Promise<string> {
		return this._proxy.request('git', ['diffBetween', this.workspaceFolder.uri.toString(), ref1, ref2]);
	}
	hashObject(data: string): Promise<string> {
		return this._proxy.request('git', ['hashObject', this.workspaceFolder.uri.toString(), data]);
	}
	createBranch(name: string, checkout: boolean, ref?: string): Promise<void> {
		return this._proxy.request('git', ['createBranch', this.workspaceFolder.uri.toString(), name, checkout, ref]);
	}
	deleteBranch(name: string, force?: boolean): Promise<void> {
		return this._proxy.request('git', ['deleteBranch', this.workspaceFolder.uri.toString(), name, force]);
	}
	getBranch(name: string): Promise<Branch> {
		return this._proxy.request('git', ['getBranch', this.workspaceFolder.uri.toString(), name]);
	}
	setBranchUpstream(name: string, upstream: string): Promise<void> {
		return this._proxy.request('git', ['setBranchUpstream', this.workspaceFolder.uri.toString(), name, upstream]);
	}
	getMergeBase(ref1: string, ref2: string): Promise<string> {
		return this._proxy.request('git', ['getMergeBase', this.workspaceFolder.uri.toString(), ref1, ref2]);
	}
	status(): Promise<void> {
		return this._proxy.request('git', ['status', this.workspaceFolder.uri.toString()]);
	}
	checkout(treeish: string): Promise<void> {
		return this._proxy.request('git', ['checkout', this.workspaceFolder.uri.toString(), treeish]);
	}
	addRemote(name: string, url: string): Promise<void> {
		return this._proxy.request('git', ['addRemote', this.workspaceFolder.uri.toString(), name, url]);
	}
	removeRemote(name: string): Promise<void> {
		return this._proxy.request('git', ['removeRemote', this.workspaceFolder.uri.toString(), name]);
	}
	fetch(remote?: string, ref?: string): Promise<void> {
		return this._proxy.request('git', ['fetch', this.workspaceFolder.uri.toString(), remote, ref]);
	}
	pull(): Promise<void> {
		return this._proxy.request('git', ['pull', this.workspaceFolder.uri.toString()]);
	}
	push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void> {
		return this._proxy.request('git', ['push', this.workspaceFolder.uri.toString(), remoteName, branchName, setUpstream]);
	}
}

const api = new CommonGitAPI();

export function getAPI(): API {
	return api;
}