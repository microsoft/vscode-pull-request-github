/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { ILabel, Issue } from '../github/interface';
import { RepositoriesManager } from '../github/repositoriesManager';
import { ChatParticipantState } from './participants';
import { concatAsyncIterable, ToolBase } from './tools/toolsUtils';

interface ConvertToQuerySyntaxParameters {
	naturalLanguageString: string;
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

export class ConvertToSearchSyntaxTool extends ToolBase<ConvertToQuerySyntaxParameters> {
	static ID = 'ConvertToSearchSyntaxTool';
	constructor(private readonly repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
		super(chatParticipantState);
	}

	private async fullQueryAssistantPrompt(folderRepoManager: FolderRepositoryManager): Promise<string> {
		const remote = folderRepoManager.activePullRequest?.remote ?? folderRepoManager.activeIssue?.remote ?? (await folderRepoManager.getPullRequestDefaultRepo()).remote;

		return `Instructions:
You are an expert on GitHub issue search syntax. GitHub issues are always software engineering related. You can help the user convert a natural language query to a query that can be used to search GitHub issues. Here are some rules to follow:
- Always try to include "repo:" or "org:" in your response.
- "repo" is often formated as "owner/name". If needed, the current repo is ${remote.owner}/${remote.repositoryName}.
- Ignore display information.
- Respond with only the query.
- Always include a "sort:" parameter.
- Unless the user indicates "all issues", only include open issues.
- Here are some examples of valid queries:
	- repo:microsoft/vscode is:issue state:open sort:updated-asc
	- mentions:@me org:microsoft is:issue state:open sort:updated
	- assignee:@me milestone:"October 2024" is:open is:issue sort:reactions
	- comments:>5 org:contoso is:issue state:closed mentions:@me label:bug
	- interactions:>5 repo:contoso/cli is:issue state:open
- Go through each word of the natural language query and try to match it to a syntax component.
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

	private async labelsAssistantPrompt(folderRepoManager: FolderRepositoryManager, labels: ILabel[]): Promise<string> {
		// It seems that AND and OR aren't supported in GraphQL, so we can't use them in the query
		// Here's the prompt in case we switch to REST:
		//- Use as many labels as you think fit the query. If one label fits, then there are probably more that fit.
		// - Respond with a list of labels in github search syntax, separated by AND or OR. Examples: "label:bug OR label:polish", "label:accessibility AND label:editor-accessibility"
		return `Instructions:
You are an expert on choosing search keywords based on a natural language search query. Here are some rules to follow:
- Choose labels based on what the user wants to search for, not based on the actual words in the query.
- Labels will be and-ed together, so don't pick a bunch of super specific labels.
- Respond with a space-separated list of labels: Examples: 'bug polish', 'accessibility "feature accessibility"'
- Only choose labels that you're sure are relevant. Having no labels is preferable than lables that aren't relevant.
- Respond with labels chosen from these options:
${labels.map(label => label.name).filter(label => !label.includes('required') && !label.includes('search') && !label.includes('question') && !label.includes('find')).join(', ')}
`;
	}

	private labelsUserPrompt(originalUserPrompt: string): string {
		return `The following labels are most appropriate for "${originalUserPrompt}":`;
	}

	private fullQueryUserPrompt(originalUserPrompt: string): string {
		const date = new Date();
		return `Pretend today's date is ${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}, but only include it if needed. How should this be converted to a GitHub issue search query? ${originalUserPrompt}`;
	}

	private validateLabelsList(labelsList: string, allLabels: ILabel[]): string {
		// I wrote everything for AND and OR, but it isn't supported with GraphQL.
		// Leaving it in for now in case we switch to REST.
		const isAndOrOr = (labelOrOperator: string) => {
			return labelOrOperator === 'AND' || labelOrOperator === 'OR';
		};

		const labelsAndOperators = labelsList.split(' ').map(label => label.trim());
		let goodLabels: string[] = [];
		for (let labelOrOperator of labelsAndOperators) {
			if (isAndOrOr(labelOrOperator)) {
				if (goodLabels.length === 0) {
					continue;
				} else if (goodLabels.length > 0 && isAndOrOr(goodLabels[goodLabels.length - 1])) {
					goodLabels[goodLabels.length - 1] = labelOrOperator;
				} else {
					goodLabels.push(labelOrOperator);
				}
				continue;
			}
			// Make sure it does start with `label:`
			const labelPrefixRegex = /^label:([^ ]+)/;
			const labelPrefixMatch = labelOrOperator.match(labelPrefixRegex);
			let label = labelOrOperator;
			if (labelPrefixMatch) {
				label = labelPrefixMatch[1];
			}
			if (allLabels.find(l => l.name === label)) {
				goodLabels.push(`label:${label}`);
			}
		}
		if (goodLabels.length > 0 && isAndOrOr(goodLabels[goodLabels.length - 1])) {
			goodLabels = goodLabels.slice(0, goodLabels.length - 1);
		}
		return goodLabels.join(' ');
	}

