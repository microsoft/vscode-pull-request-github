/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { IssueModel } from '../../github/issueModel';
import { PullRequestModel } from '../../github/pullRequestModel';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MimeTypes } from './toolsUtils';

interface FetchToolParameters {
	issueNumber: number;
	repo?: {
		owner: string;
		name: string;
	};
}

interface FetchResult {
	title: string;
	body: string;
	comments: {
		body: string;
	}[];
}

export class FetchTool implements vscode.LanguageModelTool<FetchToolParameters> {
	constructor(private readonly repositoriesManager: RepositoriesManager) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<FetchToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const issueOrPullRequest = await this._fetchIssueOrPR(options, this.repositoriesManager);
		const result: FetchResult = {
			title: issueOrPullRequest.title,
			body: issueOrPullRequest.body,
			comments: issueOrPullRequest.item.comments?.map(c => ({ body: c.body })) ?? []
		};
		return {
			[MimeTypes.textPlain]: JSON.stringify(result)
		};
	}

	private async _fetchIssueOrPR(options: vscode.LanguageModelToolInvocationOptions<FetchToolParameters>, repositoriesManager: RepositoriesManager): Promise<PullRequestModel | IssueModel> {
		let owner: string | undefined;
		let name: string | undefined;
		let folderManager: FolderRepositoryManager | undefined;
		// The llm likes to make up an owner and name if it isn't provided one, and they tend to include 'owner' and 'name' respectively
		if (options.parameters.repo && !options.parameters.repo.owner.includes('owner') && !options.parameters.repo.name.includes('name')) {
			owner = options.parameters.repo.owner;
			name = options.parameters.repo.name;
			folderManager = repositoriesManager.getManagerForRepository(options.parameters.repo.owner, options.parameters.repo.name);
		} else if (repositoriesManager.folderManagers.length > 0) {
			folderManager = repositoriesManager.folderManagers[0];
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
		return issueOrPullRequest;
	}
}