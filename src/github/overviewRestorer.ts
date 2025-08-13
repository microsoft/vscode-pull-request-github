/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { CredentialStore } from './credentials';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { GitHubRepository } from './githubRepository';
import { IssueOverviewPanel } from './issueOverview';
import { PullRequestOverviewPanel } from './pullRequestOverview';
import { RepositoriesManager } from './repositoriesManager';
import { PullRequest } from './views';

export class OverviewRestorer extends Disposable implements vscode.WebviewPanelSerializer {
	private static ID = 'OverviewRestorer';

	constructor(private readonly _repositoriesManager: RepositoriesManager,
		private readonly _telemetry: ITelemetry,
		private readonly _extensionUri: vscode.Uri,
		private readonly _credentialStore: CredentialStore
	) {
		super();
		this._register(vscode.window.registerWebviewPanelSerializer(IssueOverviewPanel.viewType, this));
		this._register(vscode.window.registerWebviewPanelSerializer(PullRequestOverviewPanel.viewType, this));
	}

	async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: PullRequest): Promise<void> {
		await this.waitForAuth();
		await this.waitForAnyGitHubRepos(this._repositoriesManager);

		if (!state || !state.number || this._repositoriesManager.folderManagers.length === 0) {
			webviewPanel.dispose();
			return;
		}

		let repo: GitHubRepository | undefined;
		let folderManager: FolderRepositoryManager | undefined;
		for (const manager of this._repositoriesManager.folderManagers) {
			const githubRepository = manager.findExistingGitHubRepository({ owner: state.owner, repositoryName: state.repo });
			if (githubRepository) {
				repo = githubRepository;
				folderManager = manager;
				break;
			}
		}

		if (!repo || !folderManager) {
			folderManager = this._repositoriesManager.folderManagers[0];
			repo = await folderManager.createGitHubRepositoryFromOwnerName(state.owner, state.repo);
		}

		if (state.isIssue) {
			const issueModel = await repo.getIssue(state.number, true);
			if (!issueModel) {
				webviewPanel.dispose();
				return;
			}
			return IssueOverviewPanel.createOrShow(this._telemetry, this._extensionUri, folderManager, issueModel, undefined, true, webviewPanel);
		} else {
			const pullRequestModel = await repo.getPullRequest(state.number, true);
			if (!pullRequestModel) {
				webviewPanel.dispose();
				return;
			}
			return PullRequestOverviewPanel.createOrShow(this._telemetry, this._extensionUri, folderManager, pullRequestModel, undefined, true, webviewPanel);
		}
	}

	protected async waitForAuth(): Promise<void> {
		if (this._credentialStore.isAnyAuthenticated()) {
			return;
		}
		return new Promise(resolve => this._credentialStore.onDidGetSession(() => resolve()));
	}

	protected async waitForAnyGitHubRepos(reposManager: RepositoriesManager): Promise<void> {
		// Check if any folder manager already has GitHub repositories
		if (reposManager.folderManagers.some(manager => manager.gitHubRepositories.length > 0)) {
			return;
		}

		Logger.appendLine('Waiting for GitHub repositories.', OverviewRestorer.ID);
		return new Promise(resolve => {
			const disposable = reposManager.onDidChangeAnyGitHubRepository(() => {
				Logger.appendLine('Found GitHub repositories.', OverviewRestorer.ID);
				disposable.dispose();
				resolve();
			});
		});
	}
}