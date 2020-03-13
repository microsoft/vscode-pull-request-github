/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PullRequestManager } from '../github/pullRequestManager';
import { IssueModel } from '../github/issueModel';
import * as vscode from 'vscode';
import { ISSUES_CONFIGURATION, variableSubstitution } from './util';
import { API as GitAPI, GitExtension } from '../typings/git';
import { Branch } from '../api/api'
import { StateManager, IssueState } from './stateManager';

export class CurrentIssue {
	private statusBarItem: vscode.StatusBarItem | undefined;
	private repoChangeDisposable: vscode.Disposable | undefined;
	private repo: any;
	constructor(private issueModel: IssueModel, private manager: PullRequestManager, private stateManager: StateManager, private context: vscode.ExtensionContext) {
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
					(remote.fetchUrl?.toLowerCase() === this.issueModel.githubRepository.remote.url.toLowerCase())) {
					this.repo = repo;
					return;
				}
			}
		}
	}

	get issue(): IssueModel {
		return this.issueModel;
	}

	public async startWorking() {
		this.stateManager.currentIssue = this;
		const branchName = await this.createIssueBranch();
		if (branchName) {
			this.setCommitMessageAndGitEvent(branchName);
			this.setStatusBar();
		}
	}

	public dispose() {
		this.statusBarItem?.hide();
		this.statusBarItem?.dispose();
		this.repoChangeDisposable?.dispose();
	}

	public async stopWorking() {
		this.repo.inputBox.value = '';
		this.manager.repository.checkout((await this.manager.getPullRequestDefaults()).base);
		this.stateManager.currentIssue = undefined;
		this.dispose();
	}

	private async createIssueBranch(): Promise<string | undefined> {
		const state: IssueState = this.stateManager.getSavedIssueState(this.issueModel.number);
		let branchName: string | undefined = state.branch;
		if (!branchName) {
			const createBranchConfig = <string | boolean>vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('workingIssueBranch');
			if (createBranchConfig === true) {
				branchName = `${await this.issueModel.githubRepository.getAuthenticatedUser()}/issue${this.issueModel.number}`;
			} else if (createBranchConfig === false) {
				// Don't create a branch, but the function still succeeded.
				return this.manager.repository.state.HEAD!.name!;
			} else {
				switch (createBranchConfig) {
					case 'prompt': {
						branchName = await vscode.window.showInputBox({ placeHolder: `issue${this.issueModel.number}`, prompt: 'Enter the label for the new branch.' });
						break;
					}
					default: branchName = await variableSubstitution(createBranchConfig, this.issue); break;
				}
			}
		}
		if (!branchName) {
			branchName = `${await this.issueModel.githubRepository.getAuthenticatedUser()}/issue${this.issueModel.number}`;
		}
		let existingBranch: Branch | undefined;
		try {
			existingBranch = await this.manager.repository.getBranch(branchName);
		} catch (e) {
			// branch doesn't exist
		}
		state.branch = branchName
		this.stateManager.setSavedIssueState(this.issueModel.number, state);
		if (existingBranch) {
			await this.manager.repository.checkout(branchName);
		} else {
			await this.manager.repository.createBranch(branchName, true);
		}
		return branchName;
	}

	private setCommitMessageAndGitEvent(branchName: string) {
		this.repo.inputBox.value = `${this.issueModel.title} \nFixes #${this.issueModel.number}`;
		this.repoChangeDisposable = this.repo.state.onDidChange(() => {
			if (this.repo.state.HEAD?.name !== branchName) {
				this.stopWorking();
			}
		});
		this.context.subscriptions.push(this.repoChangeDisposable!);
		return;

	}

	private setStatusBar() {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
		this.statusBarItem.text = `Working on #${this.issueModel.number}`;
		this.statusBarItem.tooltip = this.issueModel.title;
		this.statusBarItem.command = 'issue.openCurrent';
		this.statusBarItem.show();
	}
}