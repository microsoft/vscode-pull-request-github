/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { PullRequestModel } from './pullRequestModel';
import { Repository } from '../api/api';
import { commands } from '../common/executeCommands';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';

const logId = 'Worktree';

/**
 * Checks out a pull request in a new git worktree.
 * @param telemetry Telemetry instance for tracking usage
 * @param folderManager The folder repository manager
 * @param pullRequestModel The pull request to checkout
 * @param repository Optional repository to use (if not provided, uses folderManager.repository)
 */
export async function checkoutPRInWorktree(
	telemetry: ITelemetry,
	folderManager: FolderRepositoryManager,
	pullRequestModel: PullRequestModel,
	repository: Repository | undefined
): Promise<void> {
	// Validate that the PR has a valid head branch
	if (!pullRequestModel.head) {
		vscode.window.showErrorMessage(vscode.l10n.t('Unable to checkout pull request: missing head branch information.'));
		return;
	}

	const prHead = pullRequestModel.head;
	const repositoryToUse = repository || folderManager.repository;

	/* __GDPR__
		"pr.checkoutInWorktree" : {}
	*/
	telemetry.sendTelemetryEvent('pr.checkoutInWorktree');

	// Prepare for operations
	const repoRootPath = repositoryToUse.rootUri.fsPath;
	const parentDir = path.dirname(repoRootPath);
	const defaultWorktreePath = path.join(parentDir, `pr-${pullRequestModel.number}`);
	const branchName = prHead.ref;
	const remoteName = pullRequestModel.remote.remoteName;

	// Ask user for worktree location first (not in progress)
	const worktreeUri = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(defaultWorktreePath),
		title: vscode.l10n.t('Select Worktree Location'),
		saveLabel: vscode.l10n.t('Create Worktree'),
	});

	if (!worktreeUri) {
		return; // User cancelled
	}

	const worktreePath = worktreeUri.fsPath;
	const trackedBranchName = `${remoteName}/${branchName}`;

	try {
		// Check if the createWorktree API is available
		if (!repositoryToUse.createWorktree) {
			throw new Error(vscode.l10n.t('Git worktree API is not available. Please update VS Code to the latest version.'));
		}

		// Start progress for fetch and worktree creation
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Creating worktree for Pull Request #{0}...', pullRequestModel.number),
			},
			async () => {
				// Fetch the PR branch first
				await repositoryToUse.fetch({ remote: remoteName, ref: branchName });

				// Check if the branch already exists locally
				let branchExists = false;
				try {
					await repositoryToUse.getBranch(branchName);
					branchExists = true;
				} catch {
					// Branch doesn't exist locally, we'll create it
					branchExists = false;
				}

				// Use the git extension's createWorktree API
				// If branch already exists, don't specify the branch parameter to avoid "branch already exists" error
				if (branchExists) {
					await repositoryToUse.createWorktree!({
						path: worktreePath,
						commitish: branchName
					});
				} else {
					await repositoryToUse.createWorktree!({
						path: worktreePath,
						commitish: trackedBranchName,
						branch: branchName
					});
				}
			}
		);

		// Ask user how they want to open the worktree (modal dialog)
		const openInNewWindow = vscode.l10n.t('New Window');
		const openInCurrentWindow = vscode.l10n.t('Current Window');
		const result = await vscode.window.showInformationMessage(
			vscode.l10n.t('Worktree created for Pull Request #{0}. How would you like to open it?', pullRequestModel.number),
			{ modal: true },
			openInNewWindow,
			openInCurrentWindow
		);

		if (result === openInNewWindow) {
			await commands.openFolder(worktreeUri, { forceNewWindow: true });
		} else if (result === openInCurrentWindow) {
			await commands.openFolder(worktreeUri, { forceNewWindow: false });
		}
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		Logger.error(`Failed to create worktree: ${errorMessage}`, logId);
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to create worktree: {0}', errorMessage));
	}
}
