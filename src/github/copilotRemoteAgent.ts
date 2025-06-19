/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import { Disposable } from '../common/lifecycle';
import { CODING_AGENT, CODING_AGENT_AUTO_COMMIT_AND_PUSH, CODING_AGENT_ENABLED, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { CopilotApi } from './copilotApi';
import { CredentialStore } from './credentials';
import { RepositoriesManager } from './repositoriesManager';


type RemoteAgentSuccessResult = { link: string; state: 'success', llmDetails?: string };
type RemoteAgentErrorResult = { error: string; state: 'error' };
type RemoteAgentResult = RemoteAgentSuccessResult | RemoteAgentErrorResult;

export class CopilotRemoteAgentManager extends Disposable {
	public static ID = 'CopilotRemoteAgentManager';

	constructor(private credentialStore: CredentialStore, public repositoriesManager: RepositoriesManager) {
		super();
		this._register(this.credentialStore.onDidChangeSessions((e: vscode.AuthenticationSessionsChangeEvent) => {
			if (e.provider.id === 'github') {
				this._copilotApiPromise = Promise.resolve(undefined); // Invalidate cached session

			}
		}));
	}

	private _copilotApiPromise: Promise<CopilotApi | undefined>;
	private get copilotApi(): Promise<CopilotApi | undefined> {
		if (!this._copilotApiPromise) {
			this._copilotApiPromise = this.initializeCopilotApi();
		}
		return this._copilotApiPromise;
	}

	private async initializeCopilotApi(): Promise<CopilotApi | undefined> {
		const gh = await this.credentialStore.getHubOrLogin(AuthProvider.github);
		const { token } = await gh?.octokit.api.auth() as { token: string };
		if (!token) {
			return;
		}
		return new CopilotApi(token);
	}

	enabled(): boolean {
		return vscode.workspace
			.getConfiguration(CODING_AGENT).get(CODING_AGENT_ENABLED) ?? false;
	}

	autoCommitAndPushEnabled(): boolean {
		return vscode.workspace
			.getConfiguration(CODING_AGENT).get(CODING_AGENT_AUTO_COMMIT_AND_PUSH) ?? false;
	}

	private getFolderManagerForRepo(owner?: string, repo?: string) {
		let folderManager = (owner && repo)
			? this.repositoriesManager.getManagerForRepository(owner, repo)
			: undefined;
		if (!folderManager && this.repositoriesManager.folderManagers.length > 0) {
			folderManager = this.repositoriesManager.folderManagers[0];
		}
		if (!folderManager) {
			throw new Error('No folder manager found for the repository. Open a workspace with a Git repository.');
		}
		return folderManager;
	}

	async targetRepo(): Promise<{ owner: string; repo: string } | undefined> {
		const folderManager = this.getFolderManagerForRepo();
		if (!folderManager) {
			return;
		}
		const { owner, repo } = await folderManager.getPullRequestDefaults();
		if (!owner || !repo) {
			return;
		}
		return { owner, repo };
	}

	async commandImpl() {
		const body = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('What should Copilot continue working on?'),
			placeHolder: vscode.l10n.t('Finish writing my unit tests'),
			ignoreFocusOut: true,
			validateInput: (value: string) => {
				if (!value || value.trim().length === 0) {
					return vscode.l10n.t('Description cannot be empty');
				}
				return;
			}
		});

		if (!body) {
			return;
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Copilot Coding Agent'),
				cancellable: false
			},
			async (progress) => {
				progress.report({ message: vscode.l10n.t('Starting remote agent...') });
				const targetRepo = await this.targetRepo();
				if (!targetRepo) {
					vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace to use \'Continue with Copilot\''));
					return;
				}
				const result = await this.invokeRemoteAgent(targetRepo.owner, targetRepo.repo, vscode.l10n.t('Continuing from VS Code'), body);
				if (result.state === 'error') {
					vscode.window.showErrorMessage(result.error);
					return;
				}
				const { link } = result;
				const openLink = vscode.l10n.t('Open Link');
				vscode.window.showInformationMessage(
					// allow-any-unicode-next-line
					vscode.l10n.t('🚀 Remote agent started! Track progress at {0}', link),
					openLink
				).then(selection => {
					if (selection === openLink) {
						vscode.env.openExternal(vscode.Uri.parse(link));
					}
				});
			}
		);
	}

	async invokeRemoteAgent(owner: string, name: string, title: string, body: string): Promise<RemoteAgentResult> {
		if (!this.enabled()) {
			return { error: vscode.l10n.t('Please enable Copilot Remote Agent in your VS Code settings to continue'), state: 'error' };
		}

		const capiClient = await this.copilotApi;
		if (!capiClient) {
			return { error: vscode.l10n.t('Failed to initialize Copilot API'), state: 'error' };
		}

		const folderManager = this.getFolderManagerForRepo(owner, name);
		if (!folderManager) {
			return { error: vscode.l10n.t(`No folder manager found for ${owner}/${name}. Make sure to have the repository open.`), state: 'error' };
		}
		const repo = folderManager.repository;
		let baseRef = repo.state.HEAD?.name; // TODO: Is this always right?
		if (!baseRef) {
			return { error: vscode.l10n.t('No current branch detected in the repository.'), state: 'error' };
		}

		// NOTE: This is as unobtrusive as possible with the current high-level APIs.
		// We only create a new branch and commit if there are staged or working changes.
		// This could be improved if we add lower-level APIs to our git extension (e.g. in-memory temp git index).

		// Check if there are any changes to commit
		const hasChanges = repo.state.workingTreeChanges.length > 0 || repo.state.indexChanges.length > 0;
		if (hasChanges) {
			if (!this.autoCommitAndPushEnabled()) {
				return { error: vscode.l10n.t(`Uncommitted changes detected. Please commit or stash your changes before starting the remote agent (or enable '{1}' in settings)`, `${CODING_AGENT}.${CODING_AGENT_AUTO_COMMIT_AND_PUSH}`), state: 'error' };
			}
			const asyncBranch = `continue-from-${Date.now()}`;
			try {
				await repo.createBranch(asyncBranch, true);
				await repo.add([]);
				if (repo.state.indexChanges.length > 0) {
					// TODO: there is an issue here if the user has GPG signing enabled.
					await repo.commit('Checkpoint for Copilot Agent async session', { signCommit: false });
				}
				await repo.push('origin', asyncBranch, true);
			} catch (e) {
				return { error: vscode.l10n.t(`Could not auto-commit pending changes. Please commit or stash your changes before starting the remote agent. Error: ${e.message}`), state: 'error' };
			}
			baseRef = `refs/heads/${asyncBranch}`;
		}

		const payload = {
			problem_statement: title,
			content_filter_mode: 'hidden_characters',
			pull_request: {
				title: title,
				body_placeholder: body,
				body_suffix: 'Created from VS Code',
				base_ref: baseRef,
			},
			run_name: 'Copilot Agent Run'
		};

		const result = await capiClient.postRemoteAgentJob(owner, name, payload);
		const prUrl = result?.pull_request?.html_url || result?.pull_request?.url;
		if (!prUrl) {
			return { error: vscode.l10n.t('Unexpected response from Copilot API'), state: 'error' };
		}
		const prLlmString = `The remote agent has started work. It can be tracked from ${prUrl}.`;
		return {
			link: prUrl, state: 'success',
			llmDetails: hasChanges ? `The pending changes have been pushed to branch '${baseRef}'. ${prLlmString}` : prLlmString
		};
	}
}