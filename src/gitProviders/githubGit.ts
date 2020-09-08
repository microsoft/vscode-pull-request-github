/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IGit, Repository, InputBox, RepositoryState, RepositoryUIState, Change, Branch, Ref, BranchQuery, Commit, LogOptions, CommitOptions, RefType } from '../api/api';
import { APIState } from '../typings/git';
import { CredentialStore, GitHub } from '../github/credentials';
import { OctokitResponse, ReposGetResponseData, ReposGetBranchResponseData } from '@octokit/types';
import { PullRequestGitHelper } from '../github/pullRequestGitHelper';

interface OctokitTreeResponse {
	tree: {
		path: string,
		mode: string,
		type: 'blob' | 'tree',
		size?: number,
		sha: string,
		url: string
	}[];
}

interface OctokitBlobResponse {
	content: string;
	encoding: 'base64';
	url: string;
	sha: string;
	size: number;
}

class GithubGitRepository implements Repository {
	inputBox: InputBox;
	state: RepositoryState;
	ui: RepositoryUIState;

	constructor(public rootUri: vscode.Uri,
		private _github: GitHub,
		private _owner: string,
		private _repo: string,
		_repository: OctokitResponse<ReposGetResponseData>,
		private _branch: OctokitResponse<ReposGetBranchResponseData>) {
		const remote = {
			name: 'origin',
			fetchUrl: _repository.data.git_url,
			isReadOnly: _branch.data.protected
		};
		this.state = {
			HEAD: {
				type: RefType.Head,
				commit: _branch.data.commit.sha,
				name: _branch.data.name,
				upstream: {
					name: remote.name,
					remote: remote.name
				}
			},
			indexChanges: [],
			mergeChanges: [],
			onDidChange: new vscode.EventEmitter<void>().event,
			rebaseCommit: undefined,
			refs: [],
			remotes: [remote],
			submodules: [],
			workingTreeChanges: []
		};
	}

