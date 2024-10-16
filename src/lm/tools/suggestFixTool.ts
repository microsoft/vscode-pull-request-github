/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { IssueResult, IssueToolParameters } from './toolsUtils';

export class SuggestFixTool implements vscode.LanguageModelTool<IssueToolParameters> {
	constructor(private readonly repositoriesManager: RepositoriesManager) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IssueToolParameters>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const folderManager = this.repositoriesManager.getManagerForRepository(options.parameters.repo.owner, options.parameters.repo.name);
		if (!folderManager) {
			throw new Error(`No folder manager found for ${options.parameters.repo.owner}/${options.parameters.repo.name}. Make sure to have the repository open.`);
		}
		const issue = await folderManager.resolveIssue(options.parameters.repo.owner, options.parameters.repo.name, options.parameters.issueNumber, true);
		if (!issue) {
			throw new Error(`No issue found for ${options.parameters.repo.owner}/${options.parameters.repo.name}/${options.parameters.issueNumber}. Make sure the issue exists.`);
		}

		const result: IssueResult = {
			title: issue.title,
			body: issue.body,
			comments: issue.item.comments?.map(c => ({ body: c.body })) ?? []
		};

		const messages: vscode.LanguageModelChatMessage[] = [];
		messages.push(vscode.LanguageModelChatMessage.Assistant(`You are a world-class developer who is capable of solving very difficult bugs and issues.`));
		messages.push(vscode.LanguageModelChatMessage.Assistant(`The user will give you an issue title, body and a list of comments from GitHub. The user wants you to suggest a fix.`));
		messages.push(vscode.LanguageModelChatMessage.Assistant(`Analyze the issue content, the workspace context below and using all this information suggest a fix.`));
		messages.push(vscode.LanguageModelChatMessage.Assistant(`Where possible output code-blocks and reference real files in the workspace with the fix.`));
		messages.push(vscode.LanguageModelChatMessage.User(`The issue content is as follows: `));
		messages.push(vscode.LanguageModelChatMessage.User(`Issue Title: ${result.title}`));
		messages.push(vscode.LanguageModelChatMessage.User(`Issue Body: ${result.body}`));
		result.comments.forEach((comment, index) => {
			messages.push(vscode.LanguageModelChatMessage.User(`Comment ${index}: ${comment.body}`));
		});

		const copilotCodebaseResult = await vscode.lm.invokeTool('copilot_codebase', {
			toolInvocationToken: undefined,
			requestedContentTypes: ['text/plain'],
			parameters: {
				query: result.title
			}
		}, token);

		const plainTextResult = copilotCodebaseResult['text/plain'];
		if (plainTextResult !== undefined) {
			messages.push(vscode.LanguageModelChatMessage.User(`Below is some potential relevant workspace context to the issue. The user cannot see this result, so you should explain it to the user if referencing it in your answer.`));
			const toolMessage = vscode.LanguageModelChatMessage.User('');
			toolMessage.content2 = [plainTextResult];
			messages.push(toolMessage);
		}

		const models = await vscode.lm.selectChatModels({
			vendor: 'copilot',
			family: 'gpt-4o'
		});
		const model = models[0];
		const response = await model.sendRequest(messages, {}, token);

		let responseResult = '';
		for await (const chunk of response.text) {
			responseResult += chunk;
		}
		return {
			'text/plain': responseResult
		};
	}

}