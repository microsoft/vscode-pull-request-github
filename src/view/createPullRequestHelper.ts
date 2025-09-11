/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { commands } from '../common/executeCommands';
import { addDisposable, Disposable, disposeAll } from '../common/lifecycle';
import { ITelemetry } from '../common/telemetry';
import { BaseCreatePullRequestViewProvider, BasePullRequestDataModel, CreatePullRequestViewProvider } from '../github/createPRViewProvider';
import { FolderRepositoryManager, PullRequestDefaults } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { RevertPullRequestViewProvider } from '../github/revertPRViewProvider';
import { CompareChanges } from './compareChangesTreeDataProvider';
import { CreatePullRequestDataModel } from './createPullRequestDataModel';

export class CreatePullRequestHelper extends Disposable {
	private _currentDisposables: vscode.Disposable[] = [];
	private _createPRViewProvider: BaseCreatePullRequestViewProvider | undefined;
	private _treeView: CompareChanges | undefined;
	private _postCreateCallback: ((pullRequestModel: PullRequestModel | undefined) => Promise<void>) | undefined;
	private _activeContext: string | undefined;

	constructor() {
		super();
	}

	private async _setActiveContext(value: boolean) {
		if (this._activeContext) {
			await commands.setContext(this._activeContext, value);
		}
	}

	private _registerListeners(repository: Repository, usingCurrentBranchAsCompare: boolean) {
		addDisposable(
			this._createPRViewProvider!.onDone(async createdPR => {
				await CreatePullRequestViewProvider.withProgress(async () => {
					return this._postCreateCallback?.(createdPR);
				});
				this.dispose();
			}),
			this._currentDisposables
		);

		addDisposable(
			vscode.commands.registerCommand('pr.addAssigneesToNewPr', _ => {
				return this._createPRViewProvider?.addAssignees();

			}),
			this._currentDisposables
		);

		addDisposable(
			vscode.commands.registerCommand('pr.addReviewersToNewPr', _ => {
				return this._createPRViewProvider?.addReviewers();
			}),
			this._currentDisposables
		);

		addDisposable(
			vscode.commands.registerCommand('pr.addLabelsToNewPr', _ => {
				return this._createPRViewProvider?.addLabels();
			}),
			this._currentDisposables
		);

		addDisposable(
			vscode.commands.registerCommand('pr.addMilestoneToNewPr', _ => {
				return this._createPRViewProvider?.addMilestone();

			}),
			this._currentDisposables
		);

		addDisposable(
			vscode.commands.registerCommand('pr.addProjectsToNewPr', _ => {
				return this._createPRViewProvider?.addProjects();

			}),
			this._currentDisposables
		);

		addDisposable(
			vscode.commands.registerCommand('pr.createPrMenuCreate', () => {
				this._createPRViewProvider?.createFromCommand(false, false, undefined);

			}),
			this._currentDisposables
		);
		addDisposable(
			vscode.commands.registerCommand('pr.createPrMenuDraft', () => {
				this._createPRViewProvider?.createFromCommand(true, false, undefined);

			}),
			this._currentDisposables
		);
		addDisposable(
			vscode.commands.registerCommand('pr.createPrMenuMergeWhenReady', () => {
				this._createPRViewProvider?.createFromCommand(false, true, undefined, true);

			}),
			this._currentDisposables
		);
		addDisposable(
			vscode.commands.registerCommand('pr.createPrMenuMerge', () => {
				this._createPRViewProvider?.createFromCommand(false, true, 'merge');

			}),
			this._currentDisposables
		);
		addDisposable(
			vscode.commands.registerCommand('pr.createPrMenuSquash', () => {
				this._createPRViewProvider?.createFromCommand(false, true, 'squash');
			}),
			this._currentDisposables
		);
		addDisposable(
			vscode.commands.registerCommand('pr.createPrMenuRebase', () => {
				this._createPRViewProvider?.createFromCommand(false, true, 'rebase');
			}),
			this._currentDisposables
		);
		addDisposable(
			vscode.commands.registerCommand('pr.preReview', () => {
				if (this._createPRViewProvider instanceof CreatePullRequestViewProvider) {
					this._createPRViewProvider.review();
				}
			}),
			this._currentDisposables
		);

		if (usingCurrentBranchAsCompare) {
			addDisposable(
				repository.state.onDidChange(_ => {
					if (this._createPRViewProvider && repository.state.HEAD && this._createPRViewProvider instanceof CreatePullRequestViewProvider) {
						this._createPRViewProvider.setDefaultCompareBranch(repository.state.HEAD);
					}
				}),
				this._currentDisposables
			);
		}
	}

