/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';


import * as vscode from 'vscode';
import { AuthProvider } from '../../common/authentication';
import { COPILOT_LOGINS } from '../../common/copilot';
import { OctokitCommon } from '../../github/common';
import { CredentialStore } from '../../github/credentials';
import { IssueModel } from '../../github/issueModel';
import { RepositoriesManager } from '../../github/repositoriesManager';

export interface copilotRemoteAgentToolParameters {
	repo?: {
		owner?: string;
		name?: string;
	};
	title: string;
	body?: string;
	// mode?: 'issue' | 'remote-agent' | 'continue';
}


export enum CopilotRemoteAgentMode {
	default, // Trigger remote agent on 'main'
	continue, // Push pending changes and then trigger remote agent on that ref
	issue // Don't use
}


export class CopilotRemoteAgentService {
	constructor(private credentialStore: CredentialStore, public repositoriesManager: RepositoriesManager) { }

	async invokeRemoteAgent(owner: string, name: string, title: string, body: string, mode: CopilotRemoteAgentMode = CopilotRemoteAgentMode.continue): Promise<string> {
		try {
			const repoSlug = `${owner}/${name}`;
			const apiUrl = `https://api.githubcopilot.com/agents/swe/jobs/${repoSlug}`;
			const gh = await this.credentialStore.getHubOrLogin(AuthProvider.github);
			const { token } = await gh?.octokit.api.auth() as { token: string };
			if (!token) {
				throw new Error('Could not retrieve GitHub token');
			}

			let baseRef = 'refs/heads/main'; // TODO: Don't assume this
			if (mode === CopilotRemoteAgentMode.continue) {
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
			const fetchImpl = (globalThis as any).fetch || require('node-fetch');
			const response = await fetchImpl(apiUrl, {
				method: 'POST',
				headers: {
					'Copilot-Integration-Id': 'copilot-developer-dev',
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json',
					'Accept': 'application/json'
				},
				body: JSON.stringify(payload)
			});
			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Remote agent API error: ${response.status} ${text}`);
			}
			const result = await response.json();
			const prUrl = result?.pull_request?.html_url || result?.pull_request?.url;
			return prUrl || JSON.stringify(result);
		} catch (e) {
			throw new Error(`Remote agent API call failed: ${e}`);
		}
	}

	async invokeIssueAssign(owner: string, name: string, title: string, body: string): Promise<any> {
		let folderManager = this.repositoriesManager.getManagerForRepository(owner, name);
		if (!folderManager && this.repositoriesManager.folderManagers.length > 0) {
			folderManager = this.repositoriesManager.folderManagers[0];
		}
		if (!folderManager) {
			throw new Error(`No folder manager found for ${owner}/${name}. Make sure to have the repository open.`);
		}
		const params: OctokitCommon.IssuesCreateParams = {
			owner,
			repo: name,
			title,
			body,
		};
		let createdIssue: IssueModel | undefined;
		try {
			createdIssue = await folderManager.createIssue(params);
		} catch (e) {
			throw new Error(`Failed to create issue for ${owner}/${name}: ${e}`);
		}
		if (!createdIssue) {
			throw new Error(`Failed to create issue for ${owner}/${name}.`);
		}
		try {
			const assignableUsersMap = await folderManager.getAssignableUsers();
			let assignableUsers: any[] = [];
			if (
				createdIssue &&
				createdIssue.remote &&
				createdIssue.remote.remoteName &&
				assignableUsersMap[createdIssue.remote.remoteName]
			) {
				assignableUsers = assignableUsersMap[createdIssue.remote.remoteName];
			} else {
				assignableUsers = ([] as any[]).concat(...Object.values(assignableUsersMap));
			}
			if (!assignableUsers || assignableUsers.length === 0) {
				throw new Error(`Issue created, but no assignable users found for ${owner}/${name}.`);
			}
			const copilotUser = assignableUsers.find((user: any) =>
				COPILOT_LOGINS.includes(user.login)
			);
			if (!copilotUser) {
				throw new Error(`Issue created, but Copilot user was not found in assignable users for ${owner}/${name}.`);
			}
			await createdIssue.replaceAssignees([copilotUser]);
		} catch (e) {
			throw new Error(`Issue created, but failed to assign Copilot: ${e}`);
		}
		const issueInfo = {
			number: createdIssue.number,
			title: createdIssue.title,
			body: createdIssue.body,
			assignees: createdIssue.assignees,
			url: createdIssue.html_url,
			state: createdIssue.state,
		};
		return issueInfo;
	}
}


export class copilotRemoteAgentTool implements vscode.LanguageModelTool<copilotRemoteAgentToolParameters> {
	public static readonly toolId = 'github-pull-request_copilot-coding-agent';
	private service: CopilotRemoteAgentService;

	constructor(credentialStore: CredentialStore, repositoriesManager: RepositoriesManager) {
		this.service = new CopilotRemoteAgentService(credentialStore, repositoriesManager);
	}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Assigning task to Copilot'),
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<copilotRemoteAgentToolParameters>,
		_: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult | undefined> {
		const repo = options.input.repo;
		let owner = repo?.owner;
		let name = repo?.name;
		const title = options.input.title;
		const body = options.input.body || '';

		let mode: CopilotRemoteAgentMode = CopilotRemoteAgentMode.default;
		// Use first folder manager as fallback for owner/repo
		const fm = this.service.repositoriesManager.folderManagers[0];

		const ignoreModelInterredRepoEntirelyTODO = true;
		if (ignoreModelInterredRepoEntirelyTODO || !repo || !owner) {
			if (!fm) {
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(
						'No folder manager found. Make sure to have a repository open or specify your target \'owner/repo\''
					),
				]);
			}
			const defaults = await fm.getPullRequestDefaults();
			if (defaults) {
				owner = defaults.owner;
				name = defaults.repo;
			}
		}

		if (!owner || !name || !title) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(
					'Missing required repo, owner, name, or title.'
				),
			]);
		}

		const preferIssueMode = vscode.workspace.getConfiguration('github').get<boolean>('copilotRemoteAgent.preferIssueMode', false);
		if (preferIssueMode) {
			mode = CopilotRemoteAgentMode.issue;
			try {
				const issueInfo = await this.service.invokeIssueAssign(owner, name, title, body);
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(JSON.stringify(issueInfo))
				]);
			} catch (e: any) {
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(e.message)
				]);
			}
		}
		if (fm) {
			const state = fm.repository.state;
			if (state.workingTreeChanges.length > 0 || state.indexChanges.length > 0) {
				mode = CopilotRemoteAgentMode.continue;
			}
		}
		try {
			const prUrl = await this.service.invokeRemoteAgent(owner, name, title, body, mode);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(prUrl)
			]);
		} catch (e: any) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(e.message)
			]);
		}
	}
}
