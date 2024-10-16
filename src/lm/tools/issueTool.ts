/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { InMemFileChange } from '../../common/file';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { IssueModel } from '../../github/issueModel';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';
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
		let owner: string | undefined;
		let name: string | undefined;
		let folderManager: FolderRepositoryManager | undefined;
		// The llm likes to make up an owner and name if it isn't provided one, and they tend to include 'owner' and 'name' respectively
		if (options.parameters.repo && !options.parameters.repo.owner.includes('owner') && !options.parameters.repo.name.includes('name')) {
			owner = options.parameters.repo.owner;
			name = options.parameters.repo.name;
			folderManager = this.repositoriesManager.getManagerForRepository(options.parameters.repo.owner, options.parameters.repo.name);
		} else if (this.repositoriesManager.folderManagers.length > 0) {
			folderManager = this.repositoriesManager.folderManagers[0];
			owner = folderManager.gitHubRepositories[0].remote.owner;
			name = folderManager.gitHubRepositories[0].remote.repositoryName;
		}
		if (!folderManager || !owner || !name) {
			throw new Error(`No folder manager found for ${owner}/${name}. Make sure to have the repository open.`);
		}
		let issueOrPullRequest: IssueModel | PullRequestModel | undefined = await folderManager.resolveIssue(owner, name, options.parameters.issueNumber, true);
		if (!issueOrPullRequest) {
			issueOrPullRequest = await folderManager.resolvePullRequest(owner, name, options.parameters.issueNumber);
		}
		if (!issueOrPullRequest) {
			throw new Error(`No issue or PR found for ${owner}/${name}/${options.parameters.issueNumber}. Make sure the issue or PR exists.`);
		}

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
You will be given information relative to an issue or PR. Your task is to output a summary of the information.
`;
}