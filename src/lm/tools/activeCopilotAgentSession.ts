/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { AuthProvider } from '../../common/authentication';
import { CredentialStore } from '../../github/credentials';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { hasEnterpriseUri } from '../../github/utils';
import { FetchIssueResult } from './fetchIssueTool';

interface CopilotMessage {
	created: number;
	messages: {
		content: string;
		role?: string;
	}[];
}

export class ActiveCopilotAgentSession implements vscode.LanguageModelTool<FetchIssueResult> {
	public static readonly toolId = 'github-pull-request_activeCopilotAgentSession';
	constructor(private readonly folderManagers: RepositoriesManager, private readonly credentialStore: CredentialStore,) { }

	private _findActivePullRequest(): PullRequestModel | undefined {
		const folderManager = this.folderManagers.folderManagers.find((manager) => manager.activePullRequest);
		return folderManager?.activePullRequest ?? PullRequestOverviewPanel.currentPanel?.getCurrentItem();
	}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		const pullRequest = this._findActivePullRequest();
		return {
			invocationMessage: pullRequest ? vscode.l10n.t('Fetching Copilot agent session details for "{0}"', pullRequest.title) : vscode.l10n.t('Copilot agent session details'),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<any>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		let pullRequest = this._findActivePullRequest();
		const { model } = options;
		if (!pullRequest) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('There is no active pull request')]);
		}

		if (!model) {
			return;
		}

		let authProvider: AuthProvider | undefined;
		if (this.credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
			authProvider = AuthProvider.githubEnterprise;
		} else if (this.credentialStore.isAuthenticated(AuthProvider.github)) {
			authProvider = AuthProvider.github;
		} else {
			return;
		}
		const github = this.credentialStore.getHub(authProvider);
		const { token } = await github?.octokit.api.auth() as { token: string };

		const sessionsResponse = await fetch(`https://api.githubcopilot.com/agents/sessions/resource/pull/${pullRequest.id}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/json',
			},
		});
		const sessions = await sessionsResponse.json();
		const completedSessions = sessions.sessions.filter((s: any) => s.state === 'completed');
		const mostRecentSession = completedSessions.reduce((latest: any, session: any) => {
			return !latest || new Date(session.last_updated_at) > new Date(latest.last_updated_at)
				? session
				: latest;
		}, null);

		const logsResponse = await fetch(`https://api.githubcopilot.com/agents/sessions/${mostRecentSession.id}/logs`, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
				'User-Agent': 'GitHub VSCode Pull Requests'
			},
		});
		const logsResponseText = await logsResponse.text();
		const copilotLogs = this.parseCopilotEventStream(logsResponseText);

		// Summarize the Copilot agent's thinking process using the model
		const messages = [
			vscode.LanguageModelChatMessage.Assistant('You are an expert summarizer. The following logs show the thinking process and performed actions of a GitHub Copilot agent that was in charge of working on the current pull request. Read the logs and always maintain the thinking process. You can remove information on the tool call results that you think are not necessary for building context.'),
			vscode.LanguageModelChatMessage.User(`Copilot Agent Logs (JSON):\n${JSON.stringify(copilotLogs)}`)
		];

		let summaryText: string | undefined;
		try {
			const response = await model.sendRequest(messages, { justification: 'Summarizing Copilot agent logs for the active pull request.' }, _token);
			summaryText = await (typeof response.text === 'string' ? response.text : (typeof response.text?.[Symbol.asyncIterator] === 'function' ? (async () => { let out = ''; for await (const chunk of response.text) { out += chunk; } return out; })() : ''));
		} catch (e) {
			summaryText = undefined;
		}

		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(summaryText || 'Failed to summarize Copilot agent logs.')
		]);
	}

	private parseCopilotEventStream(logsResponseText: string): Record<number, CopilotMessage> {
		const result: Record<number, CopilotMessage> = {};

		logsResponseText
			.split('\n')
			.filter(line => line.startsWith('data:'))
			.forEach(line => {
				try {
					const obj = JSON.parse(line.replace(/^data:\s*/, ''));
					const created = obj.created;
					if (Array.isArray(obj.choices)) {
						for (const choice of obj.choices) {
							const delta = choice.delta || {};
							if (typeof delta.content === 'string') {
								if (!result[created]) {
									result[created] = { created, messages: [] };
								}
								result[created].messages.push({
									content: delta.content,
									role: typeof delta.role === 'string' ? delta.role : undefined
								});
							}
						}
					}
				} catch { /* ignore parse errors */ }
			});

		return result;
	}


}