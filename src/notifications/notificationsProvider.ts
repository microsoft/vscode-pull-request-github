/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AuthProvider } from '../common/authentication';
import { CredentialStore, GitHub } from '../github/credentials';
import { IssueModel } from '../github/issueModel';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { hasEnterpriseUri } from '../github/utils';

export type Notification = {
	readonly id: string;
	readonly subject: {
		readonly title: string;
		readonly type: 'Issue' | 'PullRequest';
		readonly url: string;
	};
	readonly reason: string;
	readonly repository: {
		readonly name: string;
		readonly owner: {
			readonly login: string;
		}
	}
	readonly unread: boolean;
	readonly updated_at: string;
	readonly last_read_at: string | null;
	readonly model: IssueModel | PullRequestModel | undefined;
	priority: string | undefined;
};

function getNotificationOwner(notification: Notification): { owner: string, name: string } {
	const owner = notification.repository.owner.login;
	const name = notification.repository.name;

	return { owner, name };
}

export class NotificationsProvider implements vscode.Disposable {
	private _authProvider: AuthProvider | undefined;
	private readonly _notifications = new Map<string, Notification>();

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

	private _getKey(notification: Notification): string {
		const id = notification.subject.url.split('/').pop();
		const { owner, name } = getNotificationOwner(notification);

		return `${owner}/${name}#${id}`;
	}

	clearCache(): void {
		this._notifications.clear();
	}

	async getNotifications(): Promise<Notification[] | undefined> {
		const gitHub = this._getGitHub();
		if (gitHub === undefined) {
			return undefined;
		}
		if (this._repositoriesManager.folderManagers.length === 0) {
			return undefined;
		}

		// TODO:
		//  - consider increasing the per_page limit (max 100)
		//  - consider fetching all pages of notifications
		//  - consider fetching unread notifications
		const { data } = await gitHub.octokit.call(gitHub.octokit.api.activity.listNotificationsForAuthenticatedUser, {
			per_page: 50
		});

		// Resolve issues/pull request
		const result = await Promise.all(data.map(async (notification: any): Promise<Notification | undefined> => {
			const url = notification.subject.url;
			if (!(typeof url === 'string')) {
				return undefined;
			}
			const id = url.split('/').pop();
			if (id === undefined) {
				return undefined;
			}
			const { owner, name } = getNotificationOwner(notification);

			const cachedNotificationKey = this._getKey(notification);
			const cachedNotification = this._notifications.get(cachedNotificationKey);
			if (cachedNotification && cachedNotification.updated_at === notification.updated_at) {
				return cachedNotification;
			}

			const folderManager = this._repositoriesManager.getManagerForRepository(owner, name) ??
				this._repositoriesManager.folderManagers[0];

			// Resolve model
			const model = notification.subject.type === 'Issue' ?
				await folderManager.resolveIssue(owner, name, parseInt(id), true) :
				await folderManager.resolvePullRequest(owner, name, parseInt(id));

			const resolvedNotification = {
				id: notification.id,
				subject: {
					title: notification.subject.title,
					type: notification.subject.type,
					url: notification.subject.url,
				},
				reason: notification.reason,
				repository: {
					name: name,
					owner: {
						login: owner,
					}
				},
				unread: notification.unread,
				updated_at: notification.updated_at,
				last_read_at: notification.last_read_at,
				model: model,
				priority: undefined
			};

			this._notifications.set(cachedNotificationKey, resolvedNotification);
			return resolvedNotification;
		}));

		const filteredNotifications = result.filter(notification => notification !== undefined) as Notification[];

		const notificationBatchSize = 5;
		const notificationBatches: (Notification[])[] = [];
		for (let i = 0; i < filteredNotifications.length; i += notificationBatchSize) {
			notificationBatches.push(filteredNotifications.slice(i, i + notificationBatchSize));
		}
		const prioritizedBatches = await Promise.all(notificationBatches.map(batch => this.prioritizeNotifications(batch)));
		const prioritizedNotifications = prioritizedBatches.flat();
		const sortedPrioritizedNotifications = prioritizedNotifications.sort((r1, r2) => {
			const priority1 = Number(r1.priority);
			const priority2 = Number(r2.priority);
			return priority2 - priority1;
		});
		return sortedPrioritizedNotifications;
	}

