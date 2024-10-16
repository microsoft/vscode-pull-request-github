/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { InMemFileChange } from '../../common/file';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { fetchIssueOrPR } from './fetchTool';
import { concatAsyncIterable } from './toolsUtils';

interface SummarizationToolParameters {
	issueNumber: number;
	repo?: {
		owner: string;
		name: string;
	};
}

export class SummarizationTool implements vscode.LanguageModelTool<SummarizationToolParameters> {
	constructor(private readonly repositoriesManager: RepositoriesManager) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<SummarizationToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const issueOrPullRequest = await fetchIssueOrPR(options, this.repositoriesManager);
		const models = await vscode.lm.selectChatModels({
			vendor: 'copilot',
			family: 'gpt-4o'
		});
		const model = models[0];

		let issueOrPullRequestInfo: string = `
Title : ${issueOrPullRequest.title}
Body : ${issueOrPullRequest.body}
IsOpen : ${issueOrPullRequest.isOpen}
`;
		const comments = issueOrPullRequest.item.comments;
		if (comments) {
			for (const [index, comment] of comments.entries()) {
				issueOrPullRequestInfo += `
Comment ${index} :
Author : ${comment.author.login}
Body: ${comment.body}
`;
			}
		}
		if (issueOrPullRequest instanceof PullRequestModel) {
			const fileChanges = issueOrPullRequest.fileChanges;
			for (const [file, fileChange] of fileChanges) {
				if (fileChange instanceof InMemFileChange) {
					issueOrPullRequestInfo += `
Patch for file ${file} :
${fileChange.patch}
`;
				}
			}
		}
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