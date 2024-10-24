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
					await this.stateManager.refresh(this.manager);
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

	private async createOrCheckoutBranch(branch: string, silent: boolean): Promise<boolean> {
		let localBranchName = branch;
		try {
			const isRemoteBranch = branch.startsWith('origin/');
			if (isRemoteBranch) {
				localBranchName = branch.substring('origin/'.length);
			}
			const localBranch = await this.getBranch(localBranchName);
			if (localBranch) {
				await this.manager.repository.checkout(localBranchName);
			} else if (isRemoteBranch) {
				await this.manager.repository.createBranch(localBranchName, true, branch);
				console.log('Setting upstream');
				console.log(localBranchName, '->', branch);
				await this.manager.repository.setBranchUpstream(localBranchName, branch);
			} else {
				await this.manager.repository.createBranch(localBranchName, true);
			}
			return true;
		} catch (e: any) {
			if (e.message !== 'User aborted') {
				if (!silent) {
					vscode.window.showErrorMessage(`Unable to checkout branch ${localBranchName}. There may be file conflicts that prevent this branch change. Git error: ${e.message}`);
				}
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
		const branchTitleSetting = vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE).get<string>(ISSUE_BRANCH_TITLE);
		const branchTitle = branchTitleSetting
			? await variableSubstitution(branchTitleSetting, this.issue, undefined, await this.getUser())
			: this.getBasicBranchName(await this.getUser());

		return branchTitle;
	}

	private validateBranchName(branch: string): string | undefined {
		const VALID_BRANCH_CHARACTERS = /[^ \\@\~\^\?\*\[]+/;
		const match = branch.match(VALID_BRANCH_CHARACTERS);
		if (match && match.length > 0 && match[0] !== branch) {
			return vscode.l10n.t('Branch name cannot contain a space or the following characters: \\@~^?*[');
		}
		return undefined;
	}

	private showBranchNameError(error: string, silent: boolean) {
		if (silent) {
			return;
		}
		const editSetting = 'Edit Setting';
		vscode.window.showErrorMessage(error, editSetting).then((result) => {
			if (result === editSetting) {
				vscode.commands.executeCommand(
					'workbench.action.openSettings',
					`${ISSUES_SETTINGS_NAMESPACE}.${ISSUE_BRANCH_TITLE}`,
				);
			}
		});
	}

	private async createIssueBranch(silent: boolean): Promise<boolean> {
		const createBranchConfig = this.shouldPromptForBranch
			? 'prompt'
			: vscode.workspace.getConfiguration(ISSUES_SETTINGS_NAMESPACE).get<string>(USE_BRANCH_FOR_ISSUES);

		if (createBranchConfig === 'off') return true;

		const state: IssueState = this.stateManager.getSavedIssueState(this.issueModel.number);
		const issueNumberStr = this.issueModel.number.toString();
		const issueTitle = this.issueModel.title;
		const suggestedBranchName = (await this.getBranchTitle()).toLocaleLowerCase();

		this._branchName = undefined;

		const branches = await this.manager.repository.getBranches({ remote: true });
		const branchesWithIssueMatch: vscode.QuickPickItem[] = [];
		const otherBranches: vscode.QuickPickItem[] = [];

		branches.forEach((branch) => {
			const isRemote = branch.name?.startsWith('origin/');
			const displayName = branch.name ?? '';
			const branchItem = {
				label: `${isRemote ? '$(cloud)' : '$(git-branch)'} ${displayName}`,
				description: `${isRemote ? 'Remote' : 'Local'} branch`,
			};

			if (
				branch.name?.toLowerCase().includes(issueNumberStr.toLowerCase()) ||
				branch.name?.toLowerCase().includes(issueTitle.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()) ||
				branch.name?.toLowerCase().includes(issueTitle.replace(/[^a-zA-Z0-9-]/g, '_').toLowerCase())
			) {
				branchesWithIssueMatch.push(branchItem);
			} else {
				otherBranches.push(branchItem);
			}
		});

		// Create QuickPick items
		const branchItems: vscode.QuickPickItem[] = [
			{ label: 'Suggested branch', kind: vscode.QuickPickItemKind.Separator },
			{
				label: `$(lightbulb) ${suggestedBranchName}`,
				description: '',
				detail: 'Recommended branch name based on settings',
				picked: true,
			},
		];

		if (branchesWithIssueMatch.length > 0) {
			branchItems.push({ label: 'Branches matching', kind: vscode.QuickPickItemKind.Separator });
			branchItems.push(...branchesWithIssueMatch);
		}

		if (otherBranches.length > 0) {
			branchItems.push({ label: 'Other branches', kind: vscode.QuickPickItemKind.Separator });
			branchItems.push(...otherBranches);
		}

		branchItems.push(
			{ label: 'Custom branch name:', kind: vscode.QuickPickItemKind.Separator },
			{ label: '$(pencil) Enter a custom branch name...', description: 'Choose this to type your own branch name' }
		);

		// Show QuickPick for branch selection
		const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
		quickPick.items = branchItems;
		quickPick.placeholder = 'Select a branch or create a new one for this issue';
		quickPick.ignoreFocusOut = true;
		quickPick.activeItems = [branchItems[1]];
		quickPick.show();

		const selectedBranch = await new Promise<vscode.QuickPickItem | undefined>((resolve) => {
			quickPick.onDidAccept(() => {
				resolve(quickPick.selectedItems[0]);
				quickPick.hide();
			});
			quickPick.onDidHide(() => resolve(undefined));
		});

		quickPick.dispose();

		if (!selectedBranch) {
			if (!silent) vscode.window.showInformationMessage('Branch selection cancelled.');
			return false;
		}

		if (selectedBranch.label === '$(pencil) Enter a custom branch name...') {
			const customBranchName = await vscode.window.showInputBox({
				prompt: 'Enter your custom branch name',
				placeHolder: 'e.g., feature/my-custom-branch',
				value: suggestedBranchName,
				validateInput: (input) => (input.trim() === '' ? 'Branch name cannot be empty.' : undefined),
			});

			if (!customBranchName) {
				if (!silent) vscode.window.showInformationMessage('Branch creation cancelled.');
				return false;
			}

			this._branchName = customBranchName.trim();
		} else {
			this._branchName = selectedBranch.label.replace(/^\$\([^\)]+\)\s*/, '').trim();
		}

		const validateBranchName = this.validateBranchName(this._branchName);
		if (validateBranchName) {
			this.showBranchNameError(validateBranchName, silent);
			return false;
		}

		state.branch = this._branchName;
		await this.stateManager.setSavedIssueState(this.issueModel, state);

		if (!(await this.createOrCheckoutBranch(this._branchName, silent))) {
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