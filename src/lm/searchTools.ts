/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { Issue } from '../github/interface';
import { RepositoriesManager } from '../github/repositoriesManager';
import { concatAsyncIterable } from './tools/toolsUtils';
import Logger from '../common/logger';

interface ConvertToQuerySyntaxParameters {
	plainSearchString: string;
	repo?: {
		owner?: string;
		name?: string;
	};
}

interface ConvertToQuerySyntaxResult {
	query: string;
	repo?: {
		owner?: string;
		name?: string;
	};
}

export class ConvertToSearchSyntaxTool implements vscode.LanguageModelTool<ConvertToQuerySyntaxParameters> {
	static ID = 'ConvertToSearchSyntaxTool';
	constructor(private readonly repositoriesManager: RepositoriesManager) { }

	private async assistantPrompt(folderRepoManager: FolderRepositoryManager): Promise<string> {
		const remote = folderRepoManager.activePullRequest?.remote ?? folderRepoManager.activeIssue?.remote ?? (await folderRepoManager.getPullRequestDefaultRepo()).remote;

		return `Instructions:
You are an expert on GitHub query syntax. You can help the user convert a plain text query to a query that can be used to search GitHub issues. Here are some rules to follow:
- Always try to include "repo:" or "org:" in your response.
- "repo" is often formated as "owner/name". If needed, the current repo is ${remote.owner}/${remote.repositoryName}.
- Respond with only the query.
- Here are some examples of valid queries:
- repo:microsoft/vscode is:issue state:open sort:updated-asc
- mentions:@me org:microsoft is:issue state:open sort:updated
- assignee:@me milestone:"October 2024" is:open is:issue sort:reactions
- comments:>5 org:contoso is:issue state:closed
- interactions:>5 repo:contoso/cli is:issue state:open
- As a reminder, here are the components of the query syntax:
	Filters:
	- is: (issue, pr, draft, public, private, locked, unlocked)
	- assignee:
	- author:
	- mentions:
	- team:
	- commenter:
	- involves:
	- label:
	- type: (pr, issue)
	- state: (open, closed, merged)
	- in: (title, body, comments)
	- user:
	- org: (owner)
	- repo: (name)
	- linked: (pr, issue)
	- milestone:
	- project:
	- status: (success, failure, pending)
	- head:
	- base:
	- comments: (n)
	- interactions: (n)
	- reactions: (n)
	- draft: (true, false)
	- review: (none, required, approved, changes_requested)
	- reviewed-by:
	- review-requested:
	- user-review-requested:
	- team-review-requested:
	- created:
	- updated:
	- closed:
	- no: (label, milestone, assignee, project)
	- sort:

	Value Qualifiers:
	- >n
	- >=n
	- <n
	- <=n
	- n..*
	- *..n
	- n..n
	- YYYY-MM-DD

	Logical Operators:
	- -

	Special Values:
	- @me

	Sort Values:
	- interactions
	- interactions-asc
	- reactions
	- reactions-asc
	- reactions- (+1, -1, smile, tada, heart)
	- author-date
	- author-date-asc
	- committer-date
	- committer-date-asc
	- updated
	- updated-asc
`;
	}

	private userPrompt(originalUserPrompt: string): string {
		const date = new Date();
		return `Pretend today's date is ${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}, but only include it if needed. How should this be converted to a GitHub issue search query? ${originalUserPrompt}`;
	}

	private postProcess(result: string): ConvertToQuerySyntaxResult | undefined {
		const query = this.findQuery(result);
		if (!query) {
			return;
		}
		const fixedRepo = this.fixRepo(query);
		return fixedRepo;
	}

	private fixRepo(initialQuery: string): ConvertToQuerySyntaxResult {
		const repoRegex = /repo:([^ ]+)/;
		const orgRegex = /org:([^ ]+)/;
		const repoMatch = initialQuery.match(repoRegex);
		const orgMatch = initialQuery.match(orgRegex);
		let newQuery = initialQuery.trim();
		let owner: string | undefined;
		let name: string | undefined;
		if (repoMatch) {
			const originalRepo = repoMatch[1];
			if (originalRepo.includes('/')) {
				const ownerAndRepo = originalRepo.split('/');
				owner = ownerAndRepo[0];
				name = ownerAndRepo[1];
			}

			if (orgMatch && originalRepo.includes('/')) {
				// remove the org match
				newQuery = initialQuery.replace(orgRegex, '');
			} else if (orgMatch) {
				// We need to add the org into the repo
				newQuery = initialQuery.replace(repoRegex, `repo:${orgMatch[1]}/${originalRepo}`);
				owner = orgMatch[1];
				name = originalRepo;
			}
		}
		return {
			query: newQuery,
			repo: owner && name ? { owner, name } : undefined
		};
	}

