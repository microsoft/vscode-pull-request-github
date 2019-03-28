/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri, Event, Disposable } from 'vscode';

export const enum RefType {
	Head,
	RemoteHead,
	Tag
}

export interface Ref {
	readonly type: RefType;
	readonly name?: string;
	readonly commit?: string;
	readonly remote?: string;
}

export interface UpstreamRef {
	readonly remote: string;
	readonly name: string;
}

export interface Branch extends Ref {
	readonly upstream?: UpstreamRef;
	readonly ahead?: number;
	readonly behind?: number;
}

export interface Commit {
	readonly hash: string;
	readonly message: string;
	readonly parents: string[];
}

export interface Submodule {
	readonly name: string;
	readonly path: string;
	readonly url: string;
}

export interface Remote {
	readonly name: string;
	readonly fetchUrl?: string;
	readonly pushUrl?: string;
	readonly isReadOnly: boolean;
}

export enum Status {
	INDEX_MODIFIED,
	INDEX_ADDED,
	INDEX_DELETED,
	INDEX_RENAMED,
	INDEX_COPIED,

	MODIFIED,
	DELETED,
	UNTRACKED,
	IGNORED,
	INTENT_TO_ADD,

	ADDED_BY_US,
	ADDED_BY_THEM,
	DELETED_BY_US,
	DELETED_BY_THEM,
	BOTH_ADDED,
	BOTH_DELETED,
	BOTH_MODIFIED
}

export interface Change {

	/**
	 * Returns either `originalUri` or `renameUri`, depending
	 * on whether this change is a rename change. When
	 * in doubt always use `uri` over the other two alternatives.
	 */
	readonly uri: Uri;
	readonly originalUri: Uri;
	readonly renameUri: Uri | undefined;
	readonly status: Status;
}

export interface RepositoryState {
	readonly HEAD: Branch | undefined;
	readonly refs: Ref[];
	readonly remotes: Remote[];
	readonly submodules: Submodule[];
	readonly rebaseCommit: Commit | undefined;

	readonly mergeChanges: Change[];
	readonly indexChanges: Change[];
	readonly workingTreeChanges: Change[];

	readonly onDidChange: Event<void>;
}

export interface RepositoryUIState {
	readonly selected: boolean;
	readonly onDidChange: Event<void>;
}

export interface Repository {

	readonly rootUri: Uri;
	readonly state: RepositoryState;
	readonly ui: RepositoryUIState;

	/**
	 * GH PR saves pull request related information to git config when users checkout a pull request.
	 * There are two mandatory config for a branch
	 * 1. `remote`, which refers to the related github repository
	 * 2. `github-pr-owner-number`, which refers to the related pull request
	 *
	 * There is one optional config for a remote
	 * 1. `github-pr-remote`, which indicates if the remote is created particularly for GH PR review. By default, GH PR won't load pull requests from remotes created by itself (`github-pr-remote=true`).
	 *
	 * Sample config:
	 * ```git
	 * [remote "pr"]
	 * url = https://github.com/pr/vscode-pull-request-github
	 * fetch = +refs/heads/*:refs/remotes/pr/*
	 * github-pr-remote = true
	 * [branch "fix-123"]
	 * remote = pr
	 * merge = refs/heads/fix-123
	 * github-pr-owner-number = "Microsoft#vscode-pull-request-github#123"
	 * ```
	 */
	getConfigs(): Promise<{ key: string; value: string; }[]>;

	/**
	 * Git providers are recommended to implement a minimal key value lookup for git config but you can only provide config for following keys to activate GH PR successfully
	 * 1. `branch.${branchName}.github-pr-owner-number`
	 * 2. `remote.${remoteName}.github-pr-remote`
	 * 3. `branch.${branchName}.remote`
	 */
	getConfig(key: string): Promise<string>;

	/**
	 * The counterpart of `getConfig`
	 */
	setConfig(key: string, value: string): Promise<string>;

	getObjectDetails(treeish: string, path: string): Promise<{ mode: string, object: string, size: number }>;
	show(ref: string, path: string): Promise<string>;
	getCommit(ref: string): Promise<Commit>;
	apply(patch: string, reverse?: boolean): Promise<void>;
	diff(cached?: boolean): Promise<string>;
	diffWith(ref: string, path: string): Promise<string>;
	diffBlobs(object1: string, object2: string): Promise<string>;
	diffBetween(ref1: string, ref2: string, path: string): Promise<string>;
	hashObject(data: string): Promise<string>;
	createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
	deleteBranch(name: string, force?: boolean): Promise<void>;
	getBranch(name: string): Promise<Branch>;
	setBranchUpstream(name: string, upstream: string): Promise<void>;
	status(): Promise<void>;
	checkout(treeish: string): Promise<void>;
	addRemote(name: string, url: string): Promise<void>;
	removeRemote(name: string): Promise<void>;
	fetch(remote?: string, ref?: string, depth?: number): Promise<void>;
	pull(unshallow?: boolean): Promise<void>;
	push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
	blame(path: string): Promise<string>;
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
	PatchDoesNotApply = 'PatchDoesNotApply'
}

export interface IGit extends Disposable {
	readonly repositories: Repository[];
	readonly onDidOpenRepository: Event<Repository>;
	readonly onDidCloseRepository: Event<Repository>;
}

export interface API {
	/**
	 * Register a [git provider](#IGit)
	 */
	registerGitProvider(provider: IGit): void;

	/**
	 * Returns the [git provider](#IGit) that contains a given uri.
	 *
	 * @param uri An uri.
	 * @return A git provider or `undefined`
	 */
	getGitProvider(uri: Uri): IGit | undefined;
}
