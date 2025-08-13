/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { COPILOT_LOGINS } from '../../common/copilot';
import { GitChangeType, InMemFileChange } from '../../common/file';
import Logger from '../../common/logger';
import { CopilotRemoteAgentManager } from '../../github/copilotRemoteAgent';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { FetchIssueResult } from './fetchIssueTool';

export abstract class PullRequestTool implements vscode.LanguageModelTool<FetchIssueResult> {
	constructor(
		protected readonly folderManagers: RepositoriesManager,
		private readonly copilotRemoteAgentManager: CopilotRemoteAgentManager
	) { }

	protected abstract _findActivePullRequest(): PullRequestModel | undefined;

	protected abstract _confirmationTitle(): string;

	private shouldIncludeCodingAgentSession(pullRequest?: PullRequestModel): boolean {
		return !!pullRequest && this.copilotRemoteAgentManager.enabled && COPILOT_LOGINS.includes(pullRequest.author.login);
	}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		const pullRequest = this._findActivePullRequest();
		return {
			pastTenseMessage: pullRequest ? vscode.l10n.t('Read pull request "{0}"', pullRequest.title) : vscode.l10n.t('No active pull request'),
			invocationMessage: pullRequest ? vscode.l10n.t('Reading pull request "{0}"', pullRequest.title) : vscode.l10n.t('Reading active pull request'),
			confirmationMessages: { title: this._confirmationTitle(), message: pullRequest ? vscode.l10n.t('Allow reading the details of "{0}"?', pullRequest.title) : vscode.l10n.t('Allow reading the details of the active pull request?') },
		};
	}

	private parseCopilotEventStream(logsResponseText: string): string[] {
		const result: string[] = [];
		logsResponseText
			.split('\n')
			.filter(line => line.startsWith('data:'))
			.forEach(line => {
				try {
					const obj = JSON.parse(line.replace(/^data:\s*/, ''));
					if (Array.isArray(obj.choices)) {
						for (const choice of obj.choices) {
							const delta = choice.delta || {};
							if (typeof delta.content === 'string' && !!delta.role) {
								result.push(delta.content);
							}
						}
					}
				} catch { /* ignore parse errors */ }
			});

		return result;
	}

	async fallbackSessionLogs(
		pullRequest: PullRequestModel,
		model: vscode.LanguageModelChat,
		cancellationToken: vscode.CancellationToken
	) {
		const logs = await this.copilotRemoteAgentManager.getSessionLogsFromAction(pullRequest);
		// Summarize the Copilot agent's thinking process using the model
		const messages = [
			vscode.LanguageModelChatMessage.Assistant('You are an expert summarizer. The following logs show the thinking process and performed actions of a GitHub Copilot agent that was in charge of working on the current pull request. Read the logs and always maintain the thinking process. You can remove information on the tool call results that you think are not necessary for building context.'),
			vscode.LanguageModelChatMessage.User(`Copilot Agent Logs (JSON):\n${JSON.stringify(logs)}`)
		];

		let summaryText: string | undefined;
		try {
			const response = await model.sendRequest(messages, { justification: 'Summarizing Copilot agent logs for the active pull request.' }, cancellationToken);
			summaryText = await (typeof response.text === 'string' ? response.text : (typeof response.text?.[Symbol.asyncIterator] === 'function' ? (async () => { let out = ''; for await (const chunk of response.text) { out += chunk; } return out; })() : ''));
		} catch (e) {
			summaryText = '';
		}

		return summaryText;
	}

	async fetchCodingAgentSession(
		pullRequest: PullRequestModel,
		model: vscode.LanguageModelChat,
		token: vscode.CancellationToken
	): Promise<string | string[]> {
		let copilotSteps: string | string[] = [];
		try {
			const logs = await this.copilotRemoteAgentManager.getSessionLogFromPullRequest(pullRequest);
			if (!logs) {
				throw new Error('Could not get session logs');
			}

			copilotSteps = this.parseCopilotEventStream(logs.logs);
			if (copilotSteps.length === 0) {
				throw new Error('Empty Copilot agent logs received');
			}
		} catch (e) {
			Logger.debug(`Failed to fetch Copilot agent logs from API: ${e}.`, ActivePullRequestTool.toolId);
			copilotSteps = await this.fallbackSessionLogs(pullRequest, model, token);
		}

		return copilotSteps;
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<any>, token: vscode.CancellationToken): Promise<vscode.ExtendedLanguageModelToolResult | undefined> {
		let pullRequest = this._findActivePullRequest();

		if (!pullRequest) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('There is no active pull request')]);
		}

		let codingAgentSession: string | string[] = [];
		if (this.shouldIncludeCodingAgentSession(pullRequest) && options.model) {
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
			isDraft: pullRequest.isDraft ? 'is a draft and cannot be merged until marked as ready for review' : 'false',
			codingAgentSession,
			changes: (await pullRequest.getFileChangesInfo()).map(change => {
				if (change instanceof InMemFileChange) {
					return change.diffHunks?.map(hunk => hunk.diffLines.map(line => line.raw).join('\n')).join('\n') || '';
				} else {
					return `File: ${change.fileName} was ${change.status === GitChangeType.ADD ? 'added' : change.status === GitChangeType.DELETE ? 'deleted' : 'modified'}.`;
				}
			})
		};

		const result = new vscode.ExtendedLanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(pullRequestInfo))]);
		result.toolResultDetails = [vscode.Uri.parse(pullRequest.html_url)];
		return result;
	}

}

export class ActivePullRequestTool extends PullRequestTool {
	public static readonly toolId = 'github-pull-request_activePullRequest';

	protected _findActivePullRequest(): PullRequestModel | undefined {
		const folderManager = this.folderManagers.folderManagers.find((manager) => manager.activePullRequest);
		return folderManager?.activePullRequest;
	}

	protected _confirmationTitle(): string {
		return vscode.l10n.t('Active Pull Request');
	}
}