	async getConfigs(): Promise<{ key: string; value: string; }[]> {
		return [];
	}
	async getConfig(key: string): Promise<string> {
		if (key === PullRequestGitHelper.getMetadataKeyForBranch(this._branch.data.name)) {
			const pulls = await this._github.octokit.pulls.list({ owner: this._owner, repo: this._repo, head: `${this._owner}:${this._branch.data.name}` });
			if (pulls.data.length > 0) {
				return `${this._owner}#${this._repo}#${pulls.data[0].number}`;
			}
		}
		return '';
	}
	async setConfig(key: string, value: string): Promise<string> {
		return '';
	}
	getGlobalConfig(key: string): Promise<string> {
		// Not used in extension
		throw new Error('Method not implemented.');
	}
	async getObjectDetails(treeish: string, path: string): Promise<{ mode: string; object: string; size: number; }> {
		path = vscode.Uri.file(path).fsPath;
		const treeResponse: OctokitTreeResponse = (await this.requestTrees(treeish)).data;
		for (const item of treeResponse.tree) {
			if (path) {
				if ((item.type === 'blob') && ((item.path === path) || vscode.Uri.joinPath(this.rootUri, item.path).fsPath === path)) {
					return { mode: item.type, object: item.sha, size: item.size ?? 0 };
				}
			} else if (item.type === 'tree') {
				return { mode: item.type, object: item.sha, size: 0 };
			}
		}
		throw new Error('treeish or path not found');
	}
	async detectObjectType(object: string): Promise<{ mimetype: string; encoding?: string | undefined; }> {
		// No API for detecting a blob type, so only text/plain currently supported.
		return { mimetype: 'text/plain' };
	}
	buffer(ref: string, path: string): Promise<Buffer> {
		// Currently only used when detectObjectType return something other than text/plain.
		throw new Error('Method not implemented.');
	}
	async show(ref: string, path: string): Promise<string> {
		try {
			const objectDetails = await this.getObjectDetails(ref, path);
			const blobResponse: OctokitBlobResponse = (await this.requestBlobs(objectDetails.object)).data;
			return Buffer.from(blobResponse.content, 'base64').toString();
		} catch (e) {
			throw new Error('treeish or path not found');
		}
	}
	async getCommit(ref: string): Promise<Commit> {
		const commit = await this._github.octokit.repos.getCommit({ owner: this._owner, repo: this._repo, ref });
		return {
			hash: commit.data.sha,
			parents: commit.data.parents.map(parent => {
				return parent.sha;
			}),
			message: commit.data.commit.message
		};
	}
	clean(paths: string[]): Promise<void> {
		// Not used in extension
		throw new Error('Method not implemented.');
	}
	apply(patch: string, reverse?: boolean | undefined): Promise<void> {
		throw new Error('Method not implemented.');
	}
	diff(cached?: boolean | undefined): Promise<string> {
		throw new Error('Method not implemented.');
	}
	diffWithHEAD(): Promise<Change[]>;
	diffWithHEAD(path: string): Promise<string>;
	diffWithHEAD(path?: any): any {
		if (path) {
			return '';
		}
		throw new Error('Method not implemented.');
	}
	diffWith(ref: string): Promise<Change[]>;
	diffWith(ref: string, path: string): Promise<string>;
	diffWith(ref: any, path?: any): any {
		// Not used in extension
		throw new Error('Method not implemented.');
	}
	diffIndexWithHEAD(): Promise<Change[]>;
	diffIndexWithHEAD(path: string): Promise<string>;
	diffIndexWithHEAD(path?: any): any {
		// Not used in extension
		throw new Error('Method not implemented.');
	}
	diffIndexWith(ref: string): Promise<Change[]>;
	diffIndexWith(ref: string, path: string): Promise<string>;
	diffIndexWith(ref: any, path?: any): any {
		// Not used in extension
		throw new Error('Method not implemented.');
	}
	diffBlobs(object1: string, object2: string): Promise<string> {
		throw new Error('Method not implemented.');
	}
	diffBetween(ref1: string, ref2: string): Promise<Change[]>;
	diffBetween(ref1: string, ref2: string, path: string): Promise<string>;
	diffBetween(ref1: any, ref2: any, path?: any): any {
		throw new Error('Method not implemented.');
	}
	hashObject(data: string): Promise<string> {
		throw new Error('Method not implemented.');
	}
	createBranch(name: string, checkout: boolean, ref?: string | undefined): Promise<void> {
		throw new Error('Method not implemented.');
	}
	deleteBranch(name: string, force?: boolean | undefined): Promise<void> {
		throw new Error('Method not implemented.');
	}
	async getBranch(name: string): Promise<Branch> {
		const branch = await this._github.octokit.repos.getBranch({ owner: this._owner, repo: this._repo, branch: name });
		return {
			type: RefType.Head,
			commit: branch.data.commit.sha,
			name,
			remote: this.state.remotes[0].name,
			upstream: {
				name: this.state.remotes[0].name,
				remote: branch.data._links.html
			}
		};
	}
	async getBranches(query: BranchQuery): Promise<Ref[]> {
		// There is no good way to accomplish this with the available API.
		return [];
	}
	setBranchUpstream(name: string, upstream: string): Promise<void> {
		throw new Error('Method not implemented.');
	}
	getMergeBase(ref1: string, ref2: string): Promise<string> {
		// Not used in extension
		throw new Error('Method not implemented.');
	}
	status(): Promise<void> {
		throw new Error('Method not implemented.');
	}
	checkout(treeish: string): Promise<void> {
		throw new Error('Method not implemented.');
	}
	addRemote(name: string, url: string): Promise<void> {
		throw new Error('Method not implemented.');
	}
	removeRemote(name: string): Promise<void> {
		throw new Error('Method not implemented.');
	}
	renameRemote(name: string, newName: string): Promise<void> {
		throw new Error('Method not implemented.');
	}
	async fetch(remote?: string | undefined, ref?: string | undefined, depth?: number | undefined): Promise<void> {
		// Fetch doesn't mean anything because we aren't paying attention to the file system.
	}
	pull(unshallow?: boolean | undefined): Promise<void> {
		throw new Error('Method not implemented.');
	}
	push(remoteName?: string | undefined, branchName?: string | undefined, setUpstream?: boolean | undefined): Promise<void> {
		throw new Error('Method not implemented.');
	}
	blame(path: string): Promise<string> {
		throw new Error('Method not implemented.');
	}
	async log(options?: LogOptions | undefined): Promise<Commit[]> {
		if (!options || !options.maxEntries || (options.maxEntries !== 1) || !options.path) {
			throw new Error('Log options are required with GitHub git provider.');
		}
		const branch = await this.getBranch(this._branch.data.name);
		if (branch.commit) {
			return [await this.getCommit(branch.commit)];
		}
		return [];
	}
	commit(message: string, opts?: CommitOptions | undefined): Promise<void> {
		throw new Error('Method not implemented.');
	}

