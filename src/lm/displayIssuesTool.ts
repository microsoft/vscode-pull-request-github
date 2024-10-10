/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { Issue } from '../github/interface';
import { RepositoriesManager } from '../github/repositoriesManager';
import { SearchToolResult } from './searchTools';

export type DisplayIssuesParameters = SearchToolResult;

export class DisplayIssuesTool implements vscode.LanguageModelTool<DisplayIssuesParameters> {
	constructor(private readonly repositoriesManager: RepositoriesManager) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<DisplayIssuesParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const issueItems: Issue[] = (typeof options.parameters.arrayOfIssues === 'string') ? JSON.parse(options.parameters.arrayOfIssues) : options.parameters.arrayOfIssues;
		const titleRow = `| Number | Title | State |\n| --- | --- | --- |\n`;
		const issues = new vscode.MarkdownString(titleRow);
		issues.appendMarkdown(issueItems.slice(0, 10).map(issue => {
			return `| [${issue.number}](${issue.url}) | ${issue.title} | ${issue.state} |`;
		}).join('\n'));

		return {
			'text/plain': 'Here is a markdown table of the first 10 issues: ' + issues.value,
			'text/markdown': issues.value
		};
	}

}