/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { COPILOT_LOGINS } from '../../common/copilot';
import { OctokitCommon } from '../../github/common';
import { IssueModel } from '../../github/issueModel';
import { RepositoriesManager } from '../../github/repositoriesManager';

export interface copilotRemoteAgentToolParameters {
	repo?: {
		owner?: string;
		name?: string;
	};
	title: string;
	body?: string;
	mode?: 'issue' | 'remote-agent'; // 'issue' (default) or 'remote-agent'
}

export class copilotRemoteAgentTool
	implements vscode.LanguageModelTool<copilotRemoteAgentToolParameters> {
	public static readonly toolId = 'github-pull-request_copilot-remote-agent';
	private repositoriesManager: RepositoriesManager;

	constructor(repositoriesManager: RepositoriesManager) {
		this.repositoriesManager = repositoriesManager;
	}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t(
				'Creating an issue and assigning Copilot'
			),
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<copilotRemoteAgentToolParameters>,
		_: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult | undefined> {
		const repo = options.input.repo;
		const owner = repo?.owner;
		const name = repo?.name;
		const title = options.input.title;
		const body = options.input.body || '';
		const mode = options.input.mode || 'issue';
		if (!repo || !owner || !name || !title) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(
					'Missing required repo, owner, name, or title.'
				),
			]);
		}

		if (mode === 'remote-agent') {
			// Use the new remote agent API
			try {
				// Compose the API URL and payload
				const repoSlug = `${owner}/${name}`;
				const apiUrl = `https://api.githubcopilot.com/agents/swe/jobs/${repoSlug}`;
				// Get the GitHub token from the credential store (using VS Code authentication API)
				let githubToken: string | undefined;
				// Use the default GitHub auth provider
				// TODO: Can probably reuse the existing token from this extension somewhere?
				const session = await vscode.authentication.getSession('github', ['read:user', 'repo'], { createIfNone: true, silent: false });
				githubToken = session?.accessToken;
				if (!githubToken) {
					return new vscode.LanguageModelToolResult([
						new vscode.LanguageModelTextPart('Could not retrieve GitHub token for remote-agent API.')
					]);
				}
				const payload = {
					problem_statement: title,
					content_filter_mode: 'hidden_characters',
					pull_request: {
						title: title,
						body_placeholder: body || 'Welcome to this cool PR.',
						body_suffix: 'Good luck with the review!',
						base_ref: 'refs/heads/main',
						labels: ['copilot-agent']
					},
					run_name: 'Copilot Agent Run'
				};
				// Use fetch API (node-fetch or global fetch)
				const fetchImpl = (globalThis as any).fetch || require('node-fetch');
				const response = await fetchImpl(apiUrl, {
					method: 'POST',
					headers: {
						'Copilot-Integration-Id': 'copilot-developer-dev',
						'Authorization': `Bearer ${githubToken}`,
						'Content-Type': 'application/json',
						'Accept': 'application/json'
					},
					body: JSON.stringify(payload)
				});
				if (!response.ok) {
					const text = await response.text();
					return new vscode.LanguageModelToolResult([
						new vscode.LanguageModelTextPart(`Remote agent API error: ${response.status} ${text}`)
					]);
				}
				const result = await response.json();
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(JSON.stringify(result))
				]);
			} catch (e) {
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(`Remote agent API call failed: ${e}`)
				]);
			}
		}

		// Default: legacy issue+assign mode
		// Find the folder manager for the repo
		let folderManager = this.repositoriesManager.getManagerForRepository(
			owner,
			name
		);
		if (!folderManager && this.repositoriesManager.folderManagers.length > 0) {
			folderManager = this.repositoriesManager.folderManagers[0];
		}
		if (!folderManager) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(
					`No folder manager found for ${owner}/${name}. Make sure to have the repository open.`
				),
			]);
		}

		// Create the issue using OctokitCommon.IssuesCreateParams
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
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(
					`Failed to create issue for ${owner}/${name}: ${e}`
				),
			]);
		}
		if (!createdIssue) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(
					`Failed to create issue for ${owner}/${name}.`
				),
			]);
		}

		// Assign Copilot (swe-agent) to the issue using assignable user object and replaceAssignees
		try {
			// Get assignable users for all remotes (returns a map of remoteName to IAccount[])
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
				// fallback: flatten all arrays in the map
				assignableUsers = ([] as any[]).concat(...Object.values(assignableUsersMap));
			}
			if (!assignableUsers || assignableUsers.length === 0) {
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(
						`Issue created, but no assignable users found for ${owner}/${name}.`
					),
				]);
			}
			// Find the Copilot user object (by login)
			const copilotUser = assignableUsers.find((user: any) =>
				COPILOT_LOGINS.includes(user.login)
			);
			if (!copilotUser) {
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(
						`Issue created, but Copilot user was not found in assignable users for ${owner}/${name}.`
					),
				]);
			}
			// Use replaceAssignees to assign Copilot
			await createdIssue.replaceAssignees([copilotUser]);
		} catch (e) {
			// If replaceAssignees fails, return error but still return the created issue
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(
					`Issue created, but failed to assign Copilot: ${e}`
				),
			]);
		}

		const issueInfo = {
			number: createdIssue.number,
			title: createdIssue.title,
			body: createdIssue.body,
			assignees: createdIssue.assignees,
			url: createdIssue.html_url,
			state: createdIssue.state,
		};
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(JSON.stringify(issueInfo)),
		]);
	}
}
