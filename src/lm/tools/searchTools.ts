/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { RepoToolBase } from './toolsUtils';
import Logger from '../../common/logger';
import { escapeMarkdown } from '../../issues/util';


interface ConvertToQuerySyntaxResult {
	query: string;
	repo?: {
		owner?: string;
		name?: string;
	};
}

type SearchToolParameters = ConvertToQuerySyntaxResult;

export interface IssueSearchResultAccount {
	login?: string;
	url?: string;
}

interface IssueSearchResultLabel {
	name?: string;
	color?: string;
}

export interface IssueSearchResultItem {
	title?: string;
	url?: string;
	number?: number;
	labels?: IssueSearchResultLabel[];
	state?: string;
	assignees?: IssueSearchResultAccount[] | undefined;
	createdAt?: string;
	updatedAt?: string;
	author?: IssueSearchResultAccount;
	milestone?: string | undefined;
	commentCount?: number;
	reactionCount?: number;
}

export interface SearchToolResult {
	arrayOfIssues?: IssueSearchResultItem[];
	totalIssues?: number;
}

export class SearchTool extends RepoToolBase<SearchToolParameters> {
	public static readonly toolId = 'github-pull-request_doSearch';
	static ID = 'SearchTool';


	private toGitHubUrl(query: string) {
		return `https://github.com/issues/?q=${encodeURIComponent(query)}`;
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SearchToolParameters>): Promise<vscode.PreparedToolInvocation> {
		const parameterQuery = options.input.query;
		const message = new vscode.MarkdownString();
		message.appendText(vscode.l10n.t('Searching for issues with "{0}".', parameterQuery));
		message.appendMarkdown(vscode.l10n.t(' [Open on GitHub.com]({0})', escapeMarkdown(this.toGitHubUrl(parameterQuery))));

		return {
			invocationMessage: message
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<SearchToolParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const { folderManager } = await this.getRepoInfo({ owner: options.input.repo?.owner, name: options.input.repo?.name });

		const parameterQuery = options.input.query;
		Logger.debug(`Searching with query \`${parameterQuery}\``, SearchTool.ID);

		const searchResult = await folderManager.getIssues(parameterQuery);
		if (!searchResult) {
			throw new Error(`No issues found for ${parameterQuery}. Make sure the query is valid.`);
		}
		const cutoff = 30;
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
		Logger.debug(`Found ${result.totalIssues} issues, first issue ${result.arrayOfIssues![0]?.number}.`, SearchTool.ID);

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result)),
		new vscode.LanguageModelTextPart(`Above are the issues I found for the query ${parameterQuery} in json format. You can pass these to a tool that can display them, or you can reason over the issues to answer a question.`)]);
	}
}