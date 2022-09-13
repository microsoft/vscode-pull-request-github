/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { Repository, UpstreamRef } from '../api/api';
import { ITelemetry } from '../common/telemetry';
import { EventType } from '../common/timelineEvent';
import { compareIgnoreCase } from '../common/utils';
import { AuthProvider, CredentialStore, SCOPES } from './credentials';
import { FolderRepositoryManager, ReposManagerState, ReposManagerStateContext } from './folderRepositoryManager';
import { IssueModel } from './issueModel';
import { findDotComAndEnterpriseRemotes, hasEnterpriseUri, setEnterpriseUri } from './utils';

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
	constructor(public branchName: string, public upstreamRef: UpstreamRef, public problem: string) {
		super();
	}

	get message() {
		const {
			upstreamRef: { remote, name },
			branchName,
			problem,
		} = this;
		return `The upstream ref ${remote}/${name} for branch ${branchName} ${problem}.`;
	}
}

export interface PullRequestDefaults {
	owner: string;
	repo: string;
	base: string;
}

export const NO_MILESTONE: string = 'No Milestone';

export class RepositoriesManager implements vscode.Disposable {
	static ID = 'RepositoriesManager';

	private _subs: vscode.Disposable[];

	private _onDidChangeState = new vscode.EventEmitter<void>();
	readonly onDidChangeState: vscode.Event<void> = this._onDidChangeState.event;

	private _onDidChangeFolderRepositories = new vscode.EventEmitter<void>();
	readonly onDidChangeFolderRepositories = this._onDidChangeFolderRepositories.event;

	private _onDidLoadAnyRepositories = new vscode.EventEmitter<void>();
	readonly onDidLoadAnyRepositories = this._onDidLoadAnyRepositories.event;

	private _state: ReposManagerState = ReposManagerState.Initializing;

	constructor(
		private _folderManagers: FolderRepositoryManager[],
		private _credentialStore: CredentialStore,
		private _telemetry: ITelemetry,
	) {
		this._subs = [];
		vscode.commands.executeCommand('setContext', ReposManagerStateContext, this._state);

		this._subs.push(
			..._folderManagers.map(folderManager => {
				return folderManager.onDidLoadRepositories(state => {
					this.state = state;
					this._onDidLoadAnyRepositories.fire();
				});
			}),
		);
	}

	get folderManagers(): FolderRepositoryManager[] {
		return this._folderManagers;
	}

	insertFolderManager(folderManager: FolderRepositoryManager) {
		this._subs.push(folderManager.onDidLoadRepositories(state => (this.state = state)));

		// Try to insert the new repository in workspace folder order
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders) {
			const index = workspaceFolders.findIndex(
				folder => folder.uri.toString() === folderManager.repository.rootUri.toString(),
			);
			if (index > -1) {
				const arrayEnd = this._folderManagers.slice(index, this._folderManagers.length);
				this._folderManagers = this._folderManagers.slice(0, index);
				this._folderManagers.push(folderManager);
				this._folderManagers.push(...arrayEnd);
				this._onDidChangeFolderRepositories.fire();
				return;
			}
		}
		this._folderManagers.push(folderManager);
		this._onDidChangeFolderRepositories.fire();
	}

	removeRepo(repo: Repository) {
		const existingFolderManagerIndex = this._folderManagers.findIndex(
			manager => manager.repository.rootUri.toString() === repo.rootUri.toString(),
		);
		if (existingFolderManagerIndex > -1) {
			const folderManager = this._folderManagers[existingFolderManagerIndex];
			this._folderManagers.splice(existingFolderManagerIndex);
			folderManager.dispose();
			this._onDidChangeFolderRepositories.fire();
		}
	}

	getManagerForIssueModel(issueModel: IssueModel | undefined): FolderRepositoryManager | undefined {
		if (issueModel === undefined) {
			return undefined;
		}
		const issueRemoteUrl = issueModel.remote.url.substring(
			0,
			issueModel.remote.url.length - path.extname(issueModel.remote.url).length,
		);
		for (const folderManager of this._folderManagers) {
			if (
				folderManager.gitHubRepositories
					.map(repo =>
						repo.remote.url.substring(0, repo.remote.url.length - path.extname(repo.remote.url).length),
					)
					.includes(issueRemoteUrl)
			) {
				return folderManager;
			}
		}
		return undefined;
	}

	getManagerForFile(uri: vscode.Uri): FolderRepositoryManager | undefined {
		if (uri.scheme === 'untitled') {
			return this._folderManagers[0];
		}

		for (const folderManager of this._folderManagers) {
			const managerPath = folderManager.repository.rootUri.path;
			const testUriRelativePath = uri.path.substring(
				managerPath.length > 1 ? managerPath.length + 1 : managerPath.length,
			);
			if (compareIgnoreCase(vscode.Uri.joinPath(folderManager.repository.rootUri, testUriRelativePath).path, uri.path) === 0) {
				return folderManager;
			}
		}
		return undefined;
	}

	get state() {
		return this._state;
	}

	set state(state: ReposManagerState) {
		const stateChange = state !== this._state;
		this._state = state;
		if (stateChange) {
			vscode.commands.executeCommand('setContext', ReposManagerStateContext, state);
			this._onDidChangeState.fire();
		}
	}

	get credentialStore(): CredentialStore {
		return this._credentialStore;
	}

	async clearCredentialCache(): Promise<void> {
		await this._credentialStore.reset();
		this.state = ReposManagerState.Initializing;
	}

	async authenticate(): Promise<boolean> {
		const { dotComRemotes, enterpriseRemotes } = await findDotComAndEnterpriseRemotes(this.folderManagers);

		// If we have no github.com remotes, but we do have github remotes, then we likely have github enterprise remotes.
		if (!hasEnterpriseUri() && (dotComRemotes.length === 0) && (enterpriseRemotes.length > 0)) {
			const promptResult = await vscode.window.showInformationMessage(`It looks like you might be using GitHub Enterprise. Would you like to set up GitHub Pull Requests and Issues to authenticate with the enterprise server ${enterpriseRemotes[0].url}?`, { modal: true }, 'Yes', 'No, use GitHub.com');
			if (promptResult === 'Yes') {
				await setEnterpriseUri(enterpriseRemotes[0].url);
				await vscode.window.showInformationMessage(`A PAT is needed to sign in with GitHub Enterprise. Sign in to your GitHub Enterprise instance in your browser and create a PAT before continuing. The PAT will need the following scopes: ${SCOPES.join(', ')}.`, { modal: true });
			} else if (promptResult === undefined) {
				return false;
			}
		}

		let githubEnterprise;
		if (hasEnterpriseUri() && (enterpriseRemotes.length > 0)) {
			githubEnterprise = await this._credentialStore.login(AuthProvider['github-enterprise']);
		}
		let github;
		if (!githubEnterprise) {
			github = await this._credentialStore.login(AuthProvider.github);
		}
		return !!github || !!githubEnterprise;
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
