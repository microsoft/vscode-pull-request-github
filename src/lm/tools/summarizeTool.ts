/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { concatAsyncIterable } from './toolsUtils';

interface SummarizationToolParameters {
	title: string;
	body: string;
	comments: {
		body: string;
	}[];
}

export class SummarizationTool implements vscode.LanguageModelTool<SummarizationToolParameters> {

	constructor() { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<SummarizationToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		let issueOrPullRequestInfo: string = `
Title : ${options.parameters.title}
Body : ${options.parameters.body}
`;
		const comments = options.parameters.comments;
		for (const [index, comment] of comments.entries()) {
			issueOrPullRequestInfo += `
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
			messages.push(vscode.LanguageModelChatMessage.User(`The issue or pull request information is as follows:`));
			messages.push(vscode.LanguageModelChatMessage.User(issueOrPullRequestInfo));
			const response = await model.sendRequest(messages, {});
			const responseText = await concatAsyncIterable(response.text);
			return {
				'text/plain': responseText
			};
		} else {
			return {
				'text/plain': issueOrPullRequestInfo
			};
		}
	}
}

function summarizeInstructions(): string {
	return `
You are an AI assistant who is very proficient in summarizing issues and PRs.
You will be given information relative to an issue or PR. Your task is to output a summary of the information. Make sure the summary is at least as short or shorter than the issue or PR with the comments.
`;
}