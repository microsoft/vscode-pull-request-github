/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CredentialStore } from './credentials';
import { Remote } from '../common/remote';
import { EventType } from '../common/timelineEvent';
import { GitHubRepository } from './githubRepository';
import { Repository, UpstreamRef } from '../api/api';
import { Protocol } from '../common/protocol';
import { IssueModel } from './issueModel';
import { FolderPullRequestManager } from './folderPullRequestManager';

export interface ItemsResponseResult<T> {
	items: T[];
	hasMorePages: boolean;
	hasUnsearchedRepositories: boolean;
}

export class NoGitHubReposError extends Error {
	constructor(public repository: Repository) {
		super();
	}

	get message() {
		return `${this.repository.rootUri.toString()} has no GitHub remotes`;
	}
}

export class DetachedHeadError extends Error {
	constructor(public repository: Repository) {
		super();
	}

	get message() {
		return `${this.repository.rootUri.toString()} has a detached HEAD (create a branch first)`;
	}
}

export class BadUpstreamError extends Error {
	constructor(
		public branchName: string,
		public upstreamRef: UpstreamRef,
		public problem: string) {
		super();
	}

	get message() {
		const { upstreamRef: { remote, name }, branchName, problem } = this;
		return `The upstream ref ${remote}/${name} for branch ${branchName} ${problem}.`;
	}
}

export const REMOTES_SETTING = 'remotes';

export const PRManagerStateContext: string = 'PRManagerStateContext';

export enum PRManagerState {
	Initializing = 'Initializing',
	NeedsAuthentication = 'NeedsAuthentication',
	RepositoriesLoaded = 'RepositoriesLoaded'
}

export interface PullRequestDefaults {
	owner: string;
	repo: string;
	base: string;
}

export const NO_MILESTONE: string = 'No Milestone';

export class PullRequestManager implements vscode.Disposable {
	static ID = 'PullRequestManager';

	private _subs: vscode.Disposable[];

	private _onDidChangeState = new vscode.EventEmitter<void>();
	readonly onDidChangeState: vscode.Event<void> = this._onDidChangeState.event;

	private _state: PRManagerState = PRManagerState.Initializing;

	constructor(
		public readonly folderManagers: FolderPullRequestManager[],
		private _credentialStore: CredentialStore,
	) {
		this._subs = [];
		vscode.commands.executeCommand('setContext', PRManagerStateContext, this._state);

		this._subs.push(...folderManagers.map(folderManager => {
			return folderManager.onDidLoadRepositories(state => this.state = state);
		}));
	}

	getManagerForIssueModel(issueModel: IssueModel | undefined): FolderPullRequestManager | undefined {
		if (issueModel === undefined) {
			return undefined;
		}
		for (const folderManager of this.folderManagers) {
			if (folderManager.gitHubRepositories.map(repo => repo.remote.url).includes(issueModel.remote.url)) {
				return folderManager;
			}
		}
		return undefined;
	}

	get state() {
		return this._state;
	}

	set state(state: PRManagerState) {
		const stateChange = state !== this._state;
		this._state = state;
		if (stateChange) {
			vscode.commands.executeCommand('setContext', PRManagerStateContext, state);
			this._onDidChangeState.fire();
		}
	}

	get credentialStore(): CredentialStore {
		return this._credentialStore;
	}

	async clearCredentialCache(): Promise<void> {
		await this._credentialStore.reset();
		this.state = PRManagerState.Initializing;
	}

	async authenticate(): Promise<boolean> {
		return !!(await this._credentialStore.login());
	}

	createGitHubRepository(remote: Remote, credentialStore: CredentialStore): GitHubRepository {
		return new GitHubRepository(remote, credentialStore);
	}

	createGitHubRepositoryFromOwnerName(owner: string, name: string): GitHubRepository {
		const uri = `https://github.com/${owner}/${name}`;
		return new GitHubRepository(new Remote(name, uri, new Protocol(uri)), this._credentialStore);
	}

	dispose() {
		this._subs.forEach(sub => sub.dispose());
	}
}

export function getEventType(text: string) {
	switch (text) {
		case 'committed':
			return EventType.Committed;
		case 'mentioned':
			return EventType.Mentioned;
		case 'subscribed':
			return EventType.Subscribed;
		case 'commented':
			return EventType.Commented;
		case 'reviewed':
			return EventType.Reviewed;
		default:
			return EventType.Other;
	}
}

export const titleAndBodyFrom = (message: string): { title: string, body: string } => {
	const idxLineBreak = message.indexOf('\n');
	return {
		title: idxLineBreak === -1
			? message
			: message.substr(0, idxLineBreak),

		body: idxLineBreak === -1
			? ''
			: message.slice(idxLineBreak + 1),
	};
};