	private async requestTrees(tree_sha: string): Promise<OctokitResponse<OctokitTreeResponse>> {
		return this._github.octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
			owner: this._owner,
			repo: this._repo,
			tree_sha: tree_sha
		});
	}

	private async requestBlobs(tree_sha: string): Promise<OctokitResponse<OctokitBlobResponse>> {
		return this._github.octokit.request('GET /repos/{owner}/{repo}/git/blobs/{tree_sha}', {
			owner: this._owner,
			repo: this._repo,
			tree_sha: tree_sha
		});
	}
}

export class GithubGitProvider implements IGit, vscode.Disposable {
	get repositories(): Repository[] {
		return Array.from(this._repositories.values());
	}

	get state(): APIState {
		return this._credentialStore.isAuthenticated() ? 'initialized' : 'uninitialized';
	}

	private _onDidOpenRepository = new vscode.EventEmitter<Repository>();
	readonly onDidOpenRepository: vscode.Event<Repository> = this._onDidOpenRepository.event;
	private _onDidCloseRepository = new vscode.EventEmitter<Repository>();
	readonly onDidCloseRepository: vscode.Event<Repository> = this._onDidCloseRepository.event;
	private _onDidChangeState = new vscode.EventEmitter<APIState>();
	readonly onDidChangeState: vscode.Event<APIState> = this._onDidChangeState.event;
	private _repositories: Map<string, Repository> = new Map();
	private _disposables: vscode.Disposable[];

	constructor(private _credentialStore: CredentialStore) {
		this._disposables = [];
		this.findRepos();
	}

	private async findRepos() {
		if (this._credentialStore.isAuthenticated()) {
			const folders = vscode.workspace.workspaceFolders ?? [];
			const hub = this._credentialStore.getHub();
			if (!hub) {
				return;
			}
			for (const folder of folders) {
				// If the scheme is codespace, then the authority will indicate the repository.
				if (folder.uri.scheme !== 'codespace') {
					continue;
				}
				const match = folder.uri.authority.match(/^([A-Za-z0-9_\.-]+)\+([A-Za-z0-9_\.-]+)(\+([A-Za-z0-9_\.-]+))?$/);
				if (!match || match.length !== 5) {
					continue;
				}
				const owner = match[1];
				const repo = match[2];
				let branch = match[3];

				const githubRepo = await hub.octokit.repos.get({ owner, repo });
				if (!githubRepo) {
					continue;
				}
				branch = branch ?? githubRepo.data.default_branch;
				const githubBranch = await hub.octokit.repos.getBranch({ owner, repo, branch });
				const openedRepository = new GithubGitRepository(folder.uri, hub, owner, repo, githubRepo, githubBranch);
				this._repositories.set(`${owner}/${repo}`, openedRepository);
				this._onDidOpenRepository.fire(openedRepository);
			}
			// If you can't test in codespaces, you can uncomment the following lines to test with a repo
			// and branch of your choice.
			// Repo should match the repo you actually have open if you don't want unexpected results.

			// const repo = await hub.octokit.repos.get({ owner: 'alexr00', repo: 'playground' });
			// const branch = await hub.octokit.repos.getBranch({ owner: 'alexr00', repo: 'playground', branch: 'testlowercase' });
			// const openedRepository = new GithubGitRepository(vscode.workspace.workspaceFolders![0].uri, hub, 'alexr00', 'playground', repo, branch);
			// this._repositories.set('alexr00/playground', openedRepository);
			// this._onDidOpenRepository.fire(openedRepository);
		}
	}

	dispose() {
		this._disposables.forEach(disposable => disposable.dispose());
	}
}
