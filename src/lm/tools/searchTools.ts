/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import Logger from '../../common/logger';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { ILabel } from '../../github/interface';
import { concatAsyncIterable, RepoToolBase } from './toolsUtils';

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

const githubSearchSyntax = {
	is: { possibleValues: ['issue', 'pr', 'draft', 'public', 'private', 'locked', 'unlocked'] },
	assignee: { valueDescription: 'A GitHub user name or @me' },
	author: { valueDescription: 'A GitHub user name or @me' },
	mentions: { valueDescription: 'A GitHub user name or @me' },
	team: { valueDescription: 'A GitHub user name' },
	commenter: { valueDescription: 'A GitHub user name or @me' },
	involves: { valueDescription: 'A GitHub user name or @me' },
	label: { valueDescription: 'A GitHub issue/pr label' },
	type: { possibleValues: ['pr', 'issue'] },
	state: { possibleValues: ['open', 'closed', 'merged'] },
	in: { possibleValues: ['title', 'body', 'comments'] },
	user: { valueDescription: 'A GitHub user name or @me' },
	org: { valueDescription: 'A GitHub org, without the repo name' },
	repo: { valueDescription: 'A GitHub repo, without the org name' },
	linked: { possibleValues: ['pr', 'issue'] },
	milestone: { valueDescription: 'A GitHub milestone' },
	project: { valueDescription: 'A GitHub project' },
	status: { possibleValues: ['success', 'failure', 'pending'] },
	head: { valueDescription: 'A git commit sha or branch name' },
	base: { valueDescription: 'A git commit sha or branch name' },
	comments: { valueDescription: 'A number' },
	interactions: { valueDescription: 'A number' },
	reactions: { valueDescription: 'A number' },
	draft: { possibleValues: ['true', 'false'] },
	review: { possibleValues: ['none', 'required', 'approved', 'changes_requested'] },
	reviewedBy: { valueDescription: 'A GitHub user name or @me' },
	reviewRequested: { valueDescription: 'A GitHub user name or @me' },
	userReviewRequested: { valueDescription: 'A GitHub user name or @me' },
	teamReviewRequested: { valueDescription: 'A GitHub user name' },
	created: { valueDescription: 'A date, with an optional < >' },
	updated: { valueDescription: 'A date, with an optional < >' },
	closed: { valueDescription: 'A date, with an optional < >' },
	no: { possibleValues: ['label', 'milestone', 'assignee', 'project'] },
	sort: { possibleValues: ['updated', 'updated-asc', 'interactions', 'interactions-asc', 'author-date', 'author-date-asc', 'committer-date', 'committer-date-asc', 'reactions', 'reactions-asc', 'reactions-(+1, -1, smile, tada, heart)'] }
};

