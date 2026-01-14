/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RepoInfo } from './common';
import { CopilotApi, getCopilotApi } from './copilotApi';
import { CopilotPRWatcher } from './copilotPrWatcher';

import { CredentialStore } from './credentials';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GitHubRepository } from './githubRepository';
import { RepositoriesManager } from './repositoriesManager';
import { CopilotRemoteAgentConfig } from '../common/config';
import { COPILOT_CLOUD_AGENT, COPILOT_LOGINS } from '../common/copilot';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { GitHubRemote } from '../common/remote';
import { ITelemetry } from '../common/telemetry';
import { PrsTreeModel } from '../view/prsTreeModel';

const PREFERRED_GITHUB_CODING_AGENT_REMOTE_WORKSPACE_KEY = 'PREFERRED_GITHUB_CODING_AGENT_REMOTE';

export namespace SessionIdForPr {

	const prefix = 'pull-session-by-index';

	export function getResource(prNumber: number, sessionIndex: number): vscode.Uri {
		return vscode.Uri.from({
			scheme: COPILOT_CLOUD_AGENT, path: `/${prefix}-${prNumber}-${sessionIndex}`,
		});
	}

	export function parse(resource: vscode.Uri): { prNumber: number; sessionIndex: number } | undefined {
		const match = resource.path.match(new RegExp(`^/${prefix}-(\\d+)-(\\d+)$`));
		if (match) {
			return {
				prNumber: parseInt(match[1], 10),
				sessionIndex: parseInt(match[2], 10)
			};
		}
		return undefined;
	}
}

export class CopilotRemoteAgentManager extends Disposable {
	public static ID = 'CopilotRemoteAgentManager';
	private _isAssignable: boolean | undefined;

	constructor(
		private credentialStore: CredentialStore,
		public repositoriesManager: RepositoriesManager,
		private telemetry: ITelemetry,
		private context: vscode.ExtensionContext,
		private readonly prsTreeModel: PrsTreeModel,
	) {
		super();

		this._register(new CopilotPRWatcher(this.repositoriesManager, this.prsTreeModel));
	}
	private _copilotApiPromise: Promise<CopilotApi | undefined> | undefined;
	private get copilotApi(): Promise<CopilotApi | undefined> {
		if (!this._copilotApiPromise) {
			this._copilotApiPromise = this.initializeCopilotApi();
		}
		return this._copilotApiPromise;
	}

	private async initializeCopilotApi(): Promise<CopilotApi | undefined> {
		return await getCopilotApi(this.credentialStore, this.telemetry);
	}

	async isAssignable(): Promise<boolean> {
		const setCachedResult = (b: boolean) => {
			this._isAssignable = b;
			return b;
		};

		if (this._isAssignable !== undefined) {
			return this._isAssignable;
		}

		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			return setCachedResult(false);
		}

		const { fm } = repoInfo;

		try {
			// Ensure assignable users are loaded
			await fm.getAssignableUsers();
			const allAssignableUsers = fm.getAllAssignableUsers();

			if (!allAssignableUsers) {
				return setCachedResult(false);
			}
			return setCachedResult(allAssignableUsers.some(user => COPILOT_LOGINS.includes(user.login)));
		} catch (error) {
			// If there's an error fetching assignable users, assume not assignable
			return setCachedResult(false);
		}
	}

	async isAvailable(): Promise<boolean> {
		// Check if the manager is enabled, copilot API is available, and it's assignable
		if (!CopilotRemoteAgentConfig.getEnabled()) {
			return false;
		}

		if (!this.credentialStore.isAnyAuthenticated()) {
			// If not signed in, then we optimistically say it's available.
			return true;
		}

		const repoInfo = await this.repoInfo();
		if (!repoInfo) {
			return false;
		}

		const copilotApi = await this.copilotApi;
		if (!copilotApi) {
			return false;
		}

		return await this.isAssignable();
	}

	private firstFolderManager(): FolderRepositoryManager | undefined {
		if (!this.repositoriesManager.folderManagers.length) {
			return;
		}
		return this.repositoriesManager.folderManagers[0];
	}

	async repoInfo(fm?: FolderRepositoryManager): Promise<RepoInfo | undefined> {
		fm = fm || this.firstFolderManager();
		const repository = fm?.repository;
		const ghRepository = fm?.gitHubRepositories.find(repo => repo.remote instanceof GitHubRemote) as GitHubRepository | undefined;
		if (!fm || !repository || !ghRepository) {
			return;
		}
		const baseRef = repository.state.HEAD?.name; // TODO: Consider edge cases
		const preferredRemoteName = this.context.workspaceState.get(PREFERRED_GITHUB_CODING_AGENT_REMOTE_WORKSPACE_KEY);
		const ghRemotes = await fm.getGitHubRemotes();
		if (!ghRemotes || ghRemotes.length === 0) {
			return;
		}

		const remote =
			preferredRemoteName
				? ghRemotes.find(remote => remote.remoteName === preferredRemoteName) // Cached preferred value
				: (ghRemotes.find(remote => remote.remoteName === 'origin') || ghRemotes[0]); // Fallback to the first remote

		if (!remote) {
			Logger.error(`no valid remotes for coding agent`, CopilotRemoteAgentManager.ID);
			// Clear preference, something is wrong
			this.context.workspaceState.update(PREFERRED_GITHUB_CODING_AGENT_REMOTE_WORKSPACE_KEY, undefined);
			return;
		}

		// Extract repo data from target remote
		const { owner, repositoryName: repo } = remote;
		if (!owner || !repo || !baseRef || !repository) {
			return;
		}
		return { owner, repo, baseRef, remote, repository, ghRepository, fm };
	}

}