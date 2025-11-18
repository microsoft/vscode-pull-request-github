/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CommentEvent, EventType } from '../common/timelineEvent';
import { IssueModel } from '../github/issueModel';
import { IssueOverviewPanel } from '../github/issueOverview';
import { RepositoriesManager } from '../github/repositoriesManager';
import { getIssueNumberLabel } from '../github/utils';
import { IssueQueryResult, StateManager } from '../issues/stateManager';

interface IssueChatContextItem extends vscode.ChatContextItem {
	issue: IssueModel;
}

export class IssueContextProvider implements vscode.ChatContextProvider {
	constructor(private readonly _stateManager: StateManager,
		private readonly _reposManager: RepositoriesManager
	) { }

	async provideChatContextForResource(_options: { resource: vscode.Uri }, _token: vscode.CancellationToken): Promise<IssueChatContextItem | undefined> {
		const item = IssueOverviewPanel.currentPanel?.getCurrentItem();
		if (item) {
			return this._issueToUnresolvedContext(item);
		}
	}

	async resolveChatContext(context: IssueChatContextItem, _token: vscode.CancellationToken): Promise<vscode.ChatContextItem> {
		context.value = await this._resolvedIssueValue(context.issue);
		context.modelDescription = 'All the information about the GitHub issue the user is viewing, including comments.';
		return context;
	}

	async provideChatContextExplicit(_token: vscode.CancellationToken): Promise<IssueChatContextItem[] | undefined> {
		const contextItems: IssueChatContextItem[] = [];
		const seenIssues: Set<string> = new Set();
		for (const folderManager of this._reposManager.folderManagers) {
			const issueData = this._stateManager.getIssueCollection(folderManager?.repository.rootUri);

			for (const issueQuery of issueData) {
				const issuesOrMilestones: IssueQueryResult = await issueQuery[1];

				if ((issuesOrMilestones.issues ?? []).length === 0) {
					continue;
				}
				for (const issue of (issuesOrMilestones.issues ?? [])) {
					const issueKey = getIssueNumberLabel(issue as IssueModel);
					// Only add the issue if we haven't seen it before (first query wins)
					if (seenIssues.has(issueKey)) {
						continue;
					}
					seenIssues.add(issueKey);
					contextItems.push(this._issueToUnresolvedContext(issue as IssueModel));

				}
			}
		}
		return contextItems;
	}

	private _issueToUnresolvedContext(issue: IssueModel): IssueChatContextItem {
		return {
			icon: new vscode.ThemeIcon('issues'),
			label: `#${issue.number} ${issue.title}`,
			modelDescription: 'The GitHub issue the user is viewing.',
			issue,
		};
	}

	private async _resolvedIssueValue(issue: IssueModel): Promise<string> {
		const timeline = issue.timelineEvents ?? await issue.getIssueTimelineEvents();
		return JSON.stringify({
			issueNumber: issue.number,
			owner: issue.remote.owner,
			repo: issue.remote.repositoryName,
			title: issue.title,
			body: issue.body,
			comments: timeline.filter(e => e.event === EventType.Commented).map((e: CommentEvent) => ({
				author: e.user?.login,
				body: e.body,
				createdAt: e.createdAt
			}))
		});
	}
}