/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { ITelemetry } from '../common/telemetry';
import { dispose } from '../common/utils';
import { BaseCreatePullRequestViewProvider, BasePullRequestDataModel, CreatePullRequestViewProvider } from '../github/createPRViewProvider';
import { FolderRepositoryManager, PullRequestDefaults } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { RevertPullRequestViewProvider } from '../github/revertPRViewProvider';
import { CompareChanges } from './compareChangesTreeDataProvider';
import { CreatePullRequestDataModel } from './createPullRequestDataModel';

export class CreatePullRequestHelper implements vscode.Disposable {
	private _disposables: vscode.Disposable[] = [];
	private _createPRViewProvider: BaseCreatePullRequestViewProvider | undefined;
	private _treeView: CompareChanges | undefined;
	private _postCreateCallback: ((pullRequestModel: PullRequestModel | undefined) => Promise<void>) | undefined;
	private _activeContext: string | undefined;

	constructor() { }

	private async setActiveContext(value: boolean) {
		if (this._activeContext) {
			await vscode.commands.executeCommand('setContext', this._activeContext, value);
		}
	}

	private registerListeners(repository: Repository, usingCurrentBranchAsCompare: boolean) {
		this._disposables.push(
			this._createPRViewProvider!.onDone(async createdPR => {
				this.setActiveContext(false);
				await CreatePullRequestViewProvider.withProgress(async () => {
					return this._postCreateCallback?.(createdPR);
				});
				this.dispose();
			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.addAssigneesToNewPr', _ => {
				return this._createPRViewProvider?.addAssignees();

			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.addReviewersToNewPr', _ => {
				return this._createPRViewProvider?.addReviewers();
			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.addLabelsToNewPr', _ => {
				return this._createPRViewProvider?.addLabels();
			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.addMilestoneToNewPr', _ => {
				return this._createPRViewProvider?.addMilestone();

			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.addProjectsToNewPr', _ => {
				return this._createPRViewProvider?.addProjects();

			}),
		);

		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuCreate', () => {
				this._createPRViewProvider?.createFromCommand(false, false, undefined);

			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuDraft', () => {
				this._createPRViewProvider?.createFromCommand(true, false, undefined);

			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuMergeWhenReady', () => {
				this._createPRViewProvider?.createFromCommand(false, true, undefined, true);

			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuMerge', () => {
				this._createPRViewProvider?.createFromCommand(false, true, 'merge');

			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuSquash', () => {
				this._createPRViewProvider?.createFromCommand(false, true, 'squash');
			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('pr.createPrMenuRebase', () => {
				this._createPRViewProvider?.createFromCommand(false, true, 'rebase');
			})
		);
		this._disposables.push(
			vscode.commands.registerCommand('pr.preReview', () => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProvider) {
					this._createPRViewProvider.review();
				}
			})
		);

		if (usingCurrentBranchAsCompare) {
			this._disposables.push(
				repository.state.onDidChange(_ => {
					if (this._createPRViewProvider && repository.state.HEAD && this._createPRViewProvider instanceof CreatePullRequestViewProvider) {
						this._createPRViewProvider.setDefaultCompareBranch(repository.state.HEAD);
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

	async revert(
		telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		folderRepoManager: FolderRepositoryManager,
		pullRequestModel: PullRequestModel,
		callback: (pullRequest: PullRequestModel | undefined) => Promise<void>,
	) {
		this.reset();

		this._postCreateCallback = callback;
		await folderRepoManager.loginAndUpdate();
		this._activeContext = 'github:revertPullRequest';
		this.setActiveContext(true);

		if (!this._createPRViewProvider || !(this._createPRViewProvider instanceof RevertPullRequestViewProvider)) {
			this._createPRViewProvider?.dispose();
			const model: BasePullRequestDataModel = {
				baseOwner: pullRequestModel.remote.owner,
				repositoryName: pullRequestModel.remote.repositoryName
			};
			this._createPRViewProvider = new RevertPullRequestViewProvider(
				telemetry,
				model,
				extensionUri,
				folderRepoManager,
				{ base: pullRequestModel.base.name, owner: pullRequestModel.remote.owner, repo: pullRequestModel.remote.repositoryName },
				pullRequestModel
			);

			this.registerListeners(folderRepoManager.repository, false);

			this._disposables.push(
				vscode.window.registerWebviewViewProvider(
					this._createPRViewProvider.viewType,
					this._createPRViewProvider,
				),
			);
		}

		this._createPRViewProvider.show();
	}

	async create(
		telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		folderRepoManager: FolderRepositoryManager,
		compareBranch: string | undefined,
		callback: (pullRequestModel: PullRequestModel | undefined) => Promise<void>,
	) {
		this.reset();

		this._postCreateCallback = callback;
		await folderRepoManager.loginAndUpdate();
		this._activeContext = 'github:createPullRequest';
		this.setActiveContext(true);

		const branch =
			((compareBranch ? await folderRepoManager.repository.getBranch(compareBranch) : undefined) ??
				folderRepoManager.repository.state.HEAD?.name ? folderRepoManager.repository.state.HEAD : undefined);

		let createViewProvider: CreatePullRequestViewProvider;
		if (!this._createPRViewProvider || !(this._createPRViewProvider instanceof CreatePullRequestViewProvider)) {
			this._createPRViewProvider?.dispose();
			const pullRequestDefaults = await this.ensureDefaultsAreLocal(
				folderRepoManager,
				await folderRepoManager.getPullRequestDefaults(branch),
			);

			const compareOrigin = await folderRepoManager.getOrigin(branch);
			const model = new CreatePullRequestDataModel(folderRepoManager, pullRequestDefaults.owner, pullRequestDefaults.base, compareOrigin.remote.owner, branch?.name ?? pullRequestDefaults.base, compareOrigin.remote.repositoryName);
			createViewProvider = this._createPRViewProvider = new CreatePullRequestViewProvider(
				telemetry,
				model,
				extensionUri,
				folderRepoManager,
				pullRequestDefaults,
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
		} else {
			createViewProvider = this._createPRViewProvider;
		}

		createViewProvider.show(branch);
	}

	private reset() {
		this.setActiveContext(false);
		this._createPRViewProvider?.dispose();
		this._createPRViewProvider = undefined;

		this._treeView?.dispose();
		this._treeView = undefined;
		this._postCreateCallback = undefined;
		this._activeContext = undefined;

		dispose(this._disposables);
	}

	dispose() {
		this.reset();
	}
}
