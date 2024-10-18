/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import { EXPERIMENTAL_NOTIFICATIONS_PAGE_SIZE, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { OctokitCommon } from '../github/common';
import { CredentialStore, GitHub } from '../github/credentials';
import { Issue, Notification, NotificationSubjectType } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { hasEnterpriseUri, parseNotification } from '../github/utils';
import { concatAsyncIterable } from '../lm/tools/toolsUtils';
import { INotificationItem, NotificationsPaginationRange, NotificationsSortMethod } from './notificationItem';
import { NotificationItem, NotificationsManager, NotificationUpdate } from './notificationsManager';

export class NotificationsProvider implements vscode.Disposable {
	private _authProvider: AuthProvider | undefined;

	private readonly _disposables: vscode.Disposable[] = [];

	private readonly _notificationsPaginationRange: NotificationsPaginationRange = {
		startPage: 1,
		endPage: 1
	}

	private _sortingMethod: NotificationsSortMethod = NotificationsSortMethod.Timestamp;
	public get sortingMethod(): NotificationsSortMethod { return this._sortingMethod; }
	public set sortingMethod(value: NotificationsSortMethod) {
		if (this._sortingMethod === value) {
			return;
		}

		this._sortingMethod = value;
		this._onDidChangeSortingMethod.fire();
	}

	private readonly _onDidChangeSortingMethod = new vscode.EventEmitter<void>();
	readonly onDidChangeSortingMethod = this._onDidChangeSortingMethod.event;

	private _canLoadMoreNotifications: boolean = false;

	constructor(
		private readonly _credentialStore: CredentialStore,
		private readonly _repositoriesManager: RepositoriesManager,
		private readonly _notificationsManager: NotificationsManager
	) {
		if (_credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
			this._authProvider = AuthProvider.githubEnterprise;
		} else if (_credentialStore.isAuthenticated(AuthProvider.github)) {
			this._authProvider = AuthProvider.github;
		}
		this._disposables.push(
			_credentialStore.onDidChangeSessions(_ => {
				if (_credentialStore.isAuthenticated(AuthProvider.githubEnterprise) && hasEnterpriseUri()) {
					this._authProvider = AuthProvider.githubEnterprise;
				}
				if (_credentialStore.isAuthenticated(AuthProvider.github)) {
					this._authProvider = AuthProvider.github;
				}
			})
		);

		this._disposables.push(this._onDidChangeSortingMethod);
	}

	private _getGitHub(): GitHub | undefined {
		return (this._authProvider !== undefined) ?
			this._credentialStore.getHub(this._authProvider) :
			undefined;
	}

	public clearCache(): void {
		this._notificationsManager.clear();
	}

	public async markAsRead(notificationIdentifier: { threadId: string, notificationKey: string }): Promise<void> {
		const gitHub = this._getGitHub();
		if (gitHub === undefined) {
			return undefined;
		}
		await gitHub.octokit.call(gitHub.octokit.api.activity.markThreadAsRead, {
			thread_id: Number(notificationIdentifier.threadId)
		});
		this._notificationsManager.removeNotification(notificationIdentifier.notificationKey);
	}

	public async computeNotifications(): Promise<INotificationItem[] | undefined> {
		const gitHub = this._getGitHub();
		if (gitHub === undefined) {
			return undefined;
		}
		if (this._repositoriesManager.folderManagers.length === 0) {
			return undefined;
		}
		const notifications = await this._getResolvedNotifications(gitHub);
		const filteredNotifications = notifications.filter(notification => notification !== undefined) as INotificationItem[];
		if (this.sortingMethod === NotificationsSortMethod.Priority) {
			const models = await vscode.lm.selectChatModels({
				vendor: 'copilot',
				family: 'gpt-4o'
			});
			const model = models[0];
			if (model) {
				try {
					return this._sortNotificationsByLLMPriority(filteredNotifications, model);
				} catch (e) {
					return this._sortNotificationsByTimestamp(filteredNotifications);
				}
			}
		}
		return this._sortNotificationsByTimestamp(filteredNotifications);
	}

	public getNotifications(): INotificationItem[] {
		return this._notificationsManager.getAllNotifications();
	}

	public get canLoadMoreNotifications(): boolean {
		return this._canLoadMoreNotifications;
	}

	public loadMore(): void {
		this._notificationsPaginationRange.endPage += 1;
	}

	private async _getResolvedNotifications(gitHub: GitHub): Promise<(INotificationItem | undefined)[]> {
		const notificationPromises: Promise<{ notifications: INotificationItem[], hasNextPage: boolean }>[] = [];
		for (let i = this._notificationsPaginationRange.startPage; i <= this._notificationsPaginationRange.endPage; i++) {
			notificationPromises.push(this._getResolvedNotificationsForPage(gitHub, i));
		}

		const notifications = await Promise.all(notificationPromises);
		this._canLoadMoreNotifications = notifications[this._notificationsPaginationRange.endPage - 1].hasNextPage;

		return notifications.flatMap(n => n.notifications);
	}

	private async _getResolvedNotificationsForPage(gitHub: GitHub, pageNumber: number): Promise<{ notifications: INotificationItem[]; hasNextPage: boolean }> {
		const pageSize = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<number>(EXPERIMENTAL_NOTIFICATIONS_PAGE_SIZE, 50);
		const { data, headers } = await gitHub.octokit.call(gitHub.octokit.api.activity.listNotificationsForAuthenticatedUser, {
			all: false,
			page: pageNumber,
			per_page: pageSize
		});

		const resolvedNotifications = await Promise.all(data.map(async (notification: OctokitCommon.Notification): Promise<INotificationItem | undefined> => {
			const parsedNotification = parseNotification(notification);
			if (!parsedNotification) {
				return undefined;
			}
			const cachedNotification = this._notificationsManager.getNotification(parsedNotification?.key);
			if (cachedNotification && cachedNotification.notification.updatedAd === parsedNotification.updatedAd) {
				return cachedNotification;
			}
			const model = await this._getNotificationModel(parsedNotification);
			if (!model) {
				return undefined;
			}
			const resolvedNotification = new NotificationItem(parsedNotification, model);
			return resolvedNotification;
		}));

		const notifications = resolvedNotifications
			.filter(notification => !!notification) as NotificationItem[];
		this._notificationsManager.setNotifications(notifications);

		return { notifications, hasNextPage: headers.link?.includes(`rel="next"`) === true };
	}

	private async _getNotificationModel(notification: Notification): Promise<IssueModel<Issue> | undefined> {
		const url = notification.subject.url;
		if (!(typeof url === 'string')) {
			return undefined;
		}
		const issueOrPrNumber = url.split('/').pop();
		if (issueOrPrNumber === undefined) {
			return undefined;
		}
		const folderManager = this._repositoriesManager.getManagerForRepository(notification.owner, notification.name) ?? this._repositoriesManager.folderManagers[0];
		const model = notification.subject.type === NotificationSubjectType.Issue ?
			await folderManager.resolveIssue(notification.owner, notification.name, parseInt(issueOrPrNumber), true) :
			await folderManager.resolvePullRequest(notification.owner, notification.name, parseInt(issueOrPrNumber));
		return model;
	}

	private _sortNotificationsByTimestamp(notifications: INotificationItem[]): INotificationItem[] {
		return notifications.sort((n1, n2) => n1.notification.updatedAd > n2.notification.updatedAd ? -1 : 1);
	}

	private async _sortNotificationsByLLMPriority(notifications: INotificationItem[], model: vscode.LanguageModelChat): Promise<INotificationItem[]> {
		const sortByPriority = (r1: INotificationItem, r2: INotificationItem): number => {
			const priority1 = Number(r1.getPriority()?.priority);
			const priority2 = Number(r2.getPriority()?.priority);
			return priority2 - priority1;
		};
		const notificationBatchSize = 5;
		const notificationBatches: INotificationItem[][] = [];
		for (let i = 0; i < notifications.length; i += notificationBatchSize) {
			notificationBatches.push(notifications.slice(i, i + notificationBatchSize));
		}
		const prioritizedBatches = await Promise.all(notificationBatches.map(batch => this._prioritizeNotificationBatchWithLLM(batch, model)));
		const prioritizedNotifications = prioritizedBatches.flat();
		const sortedPrioritizedNotifications = prioritizedNotifications.sort((r1, r2) => sortByPriority(r1, r2));
		return sortedPrioritizedNotifications;
	}

	private async _prioritizeNotificationBatchWithLLM(notifications: INotificationItem[], model: vscode.LanguageModelChat): Promise<INotificationItem[]> {
		try {
			const userLogin = (await this._credentialStore.getCurrentUser(AuthProvider.github)).login;
			const messages = [vscode.LanguageModelChatMessage.User(getPrioritizeNotificationsInstructions(userLogin))];
			for (const [notificationIndex, notification] of notifications.entries()) {
				const issueModel = notification.model;
				if (!issueModel) {
					continue;
				}
				let notificationMessage = this._getBasePrompt(issueModel, notificationIndex);
				notificationMessage += await this._getLabelsPrompt(issueModel);
				notificationMessage += await this._getCommentsPrompt(issueModel);
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
• Title: ${model.title}
• Author: ${model.author.login}
• Assignees: ${assignees?.map(assignee => assignee.login).join(', ') || 'none'}
• Body:

${model.body}

• Reaction Count: ${model.item.reactionCount ?? 0}
• isOpen: ${model.isOpen}
• isMerged: ${model.isMerged}
• Created At: ${model.createdAt}
• Updated At: ${model.updatedAt}`;
	}

	private async _getLabelsPrompt(model: IssueModel<Issue> | PullRequestModel): Promise<string> {
		const labels = model.item.labels;
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
		const issueComments = model.item.comments;
		if (!issueComments || issueComments.length === 0) {
			return '';
		}
		let commentsMessage = `

The following is the data concerning the at most last 5 comments for the notification:`;

		let index = 1;
		const lowerCommentIndexBound = Math.max(0, issueComments.length - 5);
		for (let i = lowerCommentIndexBound; i < issueComments.length; i++) {
			const comment = issueComments.at(i)!;
			commentsMessage += `

Comment ${index} for notification:
• Body:
${comment.body}
• Reaction Count: ${comment.reactionCount}`;
			index += 1;
		}
		return commentsMessage;
	}

	private _updateNotificationsWithPriorityFromLLM(notifications: INotificationItem[], text: string): INotificationItem[] {
		const regexReasoning = /```text\s*[\s\S]+?\s*=\s*([\S]+?)\s*```/gm;
		const regexPriorityReasoning = /```(?!text)([\s\S]+?)(###|$)/g;
		const updates: NotificationUpdate[] = [];
		for (let i = 0; i < notifications.length; i++) {
			const execResultForPriority = regexReasoning.exec(text);
			if (execResultForPriority) {
				const update: NotificationUpdate = {
					priority: execResultForPriority[1],
					priorityReasoning: '',
					key: notifications[i].notification.key
				};
				updates.push(update);
				const execResultForPriorityReasoning = regexPriorityReasoning.exec(text);
				if (execResultForPriorityReasoning) {
					update.priorityReasoning = execResultForPriorityReasoning[1].trim();
				}
			}
		}
		this._notificationsManager.updateNotificationPriority(updates);
		return notifications;
	}

	dispose() {
		this._disposables.forEach(d => d.dispose());
	}
}

function getPrioritizeNotificationsInstructions(githubHandle: string) {
	return `
You are an intelligent assistant tasked with prioritizing GitHub notifications.
You are given a list of notifications for the current user ${githubHandle}, each related to an issue, pull request or discussion. In the case of an issue/PR, if there are comments, you are given the last 5 comments under it.
Use the following scoring mechanism to prioritize the notifications and assign them a score from 0 to 100:

	1. Assign points from 0 to 30 for the relevance of the notification. Below when we talk about the current user, it is always the user with the GitHub login handle ${githubHandle}. First consider if the corresponding thread is open or closed:
		- If the thread is closed, assign points as follows:
			- 0 points: If the current user is neither assigned, nor requested for a review, nor mentioned in the issue/PR/discussion.
			- 5 points: If the current user is mentioned or is the author of the issue/PR. In the case of an issue/PR, the current user should not be assigned to it.
			- 10 points: If the current user is assigned to the issue/PR or is requested for a review.
		- If the thread is open, assign points as follows:
			- 20 points: If the current user is neither assigned, nor requested for a review, nor mentioned in the issue/PR/discussion.
			- 25 points: If the current user is mentioned or is the author of the issue/PR. In the case of an issue/PR, the current user should not be assigned to it.
			- 30 points: If the current user is assigned to the issue/PR or is requested for a review.
	2. Assign points from 0 to 40 to the importance of the notification. Consider the following points:
		- In case of an issue, does the content/title suggest this is a critical issue? In the case of a PR, does the content/title suggest it fixes a critical issue? In the case of a discussion, do the comments suggest a critical discussion? A critical issue/pr/discussion has a higher priority.
		- To evaluate the importance/criticality of a notification evaluate whether it references the following. Such notifications should be assigned a higher priority.
			- security vulnerabilities
			- major regressions
			- data loss
			- crashes
			- performance issues
			- memory leaks
			- breaking changes
		- Do the labels assigned to the issue/PR/discussion indicate it is critical? Labels that include the following: 'critical', 'urgent', 'important', 'high priority' should be assigned a higher priority.
		- Is the issue/PR suggesting it is blocking for other work and must be addressed immediately? If so, the notification should be assigned a higher priority.
		- Is the issue/PR user facing? User facing issues/PRs that have a clear negative impact on the user should be assigned a higher priority.
		- Is the tone of voice urgent or neutral? An urgent tone of voice has a higher priority.
		- For issues, do the comments mention that the issue is a duplicate of another issue or is already fixed? If so assign a lower priority.
		- Issues should generally be assigned a higher score than PRs and discussions.
		- Issues about bugs/regressions should be assigned a higher priority than issues about feature requests which are less critical.
	3. Assign points from 0 to 30 for the community engagement. Consider the following points:
		- Reactions: Consider the number of reactions under an issue/PR/discussion that correspond to real users. A higher number of reactions should be assigned a higher priority.
		- Comments: Evaluate the community engagmenent on the issue/PR through the last 5 comments. If you detect a comment comming from a bot, do not include it in the following evaluation. Consider the following:
			- Does the issue/PR/discussion have a lot of comments indicating widespread interest?
			- Does the issue/PR/discussion have comments from many different users which would indicate widespread interest?
			- Evaluate the comments content. Do they indicate that the issue/PR is critical and touches many people? A critical issue/PR should be assigned a higher priority.
			- Evaluate the effort/detail put into the comments, are the users invested in the issue/PR/disccusion? A higher effort should be assigned a higher priority.
			- Evaluate the tone of voice in the comments, an urgent tone of voice should be assigned a higher priority.
			- Evaluate the reactions under the comments, a higher number of reactions indicate widespread interest and issue/PR/discussion following. A higher number of reactions should be assigned a higher priority.
		- Generally evaluate the issue/PR/discussion content quality. Consider the following points:
			- Description: In the case of an issue, are there clear steps to reproduce the issue? In the case of a PR, is there a clear description of the change? A clearer, more complete description should be assigned a higher priority.
			- Effort: Evaluate the general effort put into writing this issue/PR. Does the user provide a lengthy clear explanation? A higher effort should be assigned a higher priority.

Use the above guidelines to assign points to each notification. Provide the sum of the individual points in a SEPARATE text code block for each notification. The points sum to 100 as a maximum.
After the text code block containing the priority, add a detailed summary of the notification and generally explain why it is important or not, do NOT reference the scoring mechanism above. This summary and reasoning will be displayed to the user.
The output should look as follow. Here <summary + reasoning> corresponds to your summary and reasoning and <title> corresponds to the notification title. The title should be placed after three hashtags:

### <title>
\`\`\`text
20 + 30 + 20 = 70
\`\`\`text
<summary + reasoning>

The following is INCORRECT:

<title>
20 + 30 + 20 = 70
<summary + reasoning>
`;
}