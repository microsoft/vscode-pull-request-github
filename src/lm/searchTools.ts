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

enum ValidatableProperty {
	is = 'is',
	type = 'type',
	state = 'state',
	in = 'in',
	linked = 'linked',
	status = 'status',
	draft = 'draft',
	review = 'review',
	no = 'no',
}

const MATCH_UNQUOTED_SPACES = /(?!\B"[^"]*)\s+(?![^"]*"\B)/;

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
- Always include a property with the @me value if the query includes "me" or "my".
- Here are some examples of valid queries:
	- repo:microsoft/vscode is:issue state:open sort:updated-asc
	- mentions:@me org:microsoft is:issue state:open sort:updated
	- assignee:@me milestone:"October 2024" is:open is:issue sort:reactions
	- comments:>5 org:contoso is:issue state:closed mentions:@me label:bug
	- interactions:>5 repo:contoso/cli is:issue state:open
- Go through each word of the natural language query and try to match it to a syntax component.
- As a reminder, here are the components of the query syntax:
	Filters:
| Property 	| Possible Values | Value Description |
|-----------|-----------------|-------------------|
| is 		| issue, pr, draft, public, private, locked, unlocked |  |
| assignee 	|  | A GitHub user name or @me |
| author 	|  | A GitHub user name or @me |
| mentions 	|  | A GitHub user name or @me |
| team 		|  | A GitHub user name |
| commenter |  | A GitHub user name or @me |
| involves 	|  | A GitHub user name or @me |
| label		|  | A GitHub issue/pr label |
| type 		| pr, issue |  |
| state 	|  open, closed, merged |  |
| in 		| title, body, comments |  |
| user 		|  | A GitHub user name or @me |
| org 		| | A GitHub org, without the repo name |
| repo 		| | A GitHub repo, without the org name |
| linked 	| pr, issue |  |
| milestone |  | A GitHub milestone |
| project 	|  | A GitHub project  |
| status 	| success, failure, pending |  |
| head 		|  | A git commit sha or branch name |
| base 		|  | A git commit sha or branch name |
| comments  | | A number |
| interactions |  | A number |
| reactions |  | A number |
| draft 	| true, false |  |
| review 	| none, required, approved, changes_requested |  |
| reviewed-by |  | A GitHub user name or @me |
| review-requested |  | A GitHub user name or @me |
| user-review-requested |  | A GitHub user name or @me |
| team-review-requested |  | A GitHub user name |
| created 	|  | A date, with an optional < > |
| updated 	|  | A date, with an optional < > |
| closed 	|  | A date, with an optional < > |
| no 		|  label, milestone, assignee, project |  |
| sort 		| updated, updated-asc, interactions, interactions-asc, author-date, author-date-asc, committer-date, committer-date-asc, reactions, reactions-asc, reactions-(+1, -1, smile, tada, heart) |  |

	Logical Operators:
		- -

	Special Values:
		- @me
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
- Try to pick just one label.
- Respond with a space-separated list of labels: Examples: 'bug polish', 'accessibility "feature accessibility"'
- Only choose labels that you're sure are relevant. Having no labels is preferable than lables that aren't relevant.
- Don't choose labels that the user has explicitly excluded.
- Respond with labels chosen from these options:
${labels.map(label => label.name).filter(label => !label.includes('required') && !label.includes('search') && !label.includes('question') && !label.includes('find')).join(', ')}
`;
	}

	private freeFormAssistantPrompt(): string {
		return `Instructions:
You are getting ready to make a GitHub search query. Given a natural language query, you should find any key words that might be good for searching:
- Only include a max of 1 key word that is relevant to the search query.
- Don't refer to issue numbers.
- Don't refer to product names.
- Don't include any key words that might be related to sorting.
- Respond with only your chosen key word.
- It's better to return no keywords than to return irrelevant keywords.
- If an issue is provided, choose a keyword that names the feature or bug that the issue is about.
`;
	}

	private freeFormUserPrompt(originalUserPrompt: string): string {
		return `The best search keywords in "${originalUserPrompt}" are:`;
	}

	private labelsUserPrompt(originalUserPrompt: string): string {
		return `The following labels are most appropriate for "${originalUserPrompt}":`;
	}

	private fullQueryUserPrompt(originalUserPrompt: string): string {
		originalUserPrompt = originalUserPrompt.replace(/\b(me|my)\b/, (value) => value.toUpperCase());
		const date = new Date();
		return `Pretend today's date is ${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}, but only include it if needed. How should this be converted to a GitHub issue search query? ${originalUserPrompt}`;
	}

	private validateSpecificQueryPart(property: ValidatableProperty | string, value: string): boolean {
		switch (property) {
			case ValidatableProperty.is:
				return value === 'issue' || value === 'pr' || value === 'draft' || value === 'public' || value === 'private' || value === 'locked' || value === 'unlocked';
			case ValidatableProperty.type:
				return value === 'pr' || value === 'issue';
			case ValidatableProperty.state:
				return value === 'open' || value === 'closed' || value === 'merged';
			case ValidatableProperty.in:
				return value === 'title' || value === 'body' || value === 'comments';
			case ValidatableProperty.linked:
				return value === 'pr' || value === 'issue';
			case ValidatableProperty.status:
				return value === 'success' || value === 'failure' || value === 'pending';
			case ValidatableProperty.draft:
				return value === 'true' || value === 'false';
			case ValidatableProperty.review:
				return value === 'none' || value === 'required' || value === 'approved' || value === 'changes_requested';
			case ValidatableProperty.no:
				return value === 'label' || value === 'milestone' || value === 'assignee' || value === 'project';
			default:
				return true;
		}
	}

	private validateLabelsList(labelsList: string, allLabels: ILabel[]): string[] {
		// I wrote everything for AND and OR, but it isn't supported with GraphQL.
		// Leaving it in for now in case we switch to REST.
		const isAndOrOr = (labelOrOperator: string) => {
			return labelOrOperator === 'AND' || labelOrOperator === 'OR';
		};

		const labelsAndOperators = labelsList.split(MATCH_UNQUOTED_SPACES).map(label => label.trim());
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
			const labelPrefixRegex = /^label:(?!\B"[^"]*)\s+(?![^"]*"\B)/;
			const labelPrefixMatch = labelOrOperator.match(labelPrefixRegex);
			let label = labelOrOperator;
			if (labelPrefixMatch) {
				label = labelPrefixMatch[1];
			}
			if (allLabels.find(l => l.name === label)) {
				goodLabels.push(label);
			}
		}
		if (goodLabels.length > 0 && isAndOrOr(goodLabels[goodLabels.length - 1])) {
			goodLabels = goodLabels.slice(0, goodLabels.length - 1);
		}
		return goodLabels;
	}

	private validateFreeForm(baseQuery: string, labels: string[], freeForm: string) {
		// Currently, we only allow the free form to return one keyword
		freeForm = freeForm.trim();
		if (baseQuery.includes(freeForm)) {
			return '';
		}
		if (labels.includes(freeForm)) {
			return '';
		}
		if (labels.some(label => freeForm.includes(label))) {
			return '';
		}
		// useless strings to search for
		if (freeForm.includes('issue')) {
			return '';
		}
		return freeForm;
	}

	private validateQuery(query: string, labelsList: string, allLabels: ILabel[], freeForm: string) {
		let reformedQuery = '';
		const queryParts = query.split(MATCH_UNQUOTED_SPACES);
		// Only keep property:value pairs and '-', no reform allowed here.
		for (const part of queryParts) {
			if (part.startsWith('label:')) {
				continue;
			}
			const propAndVal = part.split(':');
			if (propAndVal.length === 2) {
				const label = propAndVal[0];
				const value = propAndVal[1];
				if (!label.match(/^[a-zA-Z]+$/)) {
					continue;
				}
				if (!this.validateSpecificQueryPart(label, value)) {
					continue;
				}
			} else if (!part.startsWith('-')) {
				continue;
			}
			reformedQuery = `${reformedQuery} ${part}`;
		}

		const validLabels = this.validateLabelsList(labelsList, allLabels);
		const validFreeForm = this.validateFreeForm(reformedQuery, validLabels, freeForm);

		reformedQuery = `${reformedQuery} ${validLabels.map(label => `label:${label}`).join(' ')} ${validFreeForm}`;
		return reformedQuery.trim();
	}

	private postProcess(queryPart: string, freeForm: string, labelsList: string, allLabels: ILabel[]): ConvertToQuerySyntaxResult | undefined {
		const query = this.findQuery(queryPart);
		if (!query) {
			return;
		}
		const fixedLabels = this.validateQuery(query, labelsList, allLabels, freeForm);
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

	private async generateFreeFormQuery(folderManager: FolderRepositoryManager, chatOptions: vscode.LanguageModelChatRequestOptions, model: vscode.LanguageModelChat, naturalLanguageString: string, token: vscode.CancellationToken): Promise<string> {
		const messages = [vscode.LanguageModelChatMessage.Assistant(this.freeFormAssistantPrompt())];
		messages.push(vscode.LanguageModelChatMessage.User(this.freeFormUserPrompt(naturalLanguageString)));
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
		const firstUserMessage = `${this.chatParticipantState.firstUserMessage}, ${options.parameters.naturalLanguageString}`;
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
		const [query, freeForm, labelsList] = await Promise.all([this.generateQuery(folderManager, chatOptions, model, firstUserMessage, token), this.generateFreeFormQuery(folderManager, chatOptions, model, firstUserMessage, token), this.generateLabelQuery(folderManager, labels, chatOptions, model, firstUserMessage, token)]);

		const result = this.postProcess(query, freeForm, labelsList, labels);
		if (!result) {
			throw new Error('Unable to form a query.');
		}
		Logger.debug(`Query \`${result.query}\``, ConvertToSearchSyntaxTool.ID);
		return {
			'text/plain': result.query,
			'text/display': `Query \`${result.query}\`. [Open on GitHub.com](${this.toGitHubUrl(result.query)})\n\n`,
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
		const parameterQuery = options.parameters.query;
		Logger.debug(`Searching with query \`${parameterQuery}\``, SearchTool.ID);
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
		const searchResult = await folderManager.getIssues(parameterQuery);
		if (!searchResult) {
			throw new Error(`No issues found for ${parameterQuery}. Make sure the query is valid.`);
		}
		const result: SearchToolResult = {
			arrayOfIssues: searchResult.items.map(i => i.item)
		};
		Logger.debug(`Found ${result.arrayOfIssues.length} issues, first issue ${result.arrayOfIssues[0]?.number}.`, SearchTool.ID);
		return {
			'text/plain': `Here are the issues I found for the query ${parameterQuery} in json format. You can pass these to a tool that can display them.`,
			'text/json': result
		};
	}
}