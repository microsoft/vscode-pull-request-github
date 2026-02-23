/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { FetchIssueResult } from './fetchIssueTool';
import { GitChangeType, InMemFileChange } from '../../common/file';
import { CommentEvent, EventType, ReviewEvent } from '../../common/timelineEvent';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';

export abstract class PullRequestTool implements vscode.LanguageModelTool<FetchIssueResult> {
	constructor(
		protected readonly folderManagers: RepositoriesManager
	) { }

	protected abstract _findActivePullRequest(): PullRequestModel | undefined;

	protected abstract _confirmationTitle(): string;

	private _getPullRequestLabel(pullRequest: PullRequestModel): string {
		return `${pullRequest.title} (#${pullRequest.number})`;
	}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		const pullRequest = this._findActivePullRequest();
		if (!pullRequest) {
			return {
				pastTenseMessage: vscode.l10n.t('No active pull request'),
				invocationMessage: vscode.l10n.t('Reading active pull request'),
				confirmationMessages: { title: this._confirmationTitle(), message: vscode.l10n.t('Allow reading the details of the active pull request?') },
			};
		}

		const label = this._getPullRequestLabel(pullRequest);
		return {
			pastTenseMessage: vscode.l10n.t('Read pull request "{0}"', label),
			invocationMessage: vscode.l10n.t('Reading pull request "{0}"', label),
			confirmationMessages: { title: this._confirmationTitle(), message: vscode.l10n.t('Allow reading the details of "{0}"?', label) },
		};
	}

	async invoke(_options: vscode.LanguageModelToolInvocationOptions<any>, _token: vscode.CancellationToken): Promise<vscode.ExtendedLanguageModelToolResult | undefined> {
		let pullRequest = this._findActivePullRequest();

		if (!pullRequest) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('There is no active pull request')]);
		}

		const timeline = (pullRequest.timelineEvents && pullRequest.timelineEvents.length > 0) ? pullRequest.timelineEvents : await pullRequest.getTimelineEvents();
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
			timelineComments: timeline.filter((event): event is ReviewEvent | CommentEvent => event.event === EventType.Reviewed || event.event === EventType.Commented).map(event => {
				return {
					author: event.user?.login,
					body: event.body,
					commentType: event.event === EventType.Reviewed ? event.state : 'COMMENTED',
				};
			}),
			state: pullRequest.state,
			isDraft: pullRequest.isDraft ? 'is a draft and cannot be merged until marked as ready for review' : 'false',
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