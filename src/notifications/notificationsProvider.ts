/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import { CredentialStore, GitHub } from '../github/credentials';
import { Issue } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { hasEnterpriseUri } from '../github/utils';
import { concatAsyncIterable } from '../lm/tools/toolsUtils';

export class ResolvedNotification {

	public priority: string | undefined;

	constructor(
		readonly id: string,
		readonly subject: {
			readonly title: string,
			readonly type: 'Issue' | 'PullRequest',
			readonly url: string,
		},
		readonly reason: string,
		readonly repository: {
			readonly name: string,
			readonly owner: {
				readonly login: string,
			}
		},
		readonly unread: boolean,
		readonly updated_at: string,
		readonly last_read_at: string | null,
		readonly model: IssueModel | PullRequestModel
	) { }

	static fromOctokitCall(notification: any, model: IssueModel<Issue>, owner: string, name: string): ResolvedNotification {
		return new ResolvedNotification(
			notification.id,
			{
				title: notification.subject.title,
				type: notification.subject.type,
				url: notification.subject.url,
			},
			notification.reason,
			{
				name: name,
				owner: {
					login: owner,
				}
			},
			notification.unread,
			notification.updated_at,
			notification.last_read_at,
			model
		);
	}
}

function getNotificationOwner(notification: ResolvedNotification): { owner: string, name: string } {
	const owner = notification.repository.owner.login;
	const name = notification.repository.name;

	return { owner, name };
}

export class NotificationsProvider implements vscode.Disposable {
	private _authProvider: AuthProvider | undefined;
	private readonly _notifications = new Map<string, ResolvedNotification>();

	private readonly _disposables: vscode.Disposable[] = [];

	constructor(
		private readonly _credentialStore: CredentialStore,
		private readonly _repositoriesManager: RepositoriesManager
	) {
		if (_credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
			this._authProvider = AuthProvider.githubEnterprise;
		} else if (_credentialStore.isAuthenticated(AuthProvider.github)) {
			this._authProvider = AuthProvider.github;
		}
		this._disposables.push(
			vscode.authentication.onDidChangeSessions(_ => {
				if (_credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
					this._authProvider = AuthProvider.githubEnterprise;
				}

				if (_credentialStore.isAuthenticated(AuthProvider.github)) {
					this._authProvider = AuthProvider.github;
				}
			})
		);
	}

	private _getGitHub(): GitHub | undefined {
		return (this._authProvider !== undefined) ?
			this._credentialStore.getHub(this._authProvider) :
			undefined;
	}

	private _getKey(notification: ResolvedNotification): string | undefined {
		const url = notification.subject.url;
		if (!url) {
			return undefined;
		}
		const id = notification.subject.url.split('/').pop();
		const { owner, name } = getNotificationOwner(notification);
		return `${owner}/${name}#${id}`;
	}

	clearCache(): void {
		this._notifications.clear();
	}

	async getNotifications(): Promise<ResolvedNotification[] | undefined> {
		const gitHub = this._getGitHub();
		if (gitHub === undefined) {
			return undefined;
		}
		if (this._repositoriesManager.folderManagers.length === 0) {
			return undefined;
		}
		const notifications = await this._getResolvedNotifications(gitHub);
		const filteredNotifications = notifications.filter(notification => notification !== undefined) as ResolvedNotification[];
		const sortedPrioritizedNotifications = await this._prioritizeNotifications(filteredNotifications);
		return sortedPrioritizedNotifications;
	}

	private async _getResolvedNotifications(gitHub: GitHub): Promise<(ResolvedNotification | undefined)[]> {
		const { data } = await gitHub.octokit.call(gitHub.octokit.api.activity.listNotificationsForAuthenticatedUser, {
			all: false,
			per_page: 50
		});
		return Promise.all(data.map(async (notification: any): Promise<ResolvedNotification | undefined> => {
			const cachedNotificationKey = this._getKey(notification);
			if (!cachedNotificationKey) {
				return undefined;
			}
			const cachedNotification = this._notifications.get(cachedNotificationKey);
			if (cachedNotification && cachedNotification.updated_at === notification.updated_at) {
				return cachedNotification;
			}
			const { owner, name } = getNotificationOwner(notification);
			const model = await this._getNotificationModel(notification, owner, name);
			if (!model) {
				return undefined;
			}
			const resolvedNotification = ResolvedNotification.fromOctokitCall(notification, model, owner, name);
			this._notifications.set(cachedNotificationKey, resolvedNotification);
			return resolvedNotification;
		}));
	}

