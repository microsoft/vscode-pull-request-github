/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
export { API, Repository, InputBox, RepositoryState, RepositoryUIState, Commit, Branch, Git, RefType, UpstreamRef, GitErrorCodes } from '../typings/git';
import { API, Repository, InputBox, RepositoryState, RepositoryUIState, Commit, Branch, Git } from '../typings/git';
import { getAPI as getLocalAPI } from './local';
import { getApi, LiveShare, SessionChangeEvent, Role, SharedService, SharedServiceProxy } from 'vsls/vscode';
import { EXTENSION_ID } from '../constants';

export class CommonGitAPI implements API, vscode.Disposable {
	git: Git;
	repositories: Repository[];
	private _onDidOpenRepository = new vscode.EventEmitter<Repository>();
	readonly onDidOpenRepository: vscode.Event<Repository> = this._onDidOpenRepository.event;
	private _onDidCloseRepository = new vscode.EventEmitter<Repository>();
	readonly onDidCloseRepository: vscode.Event<Repository> = this._onDidCloseRepository.event;
	private _api: LiveShare;
	private _openRepositories: LiveShareRepository[] = [];
	private _currentRole: Role;
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

		this._api.onDidChangeSession(e => this._onDidChangeSession, this);
	}

	async _onDidChangeSession(e: SessionChangeEvent) {
		this._currentRole = e.session.role;
		if (e.session.role === Role.Host) {
			this._sharedService = await this._api.shareService(EXTENSION_ID);
			this._sharedService.onRequest('git', this._gitHandler);
			return;
		}

		if (e.session.role === Role.Guest) {
			this._sharedServiceProxy = await this._api.getSharedService(EXTENSION_ID);
			vscode.workspace.workspaceFolders.forEach(folder => {
				if (folder.uri.scheme === 'vsls') {
					this.openVSLSRepository(folder);
				}
			});
		}
	}

	private async _gitHandler(args: any[]) {
		let type = args[0];
		let workspaceFolder = args[1] as vscode.WorkspaceFolder;
		let localWorkSpaceFolderUri = this._api.convertSharedUriToLocal(workspaceFolder.uri);
		let localRepository = this.repositories.filter(repository => repository.rootUri.toString() === localWorkSpaceFolderUri.toString())[0];

		if (localRepository) {
			let commandArgs = args.slice(2);
			if (localRepository[type]) {
				return localRepository[type](...commandArgs);
			}
		} else {
			return null;
		}
	}

	openVSLSRepository(folder: vscode.WorkspaceFolder) {
		if (this.getRepository(folder)) {
			return;
		}

		const repository = new LiveShareRepository(folder, this._sharedServiceProxy);
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

export class LiveShareRepository implements Repository {
	rootUri: vscode.Uri;
	inputBox: InputBox;
	state: RepositoryState;
	ui: RepositoryUIState;

	constructor(
		public workspaceFolder: vscode.WorkspaceFolder,
		private _proxy: SharedServiceProxy
	) { }

	getConfigs(): Promise<{ key: string; value: string; }[]> {
		return this._proxy.request('git', ['getConfigs', this.workspaceFolder]);
	}
	getConfig(key: string): Promise<string> {
		return this._proxy.request('git', ['getConfig', this.workspaceFolder, key]);
	}
	setConfig(key: string, value: string): Promise<string> {
		return this._proxy.request('git', ['setConfig', this.workspaceFolder, key, value]);
	}
	getObjectDetails(treeish: string, path: string): Promise<{ mode: string; object: string; size: number; }> {
		return this._proxy.request('git', ['getObjectDetails', this.workspaceFolder, treeish, path]);
	}
	detectObjectType(object: string): Promise<{ mimetype: string; encoding?: string; }> {
		return this._proxy.request('git', ['detectObjectType', this.workspaceFolder, object]);
	}
	buffer(ref: string, path: string): Promise<Buffer> {
		return this._proxy.request('git', ['buffer', this.workspaceFolder, ref, path]);
	}
	show(ref: string, path: string): Promise<string> {
		return this._proxy.request('git', ['show', this.workspaceFolder, ref, path]);
	}
	getCommit(ref: string): Promise<Commit> {
		return this._proxy.request('git', ['getCommit', this.workspaceFolder, ref]);
	}
	clean(paths: string[]): Promise<void> {
		return this._proxy.request('git', ['clean', this.workspaceFolder, paths]);
	}
	apply(patch: string, reverse?: boolean): Promise<void> {
		return this._proxy.request('git', ['apply', this.workspaceFolder, patch, reverse]);
	}
	diff(cached?: boolean): Promise<string> {
		return this._proxy.request('git', ['diff', this.workspaceFolder, cached]);
	}
	diffWithHEAD(path: string): Promise<string> {
		return this._proxy.request('git', ['diffWithHEAD', this.workspaceFolder, path]);
	}
	diffWith(ref: string, path: string): Promise<string> {
		return this._proxy.request('git', ['diffWith', this.workspaceFolder, ref, path]);
	}
	diffIndexWithHEAD(path: string): Promise<string> {
		return this._proxy.request('git', ['diffIndexWithHEAD', this.workspaceFolder, path]);
	}
	diffIndexWith(ref: string, path: string): Promise<string> {
		return this._proxy.request('git', ['diffIndexWith', this.workspaceFolder, ref, path]);
	}
	diffBlobs(object1: string, object2: string): Promise<string> {
		return this._proxy.request('git', ['diffBlobs', this.workspaceFolder, object1, object2]);
	}
	diffBetween(ref1: string, ref2: string, path: string): Promise<string> {
		return this._proxy.request('git', ['diffBetween', this.workspaceFolder, ref1, ref2]);
	}
	hashObject(data: string): Promise<string> {
		return this._proxy.request('git', ['hashObject', this.workspaceFolder, data]);
	}
	createBranch(name: string, checkout: boolean, ref?: string): Promise<void> {
		return this._proxy.request('git', ['createBranch', this.workspaceFolder, name, checkout, ref]);
	}
	deleteBranch(name: string, force?: boolean): Promise<void> {
		return this._proxy.request('git', ['deleteBranch', this.workspaceFolder, name, force]);
	}
	getBranch(name: string): Promise<Branch> {
		return this._proxy.request('git', ['getBranch', this.workspaceFolder, name]);
	}
	setBranchUpstream(name: string, upstream: string): Promise<void> {
		return this._proxy.request('git', ['setBranchUpstream', this.workspaceFolder, name, upstream]);
	}
	getMergeBase(ref1: string, ref2: string): Promise<string> {
		return this._proxy.request('git', ['getMergeBase', this.workspaceFolder, ref1, ref2]);
	}
	status(): Promise<void> {
		return this._proxy.request('git', ['status', this.workspaceFolder]);
	}
	checkout(treeish: string): Promise<void> {
		return this._proxy.request('git', ['checkout', this.workspaceFolder, treeish]);
	}
	addRemote(name: string, url: string): Promise<void> {
		return this._proxy.request('git', ['addRemote', this.workspaceFolder, name, url]);
	}
	removeRemote(name: string): Promise<void> {
		return this._proxy.request('git', ['removeRemote', this.workspaceFolder, name]);
	}
	fetch(remote?: string, ref?: string): Promise<void> {
		return this._proxy.request('git', ['fetch', this.workspaceFolder, remote, ref]);
	}
	pull(): Promise<void> {
		return this._proxy.request('git', ['pull', this.workspaceFolder]);
	}
	push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void> {
		return this._proxy.request('git', ['push', this.workspaceFolder, remoteName, branchName, setUpstream]);
	}
}

const api = new CommonGitAPI();

export function getAPI(): API {
	return api;
}