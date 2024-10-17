/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { FetchNotificationResult } from './fetchNotificationTool';
import { concatAsyncIterable, MimeTypes } from './toolsUtils';

export class NotificationSummarizationTool implements vscode.LanguageModelTool<FetchNotificationResult> {

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

		const unreadComments = options.parameters.unreadComments;
		if (unreadComments.length > 0) {
			notificationInfo += `
The following are the unread comments of the thread:
`;
		}
		for (const [index, comment] of unreadComments.entries()) {
			notificationInfo += `
Comment ${index} :
Body: ${comment.body}
`;
		}
		const models = await vscode.lm.selectChatModels({
			vendor: 'copilot',
			family: 'gpt-4o'
		});
		const model = models[0];

		if (model) {
			const messages = [vscode.LanguageModelChatMessage.User(summarizeInstructions())];
			messages.push(vscode.LanguageModelChatMessage.User(`The notification information is as follows:`));
			messages.push(vscode.LanguageModelChatMessage.User(notificationInfo));
			const response = await model.sendRequest(messages, {});
			const responseText = await concatAsyncIterable(response.text);
			return {
				[MimeTypes.textPlain]: responseText
			};
		} else {
			return {
				[MimeTypes.textPlain]: notificationInfo
			};
		}
	}
}

function summarizeInstructions(): string {
	return `
You are an AI assistant who is very proficient in summarizing notifications.
You will be given information relative to a notification thread : the title, the body and the comments. In the case of a PR you will also be given patches of the PR changes.
Since you are revieweing a notification, part of the content is by definition unread. You will be told what part of the content is yet unread. This can be the comments or it can be both the thread issue/PR as well as the comments.
Your task is to output a summary of all this notification information and give an update to the user as concerning the thread.
Make sure the summary is at least as short or shorter than the issue or PR with the comments and the patches if there are.
`;
}