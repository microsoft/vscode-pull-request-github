/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { RepoToolBase } from './toolsUtils';
import Logger from '../../common/logger';
import { CheckState } from '../../github/interface';
import { PullRequestModel } from '../../github/pullRequestModel';

interface StatusChecksToolParameters {
	pullRequestNumber: number;
	repo?: {
		owner?: string;
		name?: string;
	};
}

export class PullRequestStatusChecksTool extends RepoToolBase<StatusChecksToolParameters> {
	public static readonly toolId = 'github-pull-request_pullRequestStatusChecks';

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<StatusChecksToolParameters>): Promise<vscode.PreparedToolInvocation> {
		if (!options.input.pullRequestNumber) {
			return {
				invocationMessage: vscode.l10n.t('Fetching status checks from GitHub'),
			};
		}
		const { owner, name } = await this.getRepoInfo({ owner: options.input.repo?.owner, name: options.input.repo?.name });
		const url = (owner && name) ? `https://github.com/${owner}/${name}/pull/${options.input.pullRequestNumber}` : undefined;
		const message = url
			? new vscode.MarkdownString(vscode.l10n.t('Fetching status checks for [#{0}]({1}) from GitHub', options.input.pullRequestNumber, url))
			: vscode.l10n.t('Fetching status checks for #{0} from GitHub', options.input.pullRequestNumber);
		return {
			invocationMessage: message,
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<StatusChecksToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const pullRequestNumber = options.input.pullRequestNumber;
		if (!pullRequestNumber) {
			throw new Error('No pull request number provided.');
		}
		const { owner, name, folderManager } = await this.getRepoInfo({ owner: options.input.repo?.owner, name: options.input.repo?.name });
		const issueOrPullRequest = await folderManager.resolveIssueOrPullRequest(owner, name, pullRequestNumber);
		if (!(issueOrPullRequest instanceof PullRequestModel)) {
			throw new Error(`No pull request found for ${owner}/${name}#${pullRequestNumber}. Make sure the pull request exists.`);
		}

		const pullRequest = issueOrPullRequest;
		const status = await pullRequest.getStatusChecks();
		const statuses = status[0]?.statuses ?? [];

		// Return all status checks, but only fetch logs for failures
		const statusChecks = await Promise.all(statuses.map(async (s) => {
			const entry: Record<string, any> = {
				context: s.context,
				description: s.description,
				state: s.state,
				name: s.workflowName,
				targetUrl: s.targetUrl,
			};
			if (s.state === CheckState.Failure && s.isCheckRun && s.databaseId) {
				try {
					entry.logs = await pullRequest.githubRepository.getCheckRunLogs(s.databaseId);
				} catch (e) {
					Logger.error(`Failed to fetch check run logs for ${s.context}: ${e}`, 'PullRequestStatusChecksTool');
				}
			}
			return entry;
		}));

		const statusChecksInfo = {
			statusChecks,
			reviewRequirements: {
				approvalsNeeded: status[1]?.count ?? 0,
				currentApprovals: status[1]?.approvals.length ?? 0,
				areChangesRequested: (status[1]?.requestedChanges.length ?? 0) > 0,
			},
		};

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(statusChecksInfo))]);
	}
}
