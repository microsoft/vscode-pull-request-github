/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { Issue } from '../github/interface';
import { ChatParticipantState } from './participants';
import { SearchToolResult } from './searchTools';
import { ToolBase } from './tools/toolsUtils';

export type DisplayIssuesParameters = SearchToolResult;

export class DisplayIssuesTool extends ToolBase<DisplayIssuesParameters> {
	constructor(chatParticipantState: ChatParticipantState) {
		super(chatParticipantState);
	}

	async invoke(_options: vscode.LanguageModelToolInvocationOptions<DisplayIssuesParameters>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		// The llm won't actually pass the output of the search tool to this tool, so we need to get the issues from the last message
		let issueItems: Issue[] = []; // = (typeof options.parameters.arrayOfIssues === 'string') ? JSON.parse(options.parameters.arrayOfIssues) : options.parameters.arrayOfIssues;
		const lastMessage = this.chatParticipantState.lastToolResult;
		if (lastMessage) {
			try {
				const issues = JSON.parse(lastMessage.content) as SearchToolResult;
				if (Array.isArray(issues.arrayOfIssues)) {
					issueItems = issues.arrayOfIssues;
				}
			} catch {
				// ignore, the data doesn't exist
			}
		}

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