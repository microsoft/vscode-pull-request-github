/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import {
	DEFAULT_DELETION_METHOD,
	PR_SETTINGS_NAMESPACE,
	SELECT_LOCAL_BRANCH,
	SELECT_REMOTE,
} from '../common/settingKeys';
import { Schemes } from '../common/uri';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { PullRequestModel } from './pullRequestModel';

export namespace PullRequestView {
	export async function deleteBranch(folderRepositoryManager: FolderRepositoryManager, item: PullRequestModel): Promise<{ isReply: boolean, message: any }> {
		const branchInfo = await folderRepositoryManager.getBranchNameForPullRequest(item);
		const actions: (vscode.QuickPickItem & { type: 'upstream' | 'local' | 'remote' | 'suspend' })[] = [];
		const defaultBranch = await folderRepositoryManager.getPullRequestRepositoryDefaultBranch(item);

		if (item.isResolved()) {
			const branchHeadRef = item.head.ref;

			const isDefaultBranch = defaultBranch === item.head.ref;
			if (!isDefaultBranch && !item.isRemoteHeadDeleted) {
				actions.push({
					label: vscode.l10n.t('Delete remote branch {0}', `${item.remote.remoteName}/${branchHeadRef}`),
					description: `${item.remote.normalizedHost}/${item.remote.owner}/${item.remote.repositoryName}`,
					type: 'upstream',
					picked: true,
				});
			}
		}

		if (branchInfo) {
			const preferredLocalBranchDeletionMethod = vscode.workspace
				.getConfiguration(PR_SETTINGS_NAMESPACE)
				.get<boolean>(`${DEFAULT_DELETION_METHOD}.${SELECT_LOCAL_BRANCH}`);
			actions.push({
				label: vscode.l10n.t('Delete local branch {0}', branchInfo.branch),
				type: 'local',
				picked: !!preferredLocalBranchDeletionMethod,
			});

			const preferredRemoteDeletionMethod = vscode.workspace
				.getConfiguration(PR_SETTINGS_NAMESPACE)
				.get<boolean>(`${DEFAULT_DELETION_METHOD}.${SELECT_REMOTE}`);

			if (branchInfo.remote && branchInfo.createdForPullRequest && !branchInfo.remoteInUse) {
				actions.push({
					label: vscode.l10n.t('Delete remote {0}, which is no longer used by any other branch', branchInfo.remote),
					type: 'remote',
					picked: !!preferredRemoteDeletionMethod,
				});
			}
		}

		if (vscode.env.remoteName === 'codespaces') {
			actions.push({
				label: vscode.l10n.t('Suspend Codespace'),
				type: 'suspend'
			});
		}

		if (!actions.length) {
			vscode.window.showWarningMessage(
				vscode.l10n.t('There is no longer an upstream or local branch for Pull Request #{0}', item.number),
			);
			return {
				isReply: true,
				message: {
					cancelled: true
				}
			};
		}

		const selectedActions = await vscode.window.showQuickPick(actions, {
			canPickMany: true,
			ignoreFocusOut: true,
		});

		const deletedBranchTypes: string[] = [];

		if (selectedActions) {
			const isBranchActive = item.equals(folderRepositoryManager.activePullRequest);

			const promises = selectedActions.map(async action => {
				switch (action.type) {
					case 'upstream':
						await folderRepositoryManager.deleteBranch(item);
						deletedBranchTypes.push(action.type);
						await folderRepositoryManager.repository.fetch({ prune: true });
						// If we're in a remote repository, then we should checkout the default branch.
						if (folderRepositoryManager.repository.rootUri.scheme === Schemes.VscodeVfs) {
							await folderRepositoryManager.repository.checkout(defaultBranch);
						}
						return;
					case 'local':
						if (isBranchActive) {
							if (folderRepositoryManager.repository.state.workingTreeChanges.length) {
								const yes = vscode.l10n.t('Yes');
								const response = await vscode.window.showWarningMessage(
									vscode.l10n.t('Your local changes will be lost, do you want to continue?'),
									{ modal: true },
									yes,
								);
								if (response === yes) {
									await vscode.commands.executeCommand('git.cleanAll');
								} else {
									return;
								}
							}
							await folderRepositoryManager.repository.checkout(defaultBranch);
						}
						await folderRepositoryManager.repository.deleteBranch(branchInfo!.branch, true);
						return deletedBranchTypes.push(action.type);
					case 'remote':
						deletedBranchTypes.push(action.type);
						return folderRepositoryManager.repository.removeRemote(branchInfo!.remote!);
					case 'suspend':
						deletedBranchTypes.push(action.type);
						return vscode.commands.executeCommand('github.codespaces.disconnectSuspend');
				}
			});

			await Promise.all(promises);

			vscode.commands.executeCommand('pr.refreshList');

			return {
				isReply: false,
				message: {
					command: 'pr.deleteBranch',
					branchTypes: deletedBranchTypes
				}
			};
		} else {
			return {
				isReply: true,
				message: {
					cancelled: true
				}
			};
		}
	}
}