/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { AuthProvider } from '../../common/authentication';
import { COPILOT_LOGINS } from '../../common/copilot';
import { CredentialStore, GitHub } from '../../github/credentials';
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

export class ActivePullRequestTool implements vscode.LanguageModelTool<FetchIssueResult> {
	public static readonly toolId = 'github-pull-request_activePullRequest';
	constructor(
		private readonly folderManagers: RepositoriesManager,
		private readonly credentialStore: CredentialStore,
	) { }

	private _findActivePullRequest(): PullRequestModel | undefined {
		const folderManager = this.folderManagers.folderManagers.find((manager) => manager.activePullRequest);
		return folderManager?.activePullRequest ?? PullRequestOverviewPanel.currentPanel?.getCurrentItem();
	}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		const pullRequest = this._findActivePullRequest();
		return {
			invocationMessage: pullRequest ? vscode.l10n.t('Pull request "{0}"', pullRequest.title) : vscode.l10n.t('Active pull request'),
		};
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
							if (typeof delta.content === 'string' && !!delta.role) {
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

	async fallbackSessionLogs(github: GitHub, pullRequest: PullRequestModel) {
		const runs = await github.octokit.api.actions.listWorkflowRunsForRepo(
			{
				owner: pullRequest.githubRepository.remote.owner,
				repo: pullRequest.githubRepository.remote.repositoryName,
				event: 'dynamic'
			}
		);
		const padawanRuns: any[] = runs.data.workflow_runs
			.filter((run: any) => run.path && run.path.startsWith('dynamic/copilot-swe-agent'))
			.filter((run: any) => run.pull_requests?.some((pr: any) => pr.id === pullRequest.id));

		const lastRun = padawanRuns.reduce((latest: any, run: any) => {
			return !latest || new Date(run.created_at) > new Date(latest.created_at)
				? run
				: latest;
		}, null);

		if (!lastRun) {
			return;
		}

		const { token } = await github?.octokit.api.auth() as { token: string };
		const logs = await fetch(lastRun.logs_url, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/json',
			},
		});
		const log = await logs.text();
		console.log('Runs:', log);
	}

	async fetchCodingAgentSession(pullRequest: PullRequestModel, model: vscode.LanguageModelChat, cancellationToken: vscode.CancellationToken): Promise<string | undefined> {
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

		await this.fallbackSessionLogs(github!, pullRequest);

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
			const response = await model.sendRequest(messages, { justification: 'Summarizing Copilot agent logs for the active pull request.' }, cancellationToken);
			summaryText = await (typeof response.text === 'string' ? response.text : (typeof response.text?.[Symbol.asyncIterator] === 'function' ? (async () => { let out = ''; for await (const chunk of response.text) { out += chunk; } return out; })() : ''));
		} catch (e) {
			summaryText = undefined;
		}

		return summaryText;
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<any>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		let pullRequest = this._findActivePullRequest();

		if (!pullRequest) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('There is no active pull request')]);
		}

		let codingAgentSession: string | undefined;
		if (COPILOT_LOGINS.includes(pullRequest.author.login) && options.model) {
			codingAgentSession = await this.fetchCodingAgentSession(pullRequest, options.model, token);
		}

		const status = await pullRequest.getStatusChecks();
		const pullRequestInfo = {
			title: pullRequest.title,
			body: pullRequest.body,
			author: pullRequest.author,
			assignees: pullRequest.assignees,
			comments: pullRequest.comments.map(comment => {
				return {
					author: comment.user?.login,
					body: comment.body,
					commentState: comment.isResolved ? 'resolved' : 'unresolved',
					file: comment.path
				};
			}),
			state: pullRequest.state,
			statusChecks: status[0]?.statuses.map((status) => {
				return {
					context: status.context,
					description: status.description,
					state: status.state,
					name: status.workflowName,
					targetUrl: status.targetUrl
				};
			}),
			reviewRequirements: {
				approvalsNeeded: status[1]?.count ?? 0,
				currentApprovals: status[1]?.approvals.length ?? 0,
				areChangesRequested: (status[1]?.requestedChanges.length ?? 0) > 0,
			},
			isDraft: pullRequest.isDraft,
			codingAgentSession
		};

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(pullRequestInfo))]);

	}

}