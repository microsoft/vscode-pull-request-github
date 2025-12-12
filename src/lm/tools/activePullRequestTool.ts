/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { FetchIssueResult } from './fetchIssueTool';

export class ActivePullRequestTool implements vscode.LanguageModelTool<FetchIssueResult> {
	public static readonly toolId = 'github-pull-request_activePullRequest';
	constructor(private readonly folderManagers: RepositoriesManager) { }

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

	async invoke(_options: vscode.LanguageModelToolInvocationOptions<any>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		let pullRequest = this._findActivePullRequest();

		if (!pullRequest) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('There is no active pull request')]);
		}

		const status = await pullRequest.getStatusChecks();
		const pullRequestInfo = {
			title: pullRequest.title,
			body: pullRequest.body,
			author: pullRequest.author,
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
		};

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(pullRequestInfo))]);

	}

}