	get isCreatingPullRequest() {
		return !!this._createPRViewProvider;
	}

	private async _ensureDefaultsAreLocal(
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
		const recreate = !this._createPRViewProvider || !(this._createPRViewProvider instanceof RevertPullRequestViewProvider);
		if (recreate) {
			this.reset();
		}

		this._postCreateCallback = callback;
		await folderRepoManager.loginAndUpdate();
		this._activeContext = 'github:revertPullRequest';
		this.setActiveContext(true);

		if (recreate) {
			this._createPRViewProvider?.dispose();
			const model: BasePullRequestDataModel = {
				baseOwner: pullRequestModel.remote.owner,
				repositoryName: pullRequestModel.remote.repositoryName
			};
			this._createPRViewProvider = addDisposable(new RevertPullRequestViewProvider(
				telemetry,
				model,
				extensionUri,
				folderRepoManager,
				{ base: pullRequestModel.base.name, owner: pullRequestModel.remote.owner, repo: pullRequestModel.remote.repositoryName },
				pullRequestModel
			), this._currentDisposables);

			this.registerListeners(folderRepoManager.repository, false);

			addDisposable(
				vscode.window.registerWebviewViewProvider(
					this._createPRViewProvider.viewType,
					this._createPRViewProvider,
				),
				this._currentDisposables
			);
		}

		this._createPRViewProvider!.show();
	}

	async create(
		telemetry: ITelemetry,
		extensionUri: vscode.Uri,
		folderRepoManager: FolderRepositoryManager,
		compareBranch: string | undefined,
		callback: (pullRequestModel: PullRequestModel | undefined) => Promise<void>,
	) {
		const recreate = !this._createPRViewProvider || !(this._createPRViewProvider instanceof CreatePullRequestViewProvider);
		if (recreate) {
			this.reset();
		}

		this._postCreateCallback = callback;
		await folderRepoManager.loginAndUpdate();
		this._activeContext = 'github:createPullRequest';
		this.setActiveContext(true);

		const branch =
			((compareBranch ? await folderRepoManager.repository.getBranch(compareBranch) : undefined) ??
				folderRepoManager.repository.state.HEAD?.name ? folderRepoManager.repository.state.HEAD : undefined);

		let createViewProvider: CreatePullRequestViewProvider;
		if (recreate) {
			this._createPRViewProvider?.dispose();
			const pullRequestDefaults = await this.ensureDefaultsAreLocal(
				folderRepoManager,
				await folderRepoManager.getPullRequestDefaults(branch),
			);

			const compareOrigin = await folderRepoManager.getOrigin(branch);
			const model = addDisposable(new CreatePullRequestDataModel(folderRepoManager, pullRequestDefaults.owner, pullRequestDefaults.base, compareOrigin.remote.owner, branch?.name ?? pullRequestDefaults.base, compareOrigin.remote.repositoryName), this._currentDisposables);
			createViewProvider = this._createPRViewProvider = new CreatePullRequestViewProvider(
				telemetry,
				model,
				extensionUri,
				folderRepoManager,
				pullRequestDefaults,
			);

			this._treeView = addDisposable(new CompareChanges(
				folderRepoManager,
				model
			), this._currentDisposables);

			this.registerListeners(folderRepoManager.repository, !compareBranch);

			addDisposable(
				vscode.window.registerWebviewViewProvider(
					this._createPRViewProvider.viewType,
					this._createPRViewProvider,
				),
				this._currentDisposables
			);
		} else {
			createViewProvider = this._createPRViewProvider as CreatePullRequestViewProvider;
		}

		createViewProvider.show(branch);
	}

	private _reset() {
		this.setActiveContext(false);
		disposeAll(this._currentDisposables);
		this._createPRViewProvider = undefined;
		this._treeView = undefined;
		this._postCreateCallback = undefined;
		this._activeContext = undefined;

	}

	override dispose() {
		this.reset();
		super.dispose();
	}
}
