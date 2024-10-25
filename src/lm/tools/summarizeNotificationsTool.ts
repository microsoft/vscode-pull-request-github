/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { FetchNotificationResult } from './fetchNotificationTool';
import { concatAsyncIterable, TOOL_COMMAND_RESULT } from './toolsUtils';

export class NotificationSummarizationTool implements vscode.LanguageModelTool<FetchNotificationResult> {
	public static readonly toolId = 'github-pull-request_notification_summarize';

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<FetchNotificationResult>): Promise<vscode.PreparedToolInvocation> {
		const parameters = options.parameters;
		if (!parameters.itemType || !parameters.itemNumber) {
			return {
				invocationMessage: vscode.l10n.t('Summarizing notification')
			};
		}
		const type = parameters.itemType === 'issue' ? 'issues' : 'pull';
		const url = `https://github.com/${parameters.owner}/${parameters.repo}/${type}/${parameters.itemNumber}`;
		return {
			invocationMessage: vscode.l10n.t('Summarizing item [#{0}]({1})', parameters.itemNumber, url)
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchNotificationResult>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		let notificationInfo: string = '';
		const lastReadAt = options.parameters.lastReadAt;
		if (!lastReadAt) {
			// First time the thread is viewed, so no lastReadAt field
			notificationInfo += `This thread is viewed for the first time. Here is the main item information of the thread:`;
		}
		notificationInfo += `
Title : ${options.parameters.title}
Body : ${options.parameters.body}
`;
		const fileChanges = options.parameters.fileChanges;
		if (fileChanges) {
			notificationInfo += `
The following are the files changed:
`;
			for (const fileChange of fileChanges.values()) {
				notificationInfo += `
File : ${fileChange.fileName}
Patch: ${fileChange.patch}
`;
			}
		}

		const unreadComments = options.parameters.comments;
		if (unreadComments && unreadComments.length > 0) {
			notificationInfo += `
The following are the unread comments of the thread:
`;
			for (const [index, comment] of unreadComments.entries()) {
				notificationInfo += `
Comment ${index} :
Author: ${comment.author}
Body: ${comment.body}
`;
			}
		}
		const models = await vscode.lm.selectChatModels({
			vendor: 'copilot',
			family: 'gpt-4o'
		});
		const model = models[0];
		const content: vscode.LanguageModelTextPart[] = [];
		const threadId = options.parameters.threadId;
		const notificationKey = options.parameters.notificationKey;
		if (threadId && notificationKey) {
			const markAsReadCommand = {
				title: 'Mark As Read',
				command: 'notification.markAsRead',
				arguments: [{ threadId, notificationKey }]
			};
			content.push(new vscode.LanguageModelTextPart(TOOL_COMMAND_RESULT));
			content.push(new vscode.LanguageModelTextPart(JSON.stringify(markAsReadCommand)));
		}
		if (model) {
			const messages = [vscode.LanguageModelChatMessage.User(this.summarizeInstructions(options.parameters.owner, options.parameters.repo))];
			messages.push(vscode.LanguageModelChatMessage.User(`The notification information is as follows:`));
			messages.push(vscode.LanguageModelChatMessage.User(notificationInfo));
			const response = await model.sendRequest(messages, {});
			const responseText = await concatAsyncIterable(response.text);
			content.push(new vscode.LanguageModelTextPart(responseText));
		} else {
			content.push(new vscode.LanguageModelTextPart(notificationInfo));
		}
		return new vscode.LanguageModelToolResult(content);
	}

	private summarizeInstructions(owner: string, repo: string): string {
		return `
You are an AI assistant who is very proficient in summarizing notification threads.
You will be given information relative to a notification thread : the title, the body and the comments. In the case of a PR you will also be given patches of the PR changes.
Since you are reviewing a notification thread, part of the content is by definition unread. You will be told what part of the content is yet unread. This can be the comments or it can be both the thread issue/PR as well as the comments.
Your task is to output a summary of all this notification thread information and give an update to the user concerning the unread part of the thread.
Output references to issues and PRs as Markdown links. The current notification is for a thread that has owner ${owner} and is in the repo ${repo}.
If a comment references for example issue or PR #123, then output either of the following in the summary depending on if it is an issue or a PR:

[#123](https://github.com/${owner}/${repo}/issues/123)
[#123](https://github.com/${owner}/${repo}/pull/123)

When you summarize comments, always give a summary of each comment and always mention the author clearly before the comment. If the author is called 'joe' and the comment is 'this is a comment', then the output should be:

joe: this is a comment

Always include in your output, which part of the thread is unread by prefixing that part with the markdown heading of level 1 with text "Unread Thread" or "Unread Comments".
Make sure the summary is at least as short or shorter than the issue or PR with the comments and the patches if there are.
Example output:

# Unread Thread
<summary>
<comments>

or:

<summary>
# Unread Comments
<comments>

Both 'Unread Thread' and 'Unread Comments' should not appear at the same time as markdown titles. The following is incorrect:

# Unread Thread
<summary>
# Unread Comments
<comments>
`;
	}

}