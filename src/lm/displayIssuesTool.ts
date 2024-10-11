/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { Issue } from '../github/interface';
import { ChatParticipantState } from './participants';
import { SearchToolResult } from './searchTools';
import { concatAsyncIterable, ToolBase } from './tools/toolsUtils';

export type DisplayIssuesParameters = SearchToolResult;

const LLM_FIND_IMPORTANT_COLUMNS_INSTRUCTIONS = `Instructions:
You are an expert on GitHub issues. You can help the user identify the most important columns for rendering issues based on a query for issues. Include a column related to the sort value, if given. Output a newline separated list of columns only, max 4 columns. List the columns in the order they should be displayed. Don't change the casing. Here are the possible columns:
`;

export class DisplayIssuesTool extends ToolBase<DisplayIssuesParameters> {
	static ID = 'DisplayIssuesTool';
	constructor(chatParticipantState: ChatParticipantState) {
		super(chatParticipantState);
	}

	private assistantPrompt(issues: Issue[]): string {
		const possibleColumns = Object.keys(issues[0]);
		return `${LLM_FIND_IMPORTANT_COLUMNS_INSTRUCTIONS}\n${possibleColumns.map(column => `- ${column}`).join('\n')}\nHere's the data you have about the issues:\n`;
	}

	private postProcess(output: string, issues: Issue[]): string[] {
		const lines = output.split('\n');
		const possibleColumns = Object.keys(issues[0]);
		const finalColumns: string[] = [];
		for (const line of lines) {
			if (line === '') {
				continue;
			}
			if (!possibleColumns.includes(line)) {
				// Check if the llm decided to use formatting, even though we asked it not to
				const splitOnSpace = line.split(' ');
				if (splitOnSpace.length > 1) {
					const testColumn = splitOnSpace[splitOnSpace.length - 1];
					if (possibleColumns.includes(testColumn)) {
						finalColumns.push(testColumn);
					}
				}
			} else {
				finalColumns.push(line);
			}
		}
		const indexOfId = finalColumns.indexOf('id');
		if (indexOfId !== -1) {
			finalColumns[indexOfId] = 'number';
		}
		return finalColumns;
	}

	private async getImportantColumns(issueItemsInfo: string, issues: Issue[], token: vscode.CancellationToken): Promise<string[]> {
		// Try to get the llm to tell us which columns are important based on information it has about the issues
		const models = await vscode.lm.selectChatModels({
			vendor: 'copilot',
			family: 'gpt-4o'
		});
		const model = models[0];
		const chatOptions: vscode.LanguageModelChatRequestOptions = {
			justification: 'Answering user questions pertaining to GitHub.'
		};
		const messages = [vscode.LanguageModelChatMessage.Assistant(this.assistantPrompt(issues))];
		messages.push(vscode.LanguageModelChatMessage.User(issueItemsInfo));
		const response = await model.sendRequest(messages, chatOptions, token);
		const result = this.postProcess(await concatAsyncIterable(response.text), issues);
		if (result.length === 0) {
			return ['number', 'title', 'state'];
		}

		return result;
	}

	private issueToRow(issue: Issue, importantColumns: string[]): string {
		return `| ${importantColumns.map(column => {
			if (column === 'number') {
				return `[${issue[column]}](${issue.url})`;
			} else {
				return issue[column];
			}
		}).join(' | ')} |`;
	}

	async invoke(_options: vscode.LanguageModelToolInvocationOptions<DisplayIssuesParameters>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		// The llm won't actually pass the output of the search tool to this tool, so we need to get the issues from the last message
		let issueItems: Issue[] = []; // = (typeof options.parameters.arrayOfIssues === 'string') ? JSON.parse(options.parameters.arrayOfIssues) : options.parameters.arrayOfIssues;
		let issueItemsInfo: string = '';
		const lastMessage = this.chatParticipantState.lastToolResult;
		if (lastMessage) {
			try {
				for (const part of lastMessage) {
					if (part instanceof vscode.LanguageModelToolResultPart) {
						const issues = JSON.parse(part.content) as SearchToolResult;
						if (Array.isArray(issues.arrayOfIssues)) {
							issueItems = issues.arrayOfIssues;
						}
					} else if (typeof part === 'string') {
						issueItemsInfo += part;
					}
				}
			} catch {
				// ignore, the data doesn't exist
			}
		}
		if (issueItems.length === 0) {
			return {
				'text/plain': 'No issues found. Please try another query.',
				'text/markdown': 'No issues found. Please try another query.'
			};
		}
		Logger.debug(`Displaying ${issueItems.length} issues, first issue ${issueItems[0].number}`, DisplayIssuesTool.ID);
		const importantColumns = await this.getImportantColumns(issueItemsInfo, issueItems, token);

		const titleRow = `| ${importantColumns.join(' | ')} |`;
		Logger.debug(`Columns ${titleRow} issues`, DisplayIssuesTool.ID);
		const separatorRow = `| ${importantColumns.map(() => '---').join(' | ')} |`;
		const issues = new vscode.MarkdownString(titleRow);
		issues.appendMarkdown('\n');
		issues.appendMarkdown(separatorRow);
		issues.appendMarkdown(issueItems.slice(0, 10).map(issue => {
			return this.issueToRow(issue, importantColumns);
		}).join('\n'));

		return {
			'text/plain': 'Here is a markdown table of the first 10 issues. The user needs you to show it to them.',
			'text/markdown': issues.value
		};
	}

}