	async prioritizeNotifications(notifications: Notification[]): Promise<Notification[]> {
		try {
			const models = await vscode.lm.selectChatModels({
				vendor: 'copilot',
				family: 'gpt-4o'
			});
			const model = models[0];

			const messages = [vscode.LanguageModelChatMessage.User(prioritizeNotificationsInstructions)];
			for (const [notificationIndex, notification] of notifications.entries()) {
				const model = notification.model;
				if (!model) {
					continue;
				}

				let notificationMessage = `
The following is the data for notification ${notificationIndex + 1}:
• Author: ${model.author.login}
• Title: ${model.title}
• Body:

${model.body}

• isOpen: ${model.isOpen}
• isMerged: ${model.isMerged}
• Created At: ${model.createdAt}
• Updated At: ${model.updatedAt}`;

				const labels = await model.getLabels();
				let labelsMessage = '';
				if (labels.length > 0) {
					const labelListAsString = labels.map(label => label.name).join(', ');
					labelsMessage = `
• Labels: ${labelListAsString}`;
				}
				notificationMessage += labelsMessage;

				const reactions = (await model.getReactions()).map(reaction => reaction.content);
				const reactionCountMap = new Map<string, number>();
				for (const reaction of reactions) {
					reactionCountMap.set(reaction, (reactionCountMap.get(reaction) || 0) + 1);
				}
				let reactionsMessage = '';
				if (reactionCountMap.size > 0) {
					reactionsMessage = `
• Reactions:`;
					for (const [reaction, count] of reactionCountMap.entries()) {
						reactionsMessage += `
	• ${reaction}: ${count}`;
					}
				}
				notificationMessage += reactionsMessage;

				const lastReadAt = notification.last_read_at;
				const issueComments = await model.getIssueComments();
				const newIssueComments = lastReadAt ? issueComments : issueComments; // .filter(comment => comment.updated_at > lastReadAt)

				if (newIssueComments.length > 0) {
					notificationMessage += `

The following is the data concerning the new unread comments since notification ${notificationIndex + 1} was last read.`;
				}
				for (const [commentIndex, comment] of newIssueComments.entries()) {
					const nonNullReactions = {};
					const commentReactions = comment.reactions;
					if (commentReactions) {
						for (const reaction of Object.keys(commentReactions)) {
							const count = commentReactions[reaction];
							if (count > 0) {
								nonNullReactions[reaction] = count;
							}
						}
					}
					let reactionMessage = '';
					if (Object.keys(nonNullReactions).length > 0) {
						reactionMessage = `
• Reactions: `;
						for (const reaction of Object.keys(nonNullReactions)) {
							reactionMessage += `
	• ${reaction}: ${nonNullReactions[reaction]} `;
						}
					}
					notificationMessage += `

Comment ${commentIndex + 1} for notification ${notificationIndex + 1}:
• Author Association: ${comment.author_association}
• Body:
${comment.body}
` + reactionMessage;
				}
				messages.push(vscode.LanguageModelChatMessage.User(notificationMessage));
			}
			messages.push(vscode.LanguageModelChatMessage.User('Please provide the priority for each notification in a separate text code block.'));

			const response = await model.sendRequest(messages, {});

			let responseText = '';
			for await (const chunk of response.text) {
				responseText += chunk;
			}

			const textCodeBlockRegex = /```text\s*[\s\S]+?\s*=\s*([\S]+?)\s*```/gm;
			for (let i = 0; i < notifications.length; i++) {
				const execResult = textCodeBlockRegex.exec(responseText);
				if (execResult) {
					notifications[i].priority = execResult[1];
				}
			}
			return notifications;
		} catch (e) {
			console.log(e);
			return [];
		}
	}

	dispose() {
		this._disposables.forEach(d => d.dispose());
	}
}

// export interface PromptProps extends BasePromptElementProps {
// 	notification: Notification;
// }
// export interface PromptState { }
// export class NotificationPrompt extends PromptElement<PromptProps, PromptState> {
// 	async render(state: PromptState, sizing: PromptSizing) {
// 		return (
// 		);
// 	}
// }

const prioritizeNotificationsInstructions = `
You are an intelligent assistant tasked with prioritizing GitHub notifications.
You are given a list of notifications, each related to an issue or pull request.
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
		- Assignment: Is the issue/PR assigned to the user or is the user just mentioned? An issue/PR assigned to the user should be assigned a higher priority.
		- Review Request: Is the user's review requested on the PR, or is the user just mentioned? A review request should be assigned a higher priority.
		- Generally does the issue/PR and the associated comments suggest the user is the main person resposible for resolving it? If so, assign a higher priority.
	5. Assign points from 0 to 10 for the timing factors of the notification.
		- Update Time: What is the last update_time of the notification? A more recent notification should be assigned a higher priority.
		- Responsiveness: Is the issue/PR author responsive?

Use the above guidelines to assign points to each notification. Provide the sum of the individual points in a separate text code block for each notification. The points sum to 100 as a maximum. After the text code block add a description for why you assigned this score.
The output should look as follows:

\`\`\`text
15 + 15 + 10 + 5 + 5 = 50
\`\`\`text

<reasoning>
`;