/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FolderRepositoryManager, PullRequestDefaults } from '../github/folderRepositoryManager';
import { IssueModel } from '../github/issueModel';
import * as vscode from 'vscode';
import { ISSUES_CONFIGURATION, variableSubstitution, BRANCH_NAME_CONFIGURATION, BRANCH_CONFIGURATION, SCM_MESSAGE_CONFIGURATION, BRANCH_NAME_CONFIGURATION_DEPRECATED } from './util';
import { StateManager, IssueState } from './stateManager';
import { Remote } from '../common/remote';
import { Repository } from '../api/api';

export class CurrentIssue {
	private repoChangeDisposable: vscode.Disposable | undefined;
	private _branchName: string | undefined;
	private user: string | undefined;
	private repo: Repository | undefined;
	private _repoDefaults: PullRequestDefaults | undefined;
	private _onDidChangeCurrentIssueState: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public readonly onDidChangeCurrentIssueState: vscode.Event<void> = this._onDidChangeCurrentIssueState.event;
	constructor(private issueModel: IssueModel, public readonly manager: FolderRepositoryManager, private stateManager: StateManager, remote?: Remote, private shouldPromptForBranch?: boolean) {
		this.setRepo(remote ?? this.issueModel.githubRepository.remote);
	}

	private setRepo(repoRemote: Remote) {
		for (let i = 0; i < this.stateManager.gitAPI.repositories.length; i++) {
			const repo = this.stateManager.gitAPI.repositories[i];
			for (let j = 0; j < repo.state.remotes.length; j++) {
				const remote = repo.state.remotes[j];
				if (remote.name === repoRemote?.remoteName &&
					(remote.fetchUrl?.toLowerCase().search(`${repoRemote.owner.toLowerCase()}/${repoRemote.repositoryName.toLowerCase()}`) !== -1)) {
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

	public async startWorking(): Promise<boolean> {
		try {
			this._repoDefaults = await this.manager.getPullRequestDefaults();
			if (await this.createIssueBranch()) {
				await this.setCommitMessageAndGitEvent();
				this._onDidChangeCurrentIssueState.fire();
				const login = this.manager.getCurrentUser(this.issueModel).login;
				if (vscode.workspace.getConfiguration('githubIssues').get('assignWhenWorking') &&
					!this.issueModel.assignees?.find(value => value.login === login)) {
					await this.manager.assignIssue(this.issueModel, login);
					await this.stateManager.refresh();
				}
				return true;
			}
		} catch (e) {
			// leave repoDefaults undefined
			vscode.window.showErrorMessage('There is no remote. Can\'t start working on an issue.');
		}
		return false;
	}

	public dispose() {
		this.repoChangeDisposable?.dispose();
	}

	public async stopWorking() {
		if (this.repo) {
			this.repo.inputBox.value = '';
		}
		if (this._repoDefaults) {
			await this.manager.repository.checkout(this._repoDefaults.base);
		}
		this._onDidChangeCurrentIssueState.fire();
		this.dispose();
	}

	private getBasicBranchName(user: string): string {
		return `${user}/issue${this.issueModel.number}`;
	}

	private async branchExists(branch: string): Promise<boolean> {
		try {
			const repoBranch = await this.manager.repository.getBranch(branch);
			return !!repoBranch;
		} catch (e) {
			// branch doesn't exist
		}
		return false;
	}

	private async createOrCheckoutBranch(branch: string): Promise<boolean> {
		try {
			if (await this.branchExists(branch)) {
				await this.manager.repository.checkout(branch);
			} else {
				await this.manager.repository.createBranch(branch, true);
			}
			return true;
		} catch (e) {
			vscode.window.showErrorMessage(`Unable to checkout branch ${branch}. There may be file conflicts that prevent this branch change. Git error: ${e.error}`);
			return false;
		}
	}

	private async getUser(): Promise<string> {
		if (!this.user) {
			this.user = await this.issueModel.githubRepository.getAuthenticatedUser();
		}
		return this.user;
	}

	// TODO: #1972 Delete the deprecated setting
	private async ensureBranchTitleConfigMigrated(): Promise<string> {
		const configuration = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION);
		const deprecatedConfigInspect = configuration.inspect(BRANCH_NAME_CONFIGURATION_DEPRECATED);
		async function migrate(value: any, target: vscode.ConfigurationTarget) {
			await configuration.update(BRANCH_NAME_CONFIGURATION, value, target);
			await configuration.update(BRANCH_NAME_CONFIGURATION_DEPRECATED, undefined, target);
		}
		if (deprecatedConfigInspect?.globalValue) {
			await migrate(deprecatedConfigInspect.globalValue, vscode.ConfigurationTarget.Global);
		}
		if (deprecatedConfigInspect?.workspaceValue) {
			await migrate(deprecatedConfigInspect.workspaceValue, vscode.ConfigurationTarget.Workspace);
		}
		if (deprecatedConfigInspect?.workspaceFolderValue) {
			await migrate(deprecatedConfigInspect.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder);
		}
		return vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get<string>(BRANCH_NAME_CONFIGURATION) ?? this.getBasicBranchName(await this.getUser());
	}

	private validateBranchName(branch: string): string | undefined {
		const VALID_BRANCH_CHARACTERS = /[^ \\@\~\^\?\*\[]+/;
		const match = branch.match(VALID_BRANCH_CHARACTERS);
		if (match && match.length > 0 && match[0] !== branch) {
			return 'Branch name cannot contain a space or the following characters: \\@~^?*[';
		}
		return undefined;
	}

	private showBranchNameError(error: string) {
		const editSetting = `Edit Setting`;
		vscode.window.showErrorMessage(error, editSetting).then(result => {
			if (result === editSetting) {
				return vscode.commands.executeCommand('workbench.action.openSettings', `${ISSUES_CONFIGURATION}.${BRANCH_NAME_CONFIGURATION}`);
			}
		});
	}

	private async createIssueBranch(): Promise<boolean> {
		const createBranchConfig = this.shouldPromptForBranch ? 'prompt' : <string>vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(BRANCH_CONFIGURATION);
		if (createBranchConfig === 'off') {
			return true;
		}
		const state: IssueState = this.stateManager.getSavedIssueState(this.issueModel.number);
		this._branchName = this.shouldPromptForBranch ? undefined : state.branch;
		if (!this._branchName) {
			const branchNameConfig = await variableSubstitution(await this.ensureBranchTitleConfigMigrated(), this.issue, undefined, await this.getUser());
			if (createBranchConfig === 'on') {
				const validateBranchName = this.validateBranchName(branchNameConfig);
				if (validateBranchName) {
					this.showBranchNameError(validateBranchName);
					return false;
				}
				this._branchName = branchNameConfig;
			} else {
				this._branchName = await vscode.window.showInputBox({ value: branchNameConfig, prompt: 'Enter the label for the new branch.' });
			}
		}
		if (!this._branchName) {
			// user has cancelled
			return false;
		}

		state.branch = this._branchName;
		this.stateManager.setSavedIssueState(this.issueModel, state);
		if (!await this.createOrCheckoutBranch(this._branchName)) {
			this._branchName = undefined;
		}
		return true;
	}

	public async getCommitMessage(): Promise<string | undefined> {
		const configuration = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(SCM_MESSAGE_CONFIGURATION);
		if (typeof configuration === 'string') {
			return variableSubstitution(configuration, this.issueModel, this._repoDefaults);
		}
	}

	private async setCommitMessageAndGitEvent() {
		const message = await this.getCommitMessage();
		if (this.repo && message) {
			this.repo.inputBox.value = message;
		}
		return;
	}
}