	private processInLabelsPart(query: string, labelsList: string, allLabels: ILabel[]) {
		const validLables = this.validateLabelsList(labelsList, allLabels);
		if (validLables.length === 0) {
			return query;
		}
		// Remove all labels from the query
		query = query.replace(/\slabel:([^ ]+)/g, '');
		// Add the valid labels back
		query = `${query} ${validLables}`;
		return query;
	}

	private postProcess(queryPart: string, labelsList: string, allLabels: ILabel[]): ConvertToQuerySyntaxResult | undefined {
		const query = this.findQuery(queryPart);
		if (!query) {
			return;
		}
		const fixedLabels = this.processInLabelsPart(query, labelsList, allLabels);
		const fixedRepo = this.fixRepo(fixedLabels);
		return fixedRepo;
	}

	private fixRepo(query: string): ConvertToQuerySyntaxResult {
		const repoRegex = /repo:([^ ]+)/;
		const orgRegex = /org:([^ ]+)/;
		const repoMatch = query.match(repoRegex);
		const orgMatch = query.match(orgRegex);
		let newQuery = query.trim();
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
				newQuery = query.replace(orgRegex, '');
			} else if (orgMatch) {
				// We need to add the org into the repo
				newQuery = query.replace(repoRegex, `repo:${orgMatch[1]}/${originalRepo}`);
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

	private async generateLabelQuery(folderManager: FolderRepositoryManager, labels: ILabel[], chatOptions: vscode.LanguageModelChatRequestOptions, model: vscode.LanguageModelChat, naturalLanguageString: string, token: vscode.CancellationToken): Promise<string> {
		const messages = [vscode.LanguageModelChatMessage.Assistant(await this.labelsAssistantPrompt(folderManager, labels))];
		messages.push(vscode.LanguageModelChatMessage.User(this.labelsUserPrompt(naturalLanguageString)));
		const response = await model.sendRequest(messages, chatOptions, token);
		return concatAsyncIterable(response.text);
	}

	private async generateQuery(folderManager: FolderRepositoryManager, chatOptions: vscode.LanguageModelChatRequestOptions, model: vscode.LanguageModelChat, naturalLanguageString: string, token: vscode.CancellationToken): Promise<string> {
		const messages = [vscode.LanguageModelChatMessage.Assistant(await this.fullQueryAssistantPrompt(folderManager))];
		messages.push(vscode.LanguageModelChatMessage.User(this.fullQueryUserPrompt(naturalLanguageString)));
		const response = await model.sendRequest(messages, chatOptions, token);
		return concatAsyncIterable(response.text);
	}

	private toGitHubUrl(query: string) {
		return `https://github.com/issues/?q=${encodeURIComponent(query)}`;
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ConvertToQuerySyntaxParameters>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		let owner: string | undefined;
		let name: string | undefined;
		let folderManager: FolderRepositoryManager | undefined;
		const firstUserMessage = this.chatParticipantState.firstUserMessage ?? options.parameters.naturalLanguageString;
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

		const labels = await folderManager.getLabels(undefined, { owner, repo: name });

		const models = await vscode.lm.selectChatModels({
			vendor: 'copilot',
			family: 'gpt-4o'
		});
		const model = models[0];
		const chatOptions: vscode.LanguageModelChatRequestOptions = {
			justification: 'Answering user questions pertaining to GitHub.'
		};
		const [query, labelsList] = await Promise.all([this.generateQuery(folderManager, chatOptions, model, firstUserMessage, token), this.generateLabelQuery(folderManager, labels, chatOptions, model, firstUserMessage, token)]);

		const result = this.postProcess(query, labelsList, labels);
		if (!result) {
			throw new Error('Unable to form a query.');
		}
		Logger.debug(`Query \`${result.query}\``, ConvertToSearchSyntaxTool.ID);
		return {
			'text/plain': result.query,
			'text/display': `Using query \`${result.query}\`. [Open on GitHub.com](${this.toGitHubUrl(result.query)})`,
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