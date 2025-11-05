/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitContentFileSystemProvider } from './gitContentProvider';
import { PullRequestChangesTreeDataProvider } from './prChangesTreeDataProvider';
import { PullRequestsTreeDataProvider } from './prsTreeDataProvider';
import { PrsTreeModel } from './prsTreeModel';
import { ReviewManager } from './reviewManager';
import { Repository } from '../api/api';
import { GitApiImpl, Status } from '../api/api1';
import { COPILOT_SWE_AGENT } from '../common/copilot';
import { Disposable } from '../common/lifecycle';
import * as PersistentState from '../common/persistentState';
import { ITelemetry } from '../common/telemetry';
import { Schemes } from '../common/uri';
import { formatError, isDescendant } from '../common/utils';
import { CopilotRemoteAgentManager } from '../github/copilotRemoteAgent';
import { CredentialStore } from '../github/credentials';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { NotificationsManager } from '../notifications/notificationsManager';

export class ReviewsManager extends Disposable {
	public static ID = 'Reviews';

	constructor(
		private _context: vscode.ExtensionContext,
		private _reposManager: RepositoriesManager,
		private _reviewManagers: ReviewManager[],
		private _prsTreeModel: PrsTreeModel,
		private _prsTreeDataProvider: PullRequestsTreeDataProvider,
		private _prFileChangesProvider: PullRequestChangesTreeDataProvider,
		private _telemetry: ITelemetry,
		private _credentialStore: CredentialStore,
		private _gitApi: GitApiImpl,
		private _copilotManager: CopilotRemoteAgentManager,
		private _notificationsManager: NotificationsManager,
	) {
		super();
		const gitContentProvider = new GitContentFileSystemProvider(_gitApi, _credentialStore, () => this._reviewManagers);
		gitContentProvider.registerTextDocumentContentFallback(this.provideTextDocumentContent.bind(this));
		this._register(vscode.workspace.registerFileSystemProvider(Schemes.Review, gitContentProvider, { isReadonly: true }));
		this.registerListeners();
		this._register(this._prsTreeDataProvider);
	}

	get reviewManagers(): ReviewManager[] {
		return this._reviewManagers;
	}

