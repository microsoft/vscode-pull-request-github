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
		const sortedPrioritizedNotifications = prioritizedNotifications.sort((r1, r2) => r1.priority?.localeCompare(r2.priority ?? '') ?? 0);
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

				// TODO: add labels and the actual issue reactions
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

			const textCodeBlockRegex = /```text\s*([\s\S]+?)\s*```/gm;
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
	You are given a list of notifications, each related to a repository, an issue, pull request.
	Follow these guidelines to prioritize them:
	1.	Issues, pull requests (PRs), mentions, commits, and comments are the core types of notifications.
		For each notification, check if it involves the user directly (e.g., mentioned, assigned, requested for review) or passively (e.g., subscribed, participating in the conversation).
	2. 	Assign Priority:
			* Critical Priority (P1):
				* Direct mentions or assignments (you are mentioned, assigned, or requested for a review).
				* Issues/PRs related to a repository that you are frequently involved in (or of high relevance, e.g., production).
				* Notifications regarding bugs, security issues, or feature requests that have critical labels such as important, bug, security.
			* High Priority (P2):
				* Updates to issues/PRs where there has been recent activity (e.g., new comments, commits).
				* Notifications from repositories you are watching that have significant updates, such as new commits, changes to PRs, or resolved issues.
				* PRs requiring reviews.
			* Medium Priority (P3):
				* Notifications of general discussion or updates on repositories you're subscribed to.
				* Non-urgent issues, comments, or notifications with no direct mention or action required.
				* Notifications from less critical repositories or older issues/PRs.
			* Low Priority (P4):
				* General repository activity that does not involve you directly.
				* Old, unresolved issues or PRs with no recent activity.
	3.	Evaluate Urgency:
			* Issues that have the "important" label should always be a P1.
			* Notifications for closed issues or closed pull request should never be a P1.
			* Consider the last updated timestamp. The more recent the activity, the higher the urgency.
			* Consider the volume of activity (e.g., multiple comments or participants) to assess whether it's gaining traction and should be addressed.
	4.	Output:
			* For each notification, return a text code block containing the priority level (P1, P2, P3, or P4).
				Example output:
				\`\`\`text
				P2
				\`\`\`
				Example of incorrect output:
				P2

	Use the provided notifications list to determine the priorities based on the criteria above.
	The notification is provided as a JSON code block containing the object representing a notification. For each notification provide on code block result.
`;