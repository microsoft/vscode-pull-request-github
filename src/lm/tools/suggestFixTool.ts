/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { CredentialStore } from '../../github/credentials';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { ChatParticipantState } from '../participants';
import { IssueResult, IssueToolParameters, RepoToolBase } from './toolsUtils';

export class SuggestFixTool extends RepoToolBase<IssueToolParameters> {
	public static readonly toolId = 'github-pull-request_suggest-fix';

	constructor(credentialStore: CredentialStore, repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
		super(credentialStore, repositoriesManager, chatParticipantState);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IssueToolParameters>): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: options.input.issueNumber ? vscode.l10n.t('Suggesting a fix for issue #{0}', options.input.issueNumber) : vscode.l10n.t('Suggesting a fix for the issue')
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IssueToolParameters>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const repo = options.input.repo;
		const owner = repo?.owner;
		const name = repo?.name;
		const issueNumber = options.input.issueNumber;
		if (!repo || !owner || !name || !issueNumber) {
			return undefined;
		}
		const { folderManager } = await this.getRepoInfo(repo);
		if (!folderManager) {
			throw new Error(`No folder manager found for ${repo.owner}/${repo.name}. Make sure to have the repository open.`);
		}
		const issue = await folderManager.resolveIssue(owner, name, issueNumber, true);
		if (!issue) {
			throw new Error(`No issue found for ${repo.owner}/${repo.name}/${options.input.issueNumber}. Make sure the issue exists.`);
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
			input: {
				query: result.title
			}
		}, token);

		const plainTextResult = copilotCodebaseResult.content[0];
		if (plainTextResult instanceof vscode.LanguageModelTextPart) {
			messages.push(vscode.LanguageModelChatMessage.User(`Below is some potential relevant workspace context to the issue. The user cannot see this result, so you should explain it to the user if referencing it in your answer.`));
			const toolMessage = vscode.LanguageModelChatMessage.User('');
			toolMessage.content = [plainTextResult];
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
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(responseResult)]);
	}


}