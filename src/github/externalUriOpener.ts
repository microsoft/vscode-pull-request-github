/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RemoteOnlyRepository } from '../api/remoteOnlyRepository';
import { Disposable } from '../common/lifecycle';
import { IThemeWatcher } from '../themeWatcher';
import { CredentialStore } from './credentials';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { IssueOverviewPanel } from './issueOverview';
import { PullRequestOverviewPanel } from './pullRequestOverview';
import { RepositoriesManager } from './repositoriesManager';
import { GitApiImpl } from '../api/api1';
import { getGitHubIssueOrPullRequestUriOpenerPriority, parseGitHubIssueOrPullRequestUri } from '../common/externalUri';
import { ITelemetry } from '../common/telemetry';
import { EXTENSION_ID } from '../constants';
import { CreatePullRequestHelper } from '../view/createPullRequestHelper';
import { ThemeData } from '../view/theme';

class GitHubIssueOrPullRequestExternalUriOpener extends Disposable implements vscode.ExternalUriOpener {
	private _remoteFolderRepositoryManager: FolderRepositoryManager | undefined;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _credentialStore: CredentialStore,
		private readonly _telemetry: ITelemetry,
	) {
		super();
		this._register(vscode.window.registerExternalUriOpener(`${EXTENSION_ID}.issueOrPullRequest`, this, {
			schemes: ['http', 'https'],
			label: vscode.l10n.t('Open GitHub Issue or Pull Request'),
		}));
	}

	canOpenExternalUri(uri: vscode.Uri): vscode.ExternalUriOpenerPriority {
		return getGitHubIssueOrPullRequestUriOpenerPriority(uri);
	}

	async openExternalUri(_resolvedUri: vscode.Uri, openContext: vscode.OpenExternalUriContext, token: vscode.CancellationToken): Promise<void> {
		const identity = parseGitHubIssueOrPullRequestUri(openContext.sourceUri);
		if (!identity || token.isCancellationRequested) {
			return;
		}

		const folderRepositoryManager = this.getFolderRepositoryManager(identity.owner, identity.repo);
		if (identity.kind === 'pullRequest') {
			const pullRequest = await folderRepositoryManager.resolvePullRequest(identity.owner, identity.repo, identity.number, true);
			if (token.isCancellationRequested) {
				return;
			}
			if (!pullRequest) {
				await vscode.window.showErrorMessage(vscode.l10n.t('Unable to find pull request #{0} in {1}/{2}.', identity.number, identity.owner, identity.repo));
				return;
			}
			await PullRequestOverviewPanel.createOrShow(
				this._telemetry,
				this._context.extensionUri,
				folderRepositoryManager,
				identity,
				pullRequest,
			);
		} else {
			const issue = await folderRepositoryManager.resolveIssue(identity.owner, identity.repo, identity.number, true, true);
			if (token.isCancellationRequested) {
				return;
			}
			if (!issue) {
				await vscode.window.showErrorMessage(vscode.l10n.t('Unable to find issue #{0} in {1}/{2}.', identity.number, identity.owner, identity.repo));
				return;
			}
			await IssueOverviewPanel.createOrShow(
				this._telemetry,
				this._context.extensionUri,
				folderRepositoryManager,
				identity,
				issue,
			);
		}
	}

	private getFolderRepositoryManager(owner: string, repo: string): FolderRepositoryManager {
		const existingManager = this._repositoriesManager.getManagerForRepository(owner, repo)
			?? this._repositoriesManager.folderManagers[0];
		if (existingManager) {
			return existingManager;
		}
		if (this._remoteFolderRepositoryManager) {
			return this._remoteFolderRepositoryManager;
		}

		const repository = this._register(new RemoteOnlyRepository());
		const git = this._register(new GitApiImpl(this._repositoriesManager));
		const createPullRequestHelper = this._register(new CreatePullRequestHelper());
		const onDidChangeTheme = this._register(new vscode.EventEmitter<ThemeData | undefined>());
		const themeWatcher: IThemeWatcher = {
			onDidChangeTheme: onDidChangeTheme.event,
			themeData: undefined,
		};
		this._remoteFolderRepositoryManager = this._register(new FolderRepositoryManager(
			-1,
			this._context,
			repository,
			this._telemetry,
			git,
			this._credentialStore,
			createPullRequestHelper,
			themeWatcher,
		));
		return this._remoteFolderRepositoryManager;
	}
}

export function registerGitHubIssueOrPullRequestExternalUriOpener(
	context: vscode.ExtensionContext,
	repositoriesManager: RepositoriesManager,
	credentialStore: CredentialStore,
	telemetry: ITelemetry,
): vscode.Disposable {
	return new GitHubIssueOrPullRequestExternalUriOpener(context, repositoriesManager, credentialStore, telemetry);
}
