/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Branch, Repository } from '../api/api';
import { GitErrorCodes } from '../api/api1';
import { Remote } from '../common/remote';
import {
	ASSIGN_WHEN_WORKING,
	ISSUE_BRANCH_TITLE,
	ISSUES_SETTINGS_NAMESPACE,
	USE_BRANCH_FOR_ISSUES,
	WORKING_ISSUE_FORMAT_SCM,
} from '../common/settingKeys';
import { FolderRepositoryManager, PullRequestDefaults } from '../github/folderRepositoryManager';
import { GithubItemStateEnum } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { variableSubstitution } from '../github/utils';
import { IssueState, StateManager } from './stateManager';

export class CurrentIssue {
	private repoChangeDisposable: vscode.Disposable | undefined;
	private _branchName: string | undefined;
	private user: string | undefined;
	private repo: Repository | undefined;
	private _repoDefaults: PullRequestDefaults | undefined;
	private _onDidChangeCurrentIssueState: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidChangeCurrentIssueState: vscode.Event<void> = this._onDidChangeCurrentIssueState.event;
	constructor(
		private issueModel: IssueModel,
		public readonly manager: FolderRepositoryManager,
		private stateManager: StateManager,
		remote?: Remote,
		private shouldPromptForBranch?: boolean,
	) {
		this.setRepo(remote ?? this.issueModel.githubRepository.remote);
	}

	private setRepo(repoRemote: Remote) {
		for (let i = 0; i < this.stateManager.gitAPI.repositories.length; i++) {
			const repo = this.stateManager.gitAPI.repositories[i];
			for (let j = 0; j < repo.state.remotes.length; j++) {
				const remote = repo.state.remotes[j];
				if (
					remote.name === repoRemote?.remoteName &&
					remote.fetchUrl
						?.toLowerCase()
						.search(`${repoRemote.owner.toLowerCase()}/${repoRemote.repositoryName.toLowerCase()}`) !== -1
				) {
					this.repo = repo;
					return;
				}
			}
		}
	}

	get branchName(): string | undefined {
		return this._branchName;
	}

	get repoDefaults(): PullRequestDefaults | undefined {
		return this._repoDefaults;
	}

	get issue(): IssueModel {
		return this.issueModel;
	}

