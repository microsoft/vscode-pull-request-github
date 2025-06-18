/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import { Disposable } from '../common/lifecycle';
import { CopilotApi } from './copilotApi';
import { CredentialStore } from './credentials';
import { RepositoriesManager } from './repositoriesManager';

export enum CopilotRemoteAgentMode {
	Default, // Trigger remote agent on 'main'
	Continue, // Push pending changes and then trigger remote agent on that ref
}

export class CopilotRemoteAgentManager extends Disposable {
	public static ID = 'CopilotRemoteAgentManager';

	constructor(private credentialStore: CredentialStore, public repositoriesManager: RepositoriesManager) {
		super();
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
			.getConfiguration('githubPullRequests').get('codingAgent') ?? false;
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
				const target = await this.repositoriesManager?.folderManagers[0]?.getPullRequestDefaults();
				if (!target) {
					vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace to use \'Continue with Copilot\''));
					return;
				}
				const link = await this.invokeRemoteAgent(target.owner, target.repo, vscode.l10n.t('Continuing from VS Code'), body);
				if (!link) {
					vscode.window.showErrorMessage(vscode.l10n.t('Failed to start remote agent. Please try again later.'));
					return;
				}
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

	async invokeRemoteAgent(owner: string, name: string, title: string, body: string, mode: CopilotRemoteAgentMode = CopilotRemoteAgentMode.Continue): Promise<string | undefined> {
		if (!this.enabled()) {
			throw new Error('Copilot Remote Agent is not enabled.'); // TODO: ??
		}

		const capiClient = await this.copilotApi;
		if (!capiClient) {
			return;
		}

		let baseRef = 'refs/heads/main'; // TODO: Don't assume this
		if (mode === CopilotRemoteAgentMode.Continue) {
			let folderManager = this.repositoriesManager.getManagerForRepository(owner, name);
			if (!folderManager && this.repositoriesManager.folderManagers.length > 0) {
				folderManager = this.repositoriesManager.folderManagers[0];
			}
			if (!folderManager) {
				throw new Error(`No folder manager found for ${owner}/${name}. Make sure to have the repository open.`);
			}
			const repo = folderManager.repository;
			const currentBranch = repo.state.HEAD?.name;
			if (!currentBranch) {
				throw new Error('No current branch detected in the repository.');
			}
			const asyncBranch = `continue-from-${Date.now()}`;
			try {
				await repo.createBranch(asyncBranch, true);
				await repo.add([]); // stage all changes
				await repo.commit('Checkpoint for Copilot Agent async session', { signCommit: false });
				await repo.push('origin', asyncBranch, true);
			} catch (e) {
				throw new Error(`Failed to push changes to new branch: ${e}`);
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
		return prUrl || JSON.stringify(result);
	}
}