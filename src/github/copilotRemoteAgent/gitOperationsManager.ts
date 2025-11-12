/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { adjectives, animals, colors, NumberDictionary, uniqueNamesGenerator } from '@joaomoreno/unique-names-generator';
import vscode from 'vscode';
import { Repository } from '../../api/api';
import Logger from '../../common/logger';
import { BRANCH_RANDOM_NAME_DICTIONARY, BRANCH_WHITESPACE_CHAR, GIT } from '../../common/settingKeys';
import { RepoInfo } from '../common';

export class GitOperationsManager {
	constructor(private loggerID: string) { }

	async commitAndPushChanges(repoInfo: RepoInfo) {
		const { repository, remote, baseRef } = repoInfo;
		const asyncBranch = await this.generateRandomBranchName(repository, 'copilot');

		try {
			await repository.createBranch(asyncBranch, true);
			const commitMessage = 'Checkpoint from VS Code for coding agent session';

			await this.performCommit(asyncBranch, repository, commitMessage);
			await repository.push(remote.remoteName, asyncBranch, true);
			this.showBranchSwitchNotification(repository, baseRef, asyncBranch);
			return asyncBranch; // This is the new head ref
		} catch (error) {
			await this.rollbackToOriginalBranch(repository, baseRef);
			Logger.error(`Failed to auto-commit and push pending changes: ${error}`, this.loggerID);
			throw new Error(vscode.l10n.t('Could not auto-push pending changes. Manually commit or stash your changes and try again. ({0})', error.message));
		}
	}

	private async performCommit(asyncBranch: string, repository: Repository, commitMessage: string): Promise<void> {
		try {
			await repository.commit(commitMessage, { all: true });

			if (repository.state.HEAD?.name !== asyncBranch || repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0) {
				throw new Error(vscode.l10n.t('Uncommitted changes still detected.'));
			}
		} catch (error) {
			// Fallback to interactive commit
			const commitSuccessful = await this.handleInteractiveCommit(repository);
			if (!commitSuccessful) {
				throw new Error(vscode.l10n.t('Exclude your uncommitted changes and try again.'));
			}
		}
	}

	private async handleInteractiveCommit(repository: Repository): Promise<boolean> {
		const COMMIT_YOUR_CHANGES = vscode.l10n.t('Commit your changes to continue coding agent session. Close integrated terminal to cancel.');

		return vscode.window.withProgress({
			title: COMMIT_YOUR_CHANGES,
			cancellable: true,
			location: vscode.ProgressLocation.Notification
		}, async (progress, token) => {
			return new Promise<boolean>((resolve) => {
				const startingCommit = repository.state.HEAD?.commit;
				const terminal = vscode.window.createTerminal({
					name: 'GitHub Coding Agent',
					cwd: repository.rootUri.fsPath,
					message: `\x1b[1m${COMMIT_YOUR_CHANGES}\x1b[0m`
				});

				terminal.show();

				let disposed = false;
				let timeoutId: NodeJS.Timeout;
				let stateListener: vscode.Disposable | undefined;
				let disposalListener: vscode.Disposable | undefined;
				let cancellationListener: vscode.Disposable | undefined;
				const cleanup = () => {
					if (disposed) return;
					disposed = true;
					clearTimeout(timeoutId);
					stateListener?.dispose();
					disposalListener?.dispose();
					cancellationListener?.dispose();
					terminal.dispose();
				};
				// Listen for cancellation if token is provided
				if (token) {
					cancellationListener = token.onCancellationRequested(() => {
						cleanup();
						resolve(false);
					});
				}

				// Listen for repository state changes
				stateListener = repository.state.onDidChange(() => {
					// Check if commit was successful (HEAD changed and no more staged changes)
					if (repository.state.HEAD?.commit !== startingCommit) {
						cleanup();
						resolve(true);
					}
				});
				// Set a timeout to avoid waiting forever
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(false);
				}, 5 * 60 * 1000); // 5 minutes timeout
				// Listen for terminal disposal (user closed it)
				disposalListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
					if (closedTerminal === terminal) {
						setTimeout(() => {
							if (!disposed) {
								cleanup();
								// Check one more time if commit happened just before terminal was closed
								resolve(repository.state.HEAD?.commit !== startingCommit);
							}
						}, 1000);
					}
				});
			});
		});
	}

	private showBranchSwitchNotification(repository: Repository, baseRef: string, newRef: string): void {
		if (repository.state.HEAD?.name !== baseRef) {
			const SWAP_BACK_TO_ORIGINAL_BRANCH = vscode.l10n.t(`Swap back to '{0}'`, baseRef);
			vscode.window.showInformationMessage(
				vscode.l10n.t(`Pending changes pushed to remote branch '{0}'.`, newRef),
				SWAP_BACK_TO_ORIGINAL_BRANCH,
			).then(async (selection) => {
				if (selection === SWAP_BACK_TO_ORIGINAL_BRANCH) {
					await repository.checkout(baseRef);
				}
			});
		}
	}

	private async rollbackToOriginalBranch(repository: Repository, baseRef: string): Promise<void> {
		if (repository.state.HEAD?.name !== baseRef) {
			try {
				await repository.checkout(baseRef);
			} catch (checkoutError) {
				Logger.error(`Failed to checkout back to original branch '${baseRef}': ${checkoutError}`, this.loggerID);
			}
		}
	}

	// Adapted from https://github.com/microsoft/vscode/blob/e35e3b4e057450ea3d90c724fae5e3e9619b96fe/extensions/git/src/commands.ts#L3007
	private async generateRandomBranchName(repository: Repository, prefix: string): Promise<string> {
		const config = vscode.workspace.getConfiguration(GIT);
		const branchWhitespaceChar = config.get<string>(BRANCH_WHITESPACE_CHAR);
		const branchRandomNameDictionary = config.get<string[]>(BRANCH_RANDOM_NAME_DICTIONARY);

		// Default to legacy behaviour if config mismatches core
		if (branchWhitespaceChar === undefined || branchRandomNameDictionary === undefined) {
			return `copilot/vscode${Date.now()}`;
		}

		const separator = branchWhitespaceChar;
		const dictionaries: string[][] = [];
		for (const dictionary of branchRandomNameDictionary) {
			if (dictionary.toLowerCase() === 'adjectives') {
				dictionaries.push(adjectives);
			}
			if (dictionary.toLowerCase() === 'animals') {
				dictionaries.push(animals);
			}
			if (dictionary.toLowerCase() === 'colors') {
				dictionaries.push(colors);
			}
			if (dictionary.toLowerCase() === 'numbers') {
				dictionaries.push(NumberDictionary.generate({ length: 3 }));
			}
		}

		if (dictionaries.length === 0) {
			return '';
		}

		// 5 attempts to generate a random branch name
		for (let index = 0; index < 5; index++) {
			const randomName = `${prefix}/${uniqueNamesGenerator({
				dictionaries,
				length: dictionaries.length,
				separator
			})}`;

			// Check for local ref conflict
			const refs = await repository.getRefs?.({ pattern: `refs/heads/${randomName}` });
			if (!refs || refs.length === 0) {
				return randomName;
			}
		}

		return '';
	}
}
