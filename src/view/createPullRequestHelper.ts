/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { ITelemetry } from '../common/telemetry';
import { dispose } from '../common/utils';
import { CreatePullRequestViewProviderNew } from '../github/createPRViewProviderNew';
import { FolderRepositoryManager, PullRequestDefaults } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { CompareChanges } from './compareChangesTreeDataProvider';
import { CreatePullRequestDataModel } from './createPullRequestDataModel';

export class CreatePullRequestHelper implements vscode.Disposable {
	private _disposables: vscode.Disposable[] = [];
	private _createPRViewProvider: CreatePullRequestViewProviderNew | undefined;
	private _treeView: CompareChanges | undefined;
	private _postCreateCallback: ((pullRequestModel: PullRequestModel) => Promise<void>) | undefined;

	constructor() { }

	private registerListeners(repository: Repository, usingCurrentBranchAsCompare: boolean) {
		this._disposables.push(
			this._createPRViewProvider!.onDone(async createdPR => {
				if (createdPR) {
					await CreatePullRequestViewProviderNew.withProgress(async () => {
						return this._postCreateCallback?.(createdPR);
					});
				}
				this.dispose();
			}),
		);

		this._disposables.push(
			this._createPRViewProvider!.onDidChangeCompareBranch(compareBranch => {
				this._treeView?.updateCompareBranch(compareBranch);
			}),
		);

		this._disposables.push(
			this._createPRViewProvider!.onDidChangeCompareRemote(compareRemote => {
				if (this._treeView) {
					this._treeView.compareOwner = compareRemote.owner;
				}
			}),
		);

		this._disposables.push(
			this._createPRViewProvider!.onDidChangeBaseBranch(baseBranch => {
				this._treeView?.updateBaseBranch(baseBranch);
			}),
		);

		this._disposables.push(
			this._createPRViewProvider!.onDidChangeBaseRemote(remoteInfo => {
				this._treeView?.updateBaseOwner(remoteInfo.owner);
			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.addAssigneesToNewPr', _ => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProviderNew) {
					return this._createPRViewProvider.addAssignees();
				}
			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.addReviewersToNewPr', _ => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProviderNew) {
					return this._createPRViewProvider.addReviewers();
				}
			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.addLabelsToNewPr', _ => {
				return this._createPRViewProvider?.addLabels();
			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.addMilestoneToNewPr', _ => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProviderNew) {
					return this._createPRViewProvider.addMilestone();
				}
			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.addProjectsToNewPr', _ => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProviderNew) {
					return this._createPRViewProvider.addProjects();
				}
			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuCreate', () => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProviderNew) {
					this._createPRViewProvider.createFromCommand(false, false, undefined);
				}
			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuDraft', () => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProviderNew) {
					this._createPRViewProvider.createFromCommand(true, false, undefined);
				}
			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuMergeWhenReady', () => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProviderNew) {
					this._createPRViewProvider.createFromCommand(false, true, undefined, true);
				}
			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuMerge', () => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProviderNew) {
					this._createPRViewProvider.createFromCommand(false, true, 'merge');
				}
			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuSquash', () => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProviderNew) {
					this._createPRViewProvider.createFromCommand(false, true, 'squash');
				}
			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuRebase', () => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProviderNew) {
					this._createPRViewProvider.createFromCommand(false, true, 'rebase');
				}
			})
		);

		if (usingCurrentBranchAsCompare) {
			this._disposables.push(
				repository.state.onDidChange(_ => {
					if (this._createPRViewProvider && repository.state.HEAD) {
						this._createPRViewProvider.defaultCompareBranch = repository.state.HEAD;
						this._treeView?.updateCompareBranch();
					}
				}),
			);
		}
	}

	get isCreatingPullRequest() {
		return !!this._createPRViewProvider;
	}

	private async ensureDefaultsAreLocal(
		folderRepoManager: FolderRepositoryManager,
		defaults: PullRequestDefaults,
	): Promise<PullRequestDefaults> {
		if (
			!folderRepoManager.gitHubRepositories.some(
				repo => repo.remote.owner === defaults.owner && repo.remote.repositoryName === defaults.repo,
			)
		) {
			// There is an upstream/parent repo, but the remote for it does not exist in the current workspace. Fall back to using origin instead.
			const origin = await folderRepoManager.getOrigin();
			const metadata = await folderRepoManager.getMetadata(origin.remote.remoteName);
			return {
				owner: metadata.owner.login,
				repo: metadata.name,
				base: metadata.default_branch,
			};
		} else {
			return defaults;
		}
	}

	async create(
		telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		folderRepoManager: FolderRepositoryManager,
		compareBranch: string | undefined,
		callback: (pullRequestModel: PullRequestModel) => Promise<void>,
	) {
		this.reset();

		this._postCreateCallback = callback;
		await folderRepoManager.loginAndUpdate();
		vscode.commands.executeCommand('setContext', 'github:createPullRequest', true);

		const branch =
			((compareBranch ? await folderRepoManager.repository.getBranch(compareBranch) : undefined) ??
				folderRepoManager.repository.state.HEAD)!;

		if (!this._createPRViewProvider) {
			const pullRequestDefaults = await this.ensureDefaultsAreLocal(
				folderRepoManager,
				await folderRepoManager.getPullRequestDefaults(branch),
			);

			const compareOrigin = await folderRepoManager.getOrigin(branch);
			const model = new CreatePullRequestDataModel(folderRepoManager, pullRequestDefaults.owner, pullRequestDefaults.base, compareOrigin.remote.owner, branch.name!);
			this._createPRViewProvider = new CreatePullRequestViewProviderNew(
				telemetry,
				model,
				extensionUri,
				folderRepoManager,
				pullRequestDefaults,
				branch
			);

			this._treeView = new CompareChanges(
				folderRepoManager,
				model
			);

			this.registerListeners(folderRepoManager.repository, !compareBranch);

			this._disposables.push(
				vscode.window.registerWebviewViewProvider(
					this._createPRViewProvider.viewType,
					this._createPRViewProvider,
				),
			);
		}

		this._createPRViewProvider.show(branch);
	}

	private reset() {
		vscode.commands.executeCommand('setContext', 'github:createPullRequest', false);

		this._createPRViewProvider?.dispose();
		this._createPRViewProvider = undefined;

		this._treeView?.dispose();
		this._treeView = undefined;
		this._postCreateCallback = undefined;

		dispose(this._disposables);
	}

	dispose() {
		this.reset();
	}
}
