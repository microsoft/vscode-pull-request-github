/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PullRequestManager, PullRequestDefaults } from '../github/pullRequestManager';
import { IssueModel } from '../github/issueModel';
import * as vscode from 'vscode';
import { ISSUES_CONFIGURATION, variableSubstitution, BRANCH_NAME_CONFIGURATION, getIssueNumberLabel, BRANCH_CONFIGURATION, SCM_MESSAGE_CONFIGURATION } from './util';
import { Repository } from '../typings/git';
import { StateManager, IssueState } from './stateManager';

export class CurrentIssue {
	private statusBarItem: vscode.StatusBarItem | undefined;
	private repoChangeDisposable: vscode.Disposable | undefined;
	private _branchName: string | undefined;
	private user: string | undefined;
	private repo: Repository | undefined;
	private repoDefaults: PullRequestDefaults | undefined;
	constructor(private issueModel: IssueModel, private manager: PullRequestManager, private stateManager: StateManager, private shouldPromptForBranch?: boolean) {
		this.setRepo();
	}

	private setRepo() {
		for (let i = 0; i < this.stateManager.gitAPI.repositories.length; i++) {
			const repo = this.stateManager.gitAPI.repositories[i];
			for (let j = 0; j < repo.state.remotes.length; j++) {
				const remote = repo.state.remotes[j];
				if (remote.name === this.issueModel.githubRepository.remote.remoteName &&
					(remote.fetchUrl?.toLowerCase().search(`${this.issueModel.githubRepository.remote.owner.toLowerCase()}/${this.issueModel.githubRepository.remote.repositoryName.toLowerCase()}`) !== -1)) {
					this.repo = repo;
					return;
				}
			}
		}
	}

	get branchName(): string | undefined {
		return this._branchName;
	}

	get issue(): IssueModel {
		return this.issueModel;
	}

	public async startWorking() {
		try {
			this.repoDefaults = await this.manager.getPullRequestDefaults();
		} catch (e) {
			// leave repoDefaults undefined
			vscode.window.showErrorMessage('There is no remote. Can\'t start working on an issue.');
		}
		await this.createIssueBranch();
		await this.setCommitMessageAndGitEvent();
		this.setStatusBar();
	}

	public dispose() {
		this.statusBarItem?.hide();
		this.statusBarItem?.dispose();
		this.repoChangeDisposable?.dispose();
	}

	public async stopWorking() {
		if (this.repo) {
			this.repo.inputBox.value = '';
		}
		if (this.repoDefaults) {
			await this.manager.repository.checkout(this.repoDefaults.base);
		}
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

	private async createOrCheckoutBranch(branch: string): Promise<void> {
		if (await this.branchExists(branch)) {
			await this.manager.repository.checkout(branch);
		} else {
			await this.manager.repository.createBranch(branch, true);
		}
	}

	private async getUser(): Promise<string> {
		if (!this.user) {
			this.user = await this.issueModel.githubRepository.getAuthenticatedUser();
		}
		return this.user;
	}

	private async createIssueBranch(): Promise<void> {
		const createBranchConfig = this.shouldPromptForBranch ? 'prompt' : <string>vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(BRANCH_CONFIGURATION);
		if (createBranchConfig === 'off') {
			return;
		}
		const state: IssueState = this.stateManager.getSavedIssueState(this.issueModel.number);
		this._branchName = this.shouldPromptForBranch ? undefined : state.branch;
		if (!this._branchName) {
			if (createBranchConfig === 'on') {
				const branchNameConfig = <string>vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(BRANCH_NAME_CONFIGURATION);
				this._branchName = await variableSubstitution(branchNameConfig, this.issue, undefined, await this.getUser());
			} else {
				this._branchName = await vscode.window.showInputBox({ placeHolder: `issue${this.issueModel.number}`, prompt: 'Enter the label for the new branch.' });
			}
		}
		if (!this._branchName) {
			this._branchName = this.getBasicBranchName(await this.getUser());
		}

		state.branch = this._branchName;
		this.stateManager.setSavedIssueState(this.issueModel, state);
		try {
			await this.createOrCheckoutBranch(this._branchName);
		} catch (e) {
			const basicBranchName = this.getBasicBranchName(await this.getUser());
			if (this._branchName === basicBranchName) {
				vscode.window.showErrorMessage(`Unable to checkout branch ${this._branchName}. There may be file conflicts that prevent this branch change.`);
				this._branchName = undefined;
				return;
			}
			vscode.window.showErrorMessage(`Unable to create branch with name ${this._branchName}. Using ${basicBranchName} instead.`);
			this._branchName = basicBranchName;
			state.branch = this._branchName;
			this.stateManager.setSavedIssueState(this.issueModel, state);
			await this.createOrCheckoutBranch(this._branchName);
		}
	}

	public async getCommitMessage(): Promise<string | undefined> {
		const configuration = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(SCM_MESSAGE_CONFIGURATION);
		if (typeof configuration === 'string') {
			return variableSubstitution(configuration, this.issueModel, this.repoDefaults);
		}
	}

	private async setCommitMessageAndGitEvent() {
		const message = await this.getCommitMessage();
		if (this.repo && message) {
			this.repo.inputBox.value = message;
		}
		return;
	}

	private setStatusBar() {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
		this.statusBarItem.text = `$(issues) Issue ${getIssueNumberLabel(this.issueModel, this.repoDefaults)}`;
		this.statusBarItem.tooltip = this.issueModel.title;
		this.statusBarItem.command = 'issue.statusBar';
		this.statusBarItem.show();
	}
}