	public async startWorking(silent: boolean = false): Promise<boolean> {
		try {
			this._repoDefaults = await this.manager.getPullRequestDefaults();
			if (await this.createIssueBranch(silent)) {
				await this.setCommitMessageAndGitEvent();
				this._onDidChangeCurrentIssueState.fire();
				const login = (await this.manager.getCurrentUser(this.issueModel.githubRepository)).login;
				if (
					vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE).get(ASSIGN_WHEN_WORKING) &&
					!this.issueModel.assignees?.find(value => value.login === login)
				) {
					// Check that we have a repo open for this issue and only try to assign in that case.
					if (this.manager.gitHubRepositories.find(
						r => r.remote.owner === this.issueModel.remote.owner && r.remote.repositoryName === this.issueModel.remote.repositoryName,
					)) {
						await this.manager.assignIssue(this.issueModel, login);
					}
					await this.stateManager.refresh();
				}
				return true;
			}
		} catch (e) {
			// leave repoDefaults undefined
			vscode.window.showErrorMessage(vscode.l10n.t('There is no remote. Can\'t start working on an issue.'));
		}
		return false;
	}

	public dispose() {
		this.repoChangeDisposable?.dispose();
	}

	public async stopWorking(checkoutDefaultBranch: boolean) {
		if (this.repo) {
			this.repo.inputBox.value = '';
		}
		if (this._repoDefaults && checkoutDefaultBranch) {
			try {
				await this.manager.repository.checkout(this._repoDefaults.base);
			} catch (e) {
				if (e.gitErrorCode === GitErrorCodes.DirtyWorkTree) {
					vscode.window.showErrorMessage(
						vscode.l10n.t('Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches'),
					);
				}
				throw e;
			}
		}
		this._onDidChangeCurrentIssueState.fire();
		this.dispose();
	}

	private getBasicBranchName(user: string): string {
		return `${user}/issue${this.issueModel.number}`;
	}

	private async getBranch(branch: string): Promise<Branch | undefined> {
		try {
			return await this.manager.repository.getBranch(branch);
		} catch (e) {
			// branch doesn't exist
		}
		return undefined;
	}

	private async createOrCheckoutBranch(branch: string): Promise<boolean> {
		try {
			if (await this.getBranch(branch)) {
				await this.manager.repository.checkout(branch);
			} else {
				await this.manager.repository.createBranch(branch, true);
			}
			return true;
		} catch (e) {
			if (e.message !== 'User aborted') {
				vscode.window.showErrorMessage(
					`Unable to checkout branch ${branch}. There may be file conflicts that prevent this branch change. Git error: ${e.error}`,
				);
			}
			return false;
		}
	}

	private async getUser(): Promise<string> {
		if (!this.user) {
			this.user = await this.issueModel.githubRepository.getAuthenticatedUser();
		}
		return this.user;
	}

	private async getBranchTitle(): Promise<string> {
		return (
			vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE).get<string>(ISSUE_BRANCH_TITLE) ??
			this.getBasicBranchName(await this.getUser())
		);
	}

	private validateBranchName(branch: string): string | undefined {
		const VALID_BRANCH_CHARACTERS = /[^ \\@\~\^\?\*\[]+/;
		const match = branch.match(VALID_BRANCH_CHARACTERS);
		if (match && match.length > 0 && match[0] !== branch) {
			return vscode.l10n.t('Branch name cannot contain a space or the following characters: \\@~^?*[');
		}
		return undefined;
	}

	private showBranchNameError(error: string) {
		const editSetting = `Edit Setting`;
		vscode.window.showErrorMessage(error, editSetting).then(result => {
			if (result === editSetting) {
				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					`${ISSUES_SETTINGS_NAMESPACE}.${ISSUE_BRANCH_TITLE}`,
				);
			}
		});
	}

	private async offerNewBranch(branch: Branch, branchNameConfig: string, branchNameMatch: RegExpMatchArray | null | undefined): Promise<string> {
		// Check if this branch has a merged PR associated with it.
		// If so, offer to create a new branch.
		const pr = await this.manager.getMatchingPullRequestMetadataFromGitHub(branch, branch.upstream?.remote, branch.upstream?.name);
		if (pr && (pr.model.state !== GithubItemStateEnum.Open)) {
			const mergedMessage = vscode.l10n.t('The pull request for {0} has been merged. Do you want to create a new branch?', branch.name ?? 'unknown branch');
			const closedMessage = vscode.l10n.t('The pull request for {0} has been closed. Do you want to create a new branch?', branch.name ?? 'unknown branch');
			const createBranch = vscode.l10n.t('Create New Branch');
			const createNew = await vscode.window.showInformationMessage(pr.model.state === GithubItemStateEnum.Merged ? mergedMessage : closedMessage,
				{
					modal: true
				}, createBranch);
			if (createNew === createBranch) {
				const number = (branchNameMatch?.length === 4 ? (Number(branchNameMatch[3]) + 1) : 1);
				return `${branchNameConfig}_${number}`;
			}
		}
		return branchNameConfig;
	}

	private async createIssueBranch(silent: boolean): Promise<boolean> {
		const createBranchConfig = this.shouldPromptForBranch
			? 'prompt'
			: vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE).get<string>(USE_BRANCH_FOR_ISSUES);
		if (createBranchConfig === 'off') {
			return true;
		}
		const state: IssueState = this.stateManager.getSavedIssueState(this.issueModel.number);
		this._branchName = this.shouldPromptForBranch ? undefined : state.branch;
		const branchNameConfig = await variableSubstitution(
			await this.getBranchTitle(),
			this.issue,
			undefined,
			await this.getUser(),
		);
		const branchNameMatch = this._branchName?.match(new RegExp('^(' + branchNameConfig + ')(_)?(\\d*)'));
		if ((createBranchConfig === 'on')) {
			const branch = await this.getBranch(this._branchName!);
			if (!branch) {
				if (!branchNameMatch) {
					this._branchName = branchNameConfig;
				}
			} else if (!silent) {
				this._branchName = await this.offerNewBranch(branch, branchNameConfig, branchNameMatch);
			}
		}
		if (!this._branchName) {
			this._branchName = await vscode.window.showInputBox({
				value: branchNameConfig,
				prompt: vscode.l10n.t('Enter the label for the new branch.'),
			});
		}
		if (!this._branchName) {
			// user has cancelled
			return false;
		}

		const validateBranchName = this.validateBranchName(this._branchName);
		if (validateBranchName) {
			this.showBranchNameError(validateBranchName);
			return false;
		}

		state.branch = this._branchName;
		await this.stateManager.setSavedIssueState(this.issueModel, state);
		if (!(await this.createOrCheckoutBranch(this._branchName))) {
			this._branchName = undefined;
			return false;
		}
		return true;
	}

	public async getCommitMessage(): Promise<string | undefined> {
		const configuration = vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE).get(WORKING_ISSUE_FORMAT_SCM);
		if (typeof configuration === 'string') {
			return variableSubstitution(configuration, this.issueModel, this._repoDefaults);
		}
		return undefined;
	}

	private async setCommitMessageAndGitEvent() {
		const message = await this.getCommitMessage();
		if (this.repo && message) {
			this.repo.inputBox.value = message;
		}
		return;
	}
}
