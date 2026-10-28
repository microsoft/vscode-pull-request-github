/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { PullRequestGitHelper } from './pullRequestGitHelper';
import { PullRequestModel } from './pullRequestModel';
import { Repository } from '../api/api';
import { commands } from '../common/executeCommands';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';

const logId = 'Worktree';

function getErrorMessages(e: unknown): { summary: string; details: string } {
	const stderr = e && typeof e === 'object' ? Reflect.get(e, 'stderr') : undefined;
	const details = typeof stderr === 'string' ? stderr.trim() : '';
	if (!details) {
		const message = e instanceof Error ? e.message : String(e);
		return { summary: message, details: message };
	}

	// Git also writes progress such as "Preparing worktree (new branch '...')" to stderr, so only summarize the error lines.
	const errorLines = details.split(/\r?\n/).map(line => line.trim()).filter(line => /^(?:fatal|error):/.test(line));
	return { summary: errorLines.length ? errorLines.join(' ') : details, details };
}

/**
 * Checks out a pull request in a new git worktree.
 * @param telemetry Telemetry instance for tracking usage
 * @param repository The repository to create the worktree from
 * @param pullRequestModel The pull request to checkout
 */
export async function checkoutPRInWorktree(
	telemetry: ITelemetry,
	repository: Repository,
	pullRequestModel: PullRequestModel,
): Promise<void> {
	// Validate that the PR has a valid head branch
	if (!pullRequestModel.head) {
		vscode.window.showErrorMessage(vscode.l10n.t('Unable to checkout pull request: missing head branch information.'));
		return;
	}

	const prHead = pullRequestModel.head;

	/* __GDPR__
		"pr.checkoutInWorktree" : {}
	*/
	telemetry.sendTelemetryEvent('pr.checkoutInWorktree');

	// Prepare for operations
	const repoRootPath = repository.rootUri.fsPath;
	const parentDir = path.dirname(repoRootPath);
	const repoFolderName = path.basename(repoRootPath);
	const defaultWorktreePath = path.join(parentDir, `${repoFolderName}.worktrees`, `pr-${pullRequestModel.number}`);
	const isFork = !prHead.repositoryCloneUrl.equals(pullRequestModel.remote.gitProtocol);

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

	try {
		// Check if the createWorktree API is available
		if (!repository.createWorktree) {
			throw new Error(vscode.l10n.t('Git worktree API is not available. Please update VS Code to the latest version.'));
		}

		// Start progress for fetch and worktree creation
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Creating worktree for Pull Request #{0}...', pullRequestModel.number),
			},
			async () => {
				const remoteName = isFork
					? await PullRequestGitHelper.createRemote(repository, pullRequestModel.remote, prHead.repositoryCloneUrl)
					: pullRequestModel.remote.remoteName;
				const branchName = isFork
					? await PullRequestGitHelper.calculateUniqueBranchNameForPR(repository, pullRequestModel)
					: prHead.ref;
				const trackedBranchName = `${remoteName}/${prHead.ref}`;

				// Fetch the PR branch first
				await repository.fetch({ remote: remoteName, ref: prHead.ref });

				// Fork PRs always get a new unique branch name, so only same-repository PRs can reuse a local branch
				let branchExists = false;
				if (!isFork) {
					try {
						await repository.getBranch(branchName);
						branchExists = true;
					} catch {
						// Branch doesn't exist locally, we'll create it
					}
				}

				// Use the git extension's createWorktree API
				// If branch already exists, don't specify the branch parameter to avoid "branch already exists" error
				if (branchExists) {
					await repository.createWorktree!({
						path: worktreePath,
						commitish: branchName
					});
				} else {
					await repository.createWorktree!({
						path: worktreePath,
						commitish: trackedBranchName,
						branch: branchName
					});
				}

				// Branch config is shared by all worktrees, so this links the worktree's branch to the PR
				await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequestModel, branchName);
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
		const { summary, details } = getErrorMessages(e);
		Logger.error(`Failed to create worktree: ${details}`, logId);
		vscode.window.showErrorMessage(vscode.l10n.t('Failed to create worktree: {0}', summary));
	}
}