	private findQuery(result: string): string | undefined {
		// if there's a code block, then that's all we take
		if (result.includes('```')) {
			const start = result.indexOf('```');
			const end = result.indexOf('```', start + 3);
			return result.substring(start + 3, end);
		}
		// if it's only one line, we take that
		const lines = result.split('\n');
		if (lines.length <= 1) {
			return lines.length === 0 ? result : lines[0];
		}
		// if there are multiple lines, we take the first line that has a colon
		for (const line of lines) {
			if (line.includes(':')) {
				return line;
			}
		}
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ConvertToQuerySyntaxParameters>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		let owner: string | undefined;
		let name: string | undefined;
		let folderManager: FolderRepositoryManager | undefined;
		// The llm likes to make up an owner and name if it isn't provided one, and they tend to include 'owner' and 'name' respectively
		if (options.parameters.repo && options.parameters.repo.owner && options.parameters.repo.name && !options.parameters.repo.owner.includes('owner') && !options.parameters.repo.name.includes('name')) {
			owner = options.parameters.repo.owner;
			name = options.parameters.repo.name;
			folderManager = this.repositoriesManager.getManagerForRepository(options.parameters.repo.owner, options.parameters.repo.name);
		} else if (this.repositoriesManager.folderManagers.length > 0) {
			folderManager = this.repositoriesManager.folderManagers[0];
			owner = folderManager.gitHubRepositories[0].remote.owner;
			name = folderManager.gitHubRepositories[0].remote.repositoryName;
		}
		if (!folderManager || !owner || !name) {
			throw new Error(`No folder manager found for ${owner}/${name}. Make sure to have a repository open.`);
		}

		const models = await vscode.lm.selectChatModels({
			vendor: 'copilot',
			family: 'gpt-4o'
		});
		const model = models[0];
		const chatOptions: vscode.LanguageModelChatRequestOptions = {
			justification: 'Answering user questions pertaining to GitHub.'
		};
		const messages = [vscode.LanguageModelChatMessage.Assistant(await this.assistantPrompt(folderManager))];
		messages.push(vscode.LanguageModelChatMessage.User(this.userPrompt(options.parameters.plainSearchString)));
		const response = await model.sendRequest(messages, chatOptions, token);
		const result = this.postProcess(await concatAsyncIterable(response.text));
		if (!result) {
			throw new Error('Unable to form a query.');
		}
		Logger.debug(`Query \`${result.query}\``, ConvertToSearchSyntaxTool.ID);
		return {
			'text/plain': result.query,
			'text/display': `Using query \`${result.query}\``
		};
	}
}

type SearchToolParameters = ConvertToQuerySyntaxResult;

export interface SearchToolResult {
	arrayOfIssues: Issue[];
}

export class SearchTool implements vscode.LanguageModelTool<SearchToolParameters> {
	static ID = 'SearchTool';
	constructor(private readonly repositoriesManager: RepositoriesManager) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<SearchToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		Logger.debug(`Searching with query \`${options.parameters.query}\``, SearchTool.ID);
		let owner: string | undefined;
		let name: string | undefined;
		let folderManager: FolderRepositoryManager | undefined;
		// The llm likes to make up an owner and name if it isn't provided one, and they tend to include 'owner' and 'name' respectively
		if (options.parameters.repo && options.parameters.repo.owner && options.parameters.repo.name && !options.parameters.repo.owner.includes('owner') && !options.parameters.repo.name.includes('name')) {
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
		const searchResult = await folderManager.getIssues(options.parameters.query);
		if (!searchResult) {
			throw new Error(`No issues found for ${options.parameters.query}. Make sure the query is valid.`);
		}
		const result: SearchToolResult = {
			arrayOfIssues: searchResult.items.map(i => i.item)
		};
		Logger.debug(`Found ${result.arrayOfIssues.length} issues, first issue ${result.arrayOfIssues[0]?.number}.`, SearchTool.ID);
		return {
			'text/plain': `Here are the issues I found for the query ${options.parameters.query} in a stringified json format. You can pass these to a tool that can display them.`,
			'text/json': result
		};
	}
}