	private async _getNotificationModel(notification: any, owner: string, name: string): Promise<IssueModel<Issue> | undefined> {
		const url = notification.subject.url;
		if (!(typeof url === 'string')) {
			return undefined;
		}
		const issueOrPrNumber = url.split('/').pop();
		if (issueOrPrNumber === undefined) {
			return undefined;
		}
		const folderManager = this._repositoriesManager.getManagerForRepository(owner, name) ?? this._repositoriesManager.folderManagers[0];
		const model = notification.subject.type === 'Issue' ?
			await folderManager.resolveIssue(owner, name, parseInt(issueOrPrNumber), true) :
			await folderManager.resolvePullRequest(owner, name, parseInt(issueOrPrNumber));
		return model;
	}

	private async _prioritizeNotifications(notifications: ResolvedNotification[]): Promise<ResolvedNotification[]> {
		const notificationBatchSize = 5;
		const notificationBatches: (ResolvedNotification[])[] = [];
		for (let i = 0; i < notifications.length; i += notificationBatchSize) {
			notificationBatches.push(notifications.slice(i, i + notificationBatchSize));
		}
		const prioritizedBatches = await Promise.all(notificationBatches.map(batch => this._prioritizeNotificationBatch(batch)));
		const prioritizedNotifications = prioritizedBatches.flat();
		const sortedPrioritizedNotifications = prioritizedNotifications.sort((r1, r2) => {
			const priority1 = Number(r1.priority);
			const priority2 = Number(r2.priority);
			return priority2 - priority1;
		});
		return sortedPrioritizedNotifications;
	}

	private async _prioritizeNotificationBatch(notifications: ResolvedNotification[]): Promise<ResolvedNotification[]> {
		try {
			const models = await vscode.lm.selectChatModels({
				vendor: 'copilot',
				family: 'gpt-4o'
			});
			const model = models[0];
			const userLogin = (await this._credentialStore.getCurrentUser(AuthProvider.github)).login;
			const messages = [vscode.LanguageModelChatMessage.User(getPrioritizeNotificationsInstructions(userLogin))];
			for (const [notificationIndex, notification] of notifications.entries()) {
				const model = notification.model;
				if (!model) {
					continue;
				}
				let notificationMessage = this._getBasePrompt(model, notificationIndex);
				notificationMessage += await this._getLabelsPrompt(model);
				notificationMessage += await this._getCommentsPrompt(model);
				messages.push(vscode.LanguageModelChatMessage.User(notificationMessage));
			}
			messages.push(vscode.LanguageModelChatMessage.User('Please provide the priority for each notification in a separate text code block. Remember to place the title and the reasoning outside of the text code block.'));
			const response = await model.sendRequest(messages, {});
			const responseText = await concatAsyncIterable(response.text);
			const updatedNotifications = this._updateNotificationsWithPriorityFromLLM(notifications, responseText);
			return updatedNotifications;
		} catch (e) {
			console.log(e);
			return [];
		}
	}

	private _getBasePrompt(model: IssueModel<Issue> | PullRequestModel, notificationIndex: number): string {
		const assignees = model.assignees;
		return `
The following is the data for notification ${notificationIndex + 1}:
• Author: ${model.author.login}
• Title: ${model.title}
• Assignees: ${assignees?.join(', ') || 'none'}
• Body:

${model.body}

• Reaction Count: ${model.reactionCount ?? 0}
• isOpen: ${model.isOpen}
• isMerged: ${model.isMerged}
• Created At: ${model.createdAt}
• Updated At: ${model.updatedAt}`;
	}

	private async _getLabelsPrompt(model: IssueModel<Issue> | PullRequestModel): Promise<string> {
		const labels = model.labels;
		if (!labels) {
			return '';
		}
		let labelsMessage = '';
		if (labels.length > 0) {
			const labelListAsString = labels.map(label => label.name).join(', ');
			labelsMessage = `
• Labels: ${labelListAsString}`;
		}
		return labelsMessage;
	}

	private async _getCommentsPrompt(model: IssueModel<Issue> | PullRequestModel): Promise<string> {
		const issueComments = model.issueComments;
		if (!issueComments || issueComments.length === 0) {
			return '';
		}
		let commentsMessage = `

The following is the data concerning the comments for the notification:`;

		for (const [commentIndex, comment] of issueComments.entries()) {
			commentsMessage += `

Comment ${commentIndex + 1} for notification:
• Body:
${comment.body}
• Reaction Count: ${comment.reactionCount}`;
		}
		return commentsMessage;
	}