	private registerListeners(): void {
		this._register(vscode.workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration('githubPullRequests.showInSCM')) {
				if (this._prFileChangesProvider) {
					this._prFileChangesProvider.dispose();
					this._prFileChangesProvider = new PullRequestChangesTreeDataProvider(this._gitApi, this._reposManager);

					for (const reviewManager of this._reviewManagers) {
						reviewManager.updateState(true);
					}
				}

				this._prsTreeDataProvider.dispose();
				this._prsTreeDataProvider = this._register(new PullRequestsTreeDataProvider(this._prsTreeModel, this._telemetry, this._context, this._reposManager, this._copilotManager));
				this._prsTreeDataProvider.initialize(this._reviewManagers.map(manager => manager.reviewModel), this._notificationsManager);
			}
		}));
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string | undefined> {
		for (const reviewManager of this._reviewManagers) {
			if (isDescendant(reviewManager.repository.rootUri.fsPath, uri.fsPath)) {
				return reviewManager.provideTextDocumentContent(uri);
			}
		}
		return '';
	}

	public addReviewManager(reviewManager: ReviewManager) {
		// Try to insert in workspace folder order
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders) {
			const index = workspaceFolders.findIndex(
				folder => folder.uri.toString() === reviewManager.repository.rootUri.toString(),
			);
			if (index > -1) {
				const arrayEnd = this._reviewManagers.slice(index, this._reviewManagers.length);
				this._reviewManagers = this._reviewManagers.slice(0, index);
				this._reviewManagers.push(reviewManager);
				this._reviewManagers.push(...arrayEnd);
				return;
			}
		}
		this._reviewManagers.push(reviewManager);
	}

	public removeReviewManager(repo: Repository) {
		const reviewManagerIndex = this._reviewManagers.findIndex(
			manager => manager.repository.rootUri.toString() === repo.rootUri.toString(),
		);
		if (reviewManagerIndex >= 0) {
			const manager = this._reviewManagers[reviewManagerIndex];
			this._reviewManagers.splice(reviewManagerIndex);
			manager.dispose();
		}
	}

	async switchToPr(folderManager: FolderRepositoryManager, pullRequestModel: PullRequestModel, repository: Repository | undefined, isFromDescription: boolean) {
		// If we don't have a repository from the node, use the one from the folder manager
		const repositoryToCheck = repository || folderManager.repository;

		// Check for uncommitted changes before proceeding with checkout
		const shouldProceed = await handleUncommittedChanges(repositoryToCheck);
		if (!shouldProceed) {
			return; // User cancelled or there was an error handling changes
		}

		/* __GDPR__
			"pr.checkout" : {
				"fromDescriptionPage" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"isCopilot" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this._telemetry.sendTelemetryEvent('pr.checkout', { fromDescription: isFromDescription.toString(), isCopilot: (pullRequestModel.author.login === COPILOT_SWE_AGENT) ? 'true' : 'false' });

		return vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.SourceControl,
				title: vscode.l10n.t('Switching to Pull Request #{0}', pullRequestModel.number),
			},
			async () => {
				await ReviewManager.getReviewManagerForRepository(
					this._reviewManagers,
					pullRequestModel.githubRepository,
					repository
				)?.switch(pullRequestModel);
			});
	};
}


// Modal dialog options for handling uncommitted changes during PR checkout
const STASH_CHANGES = vscode.l10n.t('Stash changes');
const DISCARD_CHANGES = vscode.l10n.t('Discard changes');
const DONT_SHOW_AGAIN = vscode.l10n.t('Try to checkout anyway and don\'t show again');

// Constants for persistent state storage
const UNCOMMITTED_CHANGES_SCOPE = vscode.l10n.t('uncommitted changes warning');
const UNCOMMITTED_CHANGES_STORAGE_KEY = 'showWarning';

/**
 * Shows a modal dialog when there are uncommitted changes during PR checkout
 * @param repository The git repository with uncommitted changes
 * @returns Promise<boolean> true if user chose to proceed (after staging/discarding), false if cancelled
 */
async function handleUncommittedChanges(repository: Repository): Promise<boolean> {
	// Check if user has disabled the warning using persistent state
	if (PersistentState.fetch(UNCOMMITTED_CHANGES_SCOPE, UNCOMMITTED_CHANGES_STORAGE_KEY) === false) {
		return true; // User has disabled warnings, proceed without showing dialog
	}

	// Filter out untracked files as they typically don't conflict with PR checkout
	const trackedWorkingTreeChanges = repository.state.workingTreeChanges.filter(change => change.status !== Status.UNTRACKED);
	const hasTrackedWorkingTreeChanges = trackedWorkingTreeChanges.length > 0;
	const hasIndexChanges = repository.state.indexChanges.length > 0;

	if (!hasTrackedWorkingTreeChanges && !hasIndexChanges) {
		return true; // No tracked uncommitted changes, proceed
	}

	const modalResult = await vscode.window.showInformationMessage(
		vscode.l10n.t('You have uncommitted changes that might be overwritten by checking out this pull request.'),
		{
			modal: true,
			detail: vscode.l10n.t('Choose how to handle your uncommitted changes before checking out the pull request.'),
		},
		STASH_CHANGES,
		DISCARD_CHANGES,
		DONT_SHOW_AGAIN,
	);

	if (!modalResult) {
		return false; // User cancelled
	}

	if (modalResult === DONT_SHOW_AGAIN) {
		// Store preference to never show this dialog again using persistent state
		PersistentState.store(UNCOMMITTED_CHANGES_SCOPE, UNCOMMITTED_CHANGES_STORAGE_KEY, false);
		return true; // Proceed with checkout
	}

	try {
		if (modalResult === STASH_CHANGES) {
			// Stash all changes (working tree changes + any unstaged changes)
			const allChangedFiles = [
				...trackedWorkingTreeChanges.map(change => change.uri.fsPath),
				...repository.state.indexChanges.map(change => change.uri.fsPath),
			];
			if (allChangedFiles.length > 0) {
				await repository.add(allChangedFiles);
				await vscode.commands.executeCommand('git.stash', repository);
			}
		} else if (modalResult === DISCARD_CHANGES) {
			// Discard all tracked working tree changes
			const trackedWorkingTreeFiles = trackedWorkingTreeChanges.map(change => change.uri.fsPath);
			if (trackedWorkingTreeFiles.length > 0) {
				await repository.clean(trackedWorkingTreeFiles);
			}
		}
		return true; // Successfully handled changes, proceed with checkout
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to handle uncommitted changes: {0}', formatError(error)));
		return false;
	}
}

