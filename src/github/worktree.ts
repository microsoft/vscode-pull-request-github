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
	const worktreeName = `pr-${pullRequestModel.number}`;
	// Match the default location convention used by VS Code's built-in `Git: Create Worktree...` command:
	// `<parentDir>/<repoBasename>.worktrees/<worktreeName>`.
	const defaultWorktreePath = path.join(parentDir, `${path.basename(repoRootPath)}.worktrees`, worktreeName);
	const branchName = prHead.ref;
	const remoteName = pullRequestModel.remote.remoteName;

	// Ask user for worktree location using a custom InputBox UI (matches the built-in
	// `Git: Create Worktree...` experience instead of showing the OS save dialog).
	const worktreePath = await promptForWorktreePath(repositoryToUse, worktreeName, defaultWorktreePath);
	if (!worktreePath) {
		return; // User cancelled
	}

	const worktreeUri = vscode.Uri.file(worktreePath);
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

/**
 * Prompts the user for a worktree path using an `InputBox` that mirrors VS Code's
 * built-in `Git: Create Worktree...` UI: the path is pre-filled and editable, the
 * worktree-name segment is pre-selected, and an inline folder-picker button lets
 * the user browse to a parent directory.
 *
 * @param repository The repository the worktree will be created from (used to detect
 * conflicts with existing worktrees).
 * @param worktreeName The default leaf folder name for the new worktree (e.g. `pr-123`).
 * @param defaultWorktreePath The default full path to suggest in the input box.
 * @returns The chosen absolute path, or `undefined` if the user cancelled.
 */
async function promptForWorktreePath(
	repository: Repository,
	worktreeName: string,
	defaultWorktreePath: string
): Promise<string | undefined> {
	const getValueSelection = (value: string): [number, number] | undefined => {
		if (!value || !worktreeName || !value.endsWith(worktreeName)) {
			return undefined;
		}
		const start = value.length - worktreeName.length;
		return [start, value.length];
	};

	const getValidationMessage = (value: string): vscode.InputBoxValidationMessage | undefined => {
		const normalized = path.normalize(value);
		const conflict = repository.state.worktrees?.find(w => path.normalize(w.path) === normalized);
		return conflict ? {
			message: vscode.l10n.t('A worktree already exists at "{0}".', value),
			severity: vscode.InputBoxValidationSeverity.Warning
		} : undefined;
	};

	const browseForParent = async (): Promise<string | undefined> => {
		const currentValue = inputBox.value;
		const defaultUri = currentValue
			? vscode.Uri.file(path.dirname(currentValue))
			: vscode.Uri.file(path.dirname(defaultWorktreePath));

		const uris = await vscode.window.showOpenDialog({
			defaultUri,
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: vscode.l10n.t('Select as Worktree Destination'),
		});

		if (!uris || uris.length === 0) {
			return undefined;
		}
		return path.join(uris[0].fsPath, worktreeName);
	};

	const disposables: vscode.Disposable[] = [];
	const inputBox = vscode.window.createInputBox();
	disposables.push(inputBox);

	inputBox.title = vscode.l10n.t('Create Worktree');
	inputBox.placeholder = vscode.l10n.t('Worktree path');
	inputBox.prompt = vscode.l10n.t('Please provide a worktree path');
	inputBox.value = defaultWorktreePath;
	inputBox.valueSelection = getValueSelection(inputBox.value);
	inputBox.validationMessage = getValidationMessage(inputBox.value);
	inputBox.ignoreFocusOut = true;
	inputBox.buttons = [
		{
			iconPath: new vscode.ThemeIcon('folder'),
			tooltip: vscode.l10n.t('Select Worktree Destination'),
			location: vscode.QuickInputButtonLocation.Inline
		}
	];

	try {
		inputBox.show();

		return await new Promise<string | undefined>((resolve) => {
			disposables.push(inputBox.onDidHide(() => resolve(undefined)));
			disposables.push(inputBox.onDidAccept(() => {
				if (!inputBox.value) {
					return;
				}
				resolve(inputBox.value);
				inputBox.hide();
			}));
			disposables.push(inputBox.onDidChangeValue(value => {
				inputBox.validationMessage = getValidationMessage(value);
			}));
			disposables.push(inputBox.onDidTriggerButton(async () => {
				const chosen = await browseForParent();
				if (chosen) {
					inputBox.value = chosen;
					inputBox.valueSelection = getValueSelection(inputBox.value);
					inputBox.validationMessage = getValidationMessage(inputBox.value);
				}
			}));
		});
	} finally {
		disposables.forEach(d => d.dispose());
	}
}