	private _updateNotificationsWithPriorityFromLLM(notifications: ResolvedNotification[], text: string): ResolvedNotification[] {
		const regex = /```text\s*[\s\S]+?\s*=\s*([\S]+?)\s*```/gm;
		for (let i = 0; i < notifications.length; i++) {
			const execResult = regex.exec(text);
			if (execResult) {
				notifications[i].priority = execResult[1];
			}
		}
		return notifications;
	}

	dispose() {
		this._disposables.forEach(d => d.dispose());
	}
}

function getPrioritizeNotificationsInstructions(githubHandle: string) {
	return `
You are an intelligent assistant tasked with prioritizing GitHub notifications.
You are given a list of notifications for the user ${githubHandle}, each related to an issue or pull request.
Follow the following scoring mechanism to priority the notifications:

	1. Assign points from 0 to 30 to the importance of the notification. Consider the following points:
		- In case of an issue, does the content/title suggest this is a critical issue? In the case of a PR, does the content/title suggest it fixes a critical issue? A critical issue/PR has a higher priority.
		- To evaluate the importance/criticality of an issue/PR evaluate whether it references the following. Such issues/PRs should be assigned a higher priority.
			- security vulnerabilities
			- major regressions
			- data loss
			- crashes
			- performance issues
			- memory leaks
			- breaking changes
		- Are the labels assigned to the issue/PR indicate it is critical. Labels that include the following: 'critical', 'urgent', 'important', 'high priority' should be assigned a higher priority.
		- Is the issue/PR suggesting it is blocking for other work and must be addressed now?
		- Is the issue/PR user facing? User facing issue/PRs that have a clear negative impact on the user should be assigned a higher priority.
		- Is the tone of voice urgent or neutral? An urgent tone of voice has a higher priority.
		- In contrast, issues/PRs about technical debt/code polishing/minor internal issues or generally that have low importance should be assigned lower priority.
		- Is the issue/PR open or closed? An open issue/PR should be assigned a higher priority.
	2. Assign points from 0 to 30 for the community engagement. Consider the following points:
		- Reactions: Consider the number and the type of reactions under an issue/pr. A higher number of reactions should be assigned a higher priority.
		- Comments: Evaluate the community engagmenent on the issue/PR through the comments. In particular consider the following:
			- Does the issue/pr have a lot of comments indicating widespread interest?
			- Does the issue/pr have comments from many different users which would indicate widespread interest?
			- Evaluate the comments content. Do they indicate that the issue/PR is critical and touches many people? A critical issue/PR should be assigned a higher priority.
			- Evaluate the effort/detail put into the comments, are the users invested in the issue/pr? A higher effort should be assigned a higher priority.
			- Evaluate the tone of voice in the comments, an urgent tone of voice should be assigned a higher priority.
			- Evaluate the reactions under the comments, a higher number of reactions indicate widespread interest and issue/PR following. A higher number of reactions should be assigned a higher priority.
	3. Assign points from 0 to 20 for the issue/PR content quality. Consider the following points:
		- Description: In the case of an issue, are there clear steps to reproduce the issue? In the case of a PR, is there a clear description of the change? A clearer, more complete description should be assigned a higher priority.
		- Effort: Evaluate the general effort put into writing this issue/PR. Does the user provide a lengthy clear explanation? A higher effort should be assigned a higher priority.
	4. Assign points from 0 to 10 for the pertinence of the notification.
		- Assignment: Is the issue/PR assigned to the user with github handle ${githubHandle} or is the user just mentioned? An issue/PR assigned to the user should be assigned a higher priority.
		- Review Request: Is the user's review is requested on the PR, or is the user ${githubHandle} just mentioned? A review request should be assigned a higher priority.
		- Generally does the issue/PR and the associated comments suggest the user is the main person resposible for resolving it? If so, assign a higher priority.
	5. Assign points from 0 to 10 for the timing factors of the notification.
		- Update Time: What is the last update_time of the notification? A more recent notification should be assigned a higher priority.
		- Responsiveness: Is the issue/PR author responsive?

Use the above guidelines to assign points to each notification. Provide the sum of the individual points in a separate text code block for each notification. The points sum to 100 as a maximum. OUTSIDE of the text code block add the name of the issue for which the scoring is done and a description for why you assigned this score.
The output should look as follows:

\`\`\`text
15 + 15 + 10 + 5 + 5 = 50
\`\`\`text
<title>
<reasoning>

Do not place the title and the reasoning in the text code block. The following is incorrect:

\`\`\`text
15 + 15 + 10 + 5 + 5 = 50
<title>
<reasoning>
\`\`\`text

`;
}