/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { MimeTypes } from './toolsUtils';

interface IssueToolParameters {
	issueNumber: number;
	repo?: {
		owner: string;
		name: string;
	};
}

interface IssueResult {
	title: string;
	body: string;
	comments: {
		body: string;
	}[];
}

export class IssueTool implements vscode.LanguageModelTool<IssueToolParameters> {
	constructor(private readonly repositoriesManager: RepositoriesManager) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IssueToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
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
		const issue = await folderManager.resolveIssue(owner, name, options.parameters.issueNumber, true);
		if (!issue) {
			throw new Error(`No issue found for ${owner}/${name}/${options.parameters.issueNumber}. Make sure the issue exists.`);
		}
		const result: IssueResult = {
			title: issue.title,
			body: issue.body,
			comments: issue.item.comments?.map(c => ({ body: c.body })) ?? []
		};
		return {
			[MimeTypes.textPlain]: JSON.stringify(result)
		};
	}

}