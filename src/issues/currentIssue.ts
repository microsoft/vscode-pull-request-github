/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PullRequestManager } from '../github/pullRequestManager';
import { IssueModel } from '../github/issueModel';
import * as vscode from 'vscode';
import { ISSUES_CONFIGURATION, variableSubstitution, BRANCH_CONFIGURATION } from './util';
import { API as GitAPI, GitExtension, Repository } from '../typings/git';
import { Branch } from '../api/api';
import { StateManager, IssueState } from './stateManager';

export class CurrentIssue {
	private statusBarItem: vscode.StatusBarItem | undefined;
	private repoChangeDisposable: vscode.Disposable | undefined;
	private _branchName: string | undefined;
	private repo: Repository | undefined;
	constructor(private issueModel: IssueModel, private manager: PullRequestManager, private stateManager: StateManager, private shouldPromptForBranch?: boolean) {
		this.setRepo();
	}

	private setRepo() {
		const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')!.exports;
		const git: GitAPI = gitExtension.getAPI(1);
		for (let i = 0; i < git.repositories.length; i++) {
			const repo = git.repositories[i];
			for (let j = 0; j < repo.state.remotes.length; j++) {
				const remote = repo.state.remotes[j];
				if (remote.name === this.issueModel.githubRepository.remote.remoteName &&
					(remote.fetchUrl?.toLowerCase().search(`${this.issueModel.githubRepository.remote.owner}/${this.issueModel.githubRepository.remote.repositoryName}`) !== -1)) {
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
		this.manager.repository.checkout((await this.manager.getPullRequestDefaults()).base);
		this.dispose();
	}

	private async createIssueBranch(): Promise<void> {
		const createBranchConfig = this.shouldPromptForBranch ? 'prompt' : <string | boolean>vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(BRANCH_CONFIGURATION);
		if (createBranchConfig === false) {
			return;
		}
		const state: IssueState = this.stateManager.getSavedIssueState(this.issueModel.number);
		this._branchName = this.shouldPromptForBranch ? undefined : state.branch;
		if (!this._branchName) {
			const user = await this.issueModel.githubRepository.getAuthenticatedUser();
			if (createBranchConfig === true) {
				this._branchName = `${user}/issue${this.issueModel.number}`;
			} else {
				switch (createBranchConfig) {
					case 'prompt': {
						this._branchName = await vscode.window.showInputBox({ placeHolder: `issue${this.issueModel.number}`, prompt: 'Enter the label for the new branch.' });
						break;
					}
					default: this._branchName = await variableSubstitution(createBranchConfig, this.issue, user); break;
				}
			}
		}
		if (!this._branchName) {
			this._branchName = `${await this.issueModel.githubRepository.getAuthenticatedUser()}/issue${this.issueModel.number}`;
		}
		let existingBranch: Branch | undefined;
		try {
			existingBranch = await this.manager.repository.getBranch(this._branchName);
		} catch (e) {
			// branch doesn't exist
		}
		state.branch = this._branchName;
		this.stateManager.setSavedIssueState(this.issueModel, state);
		if (existingBranch) {
			await this.manager.repository.checkout(this._branchName);
		} else {
			await this.manager.repository.createBranch(this._branchName, true);
		}
	}

	private async setCommitMessageAndGitEvent() {
		const configuration = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('workingIssueFormatScm');
		if (this.repo && typeof configuration === 'string') {
			this.repo.inputBox.value = await variableSubstitution(configuration, this.issueModel);
		}
		return;
	}

	private setStatusBar() {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
		this.statusBarItem.text = `Working on #${this.issueModel.number}`;
		this.statusBarItem.tooltip = this.issueModel.title;
		this.statusBarItem.command = 'issue.statusBar';
		this.statusBarItem.show();
	}
}