const MATCH_UNQUOTED_SPACES = /(?!\B"[^"]*)\s+(?![^"]*"\B)/;

export class ConvertToSearchSyntaxTool extends RepoToolBase<ConvertToQuerySyntaxParameters> {
	public static readonly toolId = 'github-pull-request_formSearchQuery';
	static ID = 'ConvertToSearchSyntaxTool';

	private async fullQueryAssistantPrompt(folderRepoManager: FolderRepositoryManager): Promise<string> {
		const remote = folderRepoManager.activePullRequest?.remote ?? folderRepoManager.activeIssue?.remote ?? (await folderRepoManager.getPullRequestDefaultRepo()).remote;

		return `Instructions:
You are an expert on GitHub issue search syntax. GitHub issues are always software engineering related. You can help the user convert a natural language query to a query that can be used to search GitHub issues. Here are some rules to follow:
- Always try to include "repo:" or "org:" in your response.
- "repo" is often formated as "owner/name". If needed, the current repo is ${remote.owner}/${remote.repositoryName}.
- Ignore display information.
- Respond with only the query.
- Always include a "sort:" parameter. If multiple sorts are possible, choose the one that the user requested.
- Always include a property with the @me value if the query includes "me" or "my".
- Here are some examples of valid queries:
	- repo:microsoft/vscode is:issue state:open sort:updated-asc
	- mentions:@me org:microsoft is:issue state:open sort:updated
	- assignee:@me milestone:"October 2024" is:open is:issue sort:reactions
	- comments:>5 org:contoso is:issue state:closed mentions:@me label:bug
	- interactions:>5 repo:contoso/cli is:issue state:open
	- repo:microsoft/vscode-python is:issue sort:updated -assignee:@me
	- repo:contoso/cli is:issue sort:updated no:milestone
- Go through each word of the natural language query and try to match it to a syntax component.
- Use a "-" in front of a syntax component to indicate that it should be "not-ed".
- Use the "no" syntax component to indicate that a property should be empty.
- As a reminder, here are the components of the query syntax:
	${JSON.stringify(githubSearchSyntax)}
`;
	}

	private async labelsAssistantPrompt(folderRepoManager: FolderRepositoryManager, labels: ILabel[]): Promise<string> {
		// It seems that AND and OR aren't supported in GraphQL, so we can't use them in the query
		// Here's the prompt in case we switch to REST:
		// - Use as many labels as you think fit the query. If one label fits, then there are probably more that fit.
		// - Respond with a list of labels in github search syntax, separated by AND or OR. Examples: "label:bug OR label:polish", "label:accessibility AND label:editor-accessibility"
		return `Instructions:
You are an expert on choosing search keywords based on a natural language search query. Here are some rules to follow:
- Choose labels based on what the user wants to search for, not based on the actual words in the query.
- The user might include info on how they want their search results to be displayed. Ignore all of that.
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
- Don't include any key words that might be related to display or rendering.
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
		// useless strings to search for
		if (freeForm.includes('issue') || freeForm.match(MATCH_UNQUOTED_SPACES)) {
			return '';
		}
		if (baseQuery.includes(freeForm)) {
			return '';
		}
		if (labels.includes(freeForm)) {
			return '';
		}
		if (labels.some(label => freeForm.includes(label) || label.includes(freeForm))) {
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
				const hasMinus = propAndVal[0].startsWith('-');
				const label = hasMinus ? propAndVal[0].substring(1) : propAndVal[0];
				const value = propAndVal[1];
				if (!label.match(/^[a-zA-Z]+$/)) {
					continue;
				}
				if (!this.validateSpecificQueryPart(label, value)) {
					continue;
				}
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

	async prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<ConvertToQuerySyntaxParameters>): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Converting to search syntax')
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ConvertToQuerySyntaxParameters>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const { owner, name, folderManager } = await this.getRepoInfo({ owner: options.parameters.repo?.owner, name: options.parameters.repo?.name });
		const firstUserMessage = `${this.chatParticipantState.firstUserMessage?.value}, ${options.parameters.naturalLanguageString}`;

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
		const json: ConvertToQuerySyntaxResult = {
			query: result.query,
			repo: {
				owner,
				name
			}
		};
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(json)),
		new vscode.LanguageModelTextPart('Above is the query in stringified json format. You can pass this VERBATIM to a tool that knows how to search.')]);
	}
}

type SearchToolParameters = ConvertToQuerySyntaxResult;

export interface IssueSearchResultAccount {
	login: string;
	url: string;
}

interface IssueSearchResultLabel {
	name: string;
	color: string;
}

export interface IssueSearchResultItem {
	title: string;
	url: string;
	number: number;
	labels: IssueSearchResultLabel[];
	state: string;
	assignees: IssueSearchResultAccount[] | undefined;
	createdAt: string;
	updatedAt: string;
	author: IssueSearchResultAccount;
	milestone: string | undefined;
	commentCount: number;
	reactionCount: number;
}

export interface SearchToolResult {
	arrayOfIssues: IssueSearchResultItem[];
	totalIssues: number;
}

export class SearchTool extends RepoToolBase<SearchToolParameters> {
	public static readonly toolId = 'github-pull-request_doSearch';
	static ID = 'SearchTool';


	private toGitHubUrl(query: string) {
		return `https://github.com/issues/?q=${encodeURIComponent(query)}`;
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SearchToolParameters>): Promise<vscode.PreparedToolInvocation> {
		const parameterQuery = options.parameters.query;

		return {
			invocationMessage: vscode.l10n.t('Searching for issues with "{0}". [Open on GitHub.com]({1})', parameterQuery, this.toGitHubUrl(parameterQuery))
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<SearchToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const { folderManager } = await this.getRepoInfo({ owner: options.parameters.repo?.owner, name: options.parameters.repo?.name });

		const parameterQuery = options.parameters.query;
		Logger.debug(`Searching with query \`${parameterQuery}\``, SearchTool.ID);

		const searchResult = await folderManager.getIssues(parameterQuery);
		if (!searchResult) {
			throw new Error(`No issues found for ${parameterQuery}. Make sure the query is valid.`);
		}
		const cutoff = 20;
		const result: SearchToolResult = {
			arrayOfIssues: searchResult.items.slice(0, cutoff).map(i => {
				const item = i.item;
				return {
					title: item.title,
					url: item.url,
					number: item.number,
					labels: item.labels.map(l => ({ name: l.name, color: l.color })),
					state: item.state,
					assignees: item.assignees?.map(a => ({ login: a.login, url: a.url })),
					createdAt: item.createdAt,
					updatedAt: item.updatedAt,
					author: { login: item.user.login, url: item.user.url },
					milestone: item.milestone?.title,
					commentCount: item.commentCount,
					reactionCount: item.reactionCount
				};
			}),
			totalIssues: searchResult.totalCount ?? searchResult.items.length
		};
		Logger.debug(`Found ${result.totalIssues} issues, first issue ${result.arrayOfIssues[0]?.number}.`, SearchTool.ID);

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result)),
		new vscode.LanguageModelTextPart(`Above are the issues I found for the query ${parameterQuery} in json format. You can pass these to a tool that can display them.`)]);
	}
}