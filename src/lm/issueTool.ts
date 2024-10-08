/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { RepositoriesManager } from '../github/repositoriesManager';

interface IssueToolParameters {
	issueNumber: number;
	repo: {
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
		return {
			'text/plain': JSON.stringify(result)
		};
	}

}