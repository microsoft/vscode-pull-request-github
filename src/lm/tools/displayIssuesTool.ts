/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import Logger from '../../common/logger';
import { reviewerLabel } from '../../github/interface';
import { makeLabel } from '../../github/utils';
import { ChatParticipantState } from '../participants';
import { IssueSearchResultAccount, IssueSearchResultItem, SearchToolResult } from './searchTools';
import { concatAsyncIterable, MimeTypes, ToolBase } from './toolsUtils';

export type DisplayIssuesParameters = SearchToolResult;

type IssueColumn = keyof IssueSearchResultItem;

const LLM_FIND_IMPORTANT_COLUMNS_INSTRUCTIONS = `Instructions:
You are an expert on GitHub issues. You can help the user identify the most important columns for rendering issues based on a query for issues. Include a column related to the sort value, if given. Output a newline separated list of columns only, max 4 columns. List the columns in the order they should be displayed. Don't change the casing. Here are the possible columns:
`;

export class DisplayIssuesTool extends ToolBase<DisplayIssuesParameters> {
	static ID = 'DisplayIssuesTool';
	constructor(chatParticipantState: ChatParticipantState) {
		super(chatParticipantState);
	}

	private assistantPrompt(issues: IssueSearchResultItem[]): string {
		const possibleColumns = Object.keys(issues[0]);
		return `${LLM_FIND_IMPORTANT_COLUMNS_INSTRUCTIONS}\n${possibleColumns.map(column => `- ${column}`).join('\n')}\nHere's the data you have about the issues:\n`;
	}

	private postProcess(proposedColumns: string, issues: IssueSearchResultItem[]): IssueColumn[] {
		const lines = proposedColumns.split('\n');
		const possibleColumns = Object.keys(issues[0]);
		const finalColumns: IssueColumn[] = [];
		for (let line of lines) {
			line = line.trim();
			if (line === '') {
				continue;
			}
			if (!possibleColumns.includes(line)) {
				// Check if the llm decided to use formatting, even though we asked it not to
				const splitOnSpace = line.split(' ');
				if (splitOnSpace.length > 1) {
					const testColumn = splitOnSpace[splitOnSpace.length - 1];
					if (possibleColumns.includes(testColumn)) {
						finalColumns.push(testColumn as IssueColumn);
					}
				}
			} else {
				finalColumns.push(line as IssueColumn);
			}
		}
		return finalColumns;
	}

	private async getImportantColumns(issueItemsInfo: string, issues: IssueSearchResultItem[], token: vscode.CancellationToken): Promise<IssueColumn[]> {
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
		const indexOfUrl = result.indexOf('url');
		if (result.length === 0) {
			return ['number', 'title', 'state'];
		} else if (indexOfUrl >= 0) {
			// Never include the url column
			result[indexOfUrl] = 'number';
		}

		return result;
	}

	private renderUser(account: IssueSearchResultAccount) {
		return `[@${reviewerLabel(account)}](${account.url})`;
	}

	private issueToRow(issue: IssueSearchResultItem, importantColumns: IssueColumn[]): string {
		return `| ${importantColumns.map(column => {
			switch (column) {
				case 'number':
					return `[${issue[column]}](${issue.url})`;
				case 'labels':
					return issue[column].map((label) => makeLabel(label)).join(', ');
				case 'assignees':
					return issue[column]?.map((assignee) => this.renderUser(assignee)).join(', ');
				case 'author':
					return this.renderUser(issue[column]);
				case 'createdAt':
				case 'updatedAt':
					return new Date(issue[column]).toLocaleDateString();
				case 'milestone':
					return issue[column];
				default:
					return issue[column];
			}
		}).join(' | ')} |`;
	}

	async prepareToolInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<DisplayIssuesParameters>): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Generating markdown table of issues'),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<DisplayIssuesParameters>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		let issueItemsInfo: string = this.chatParticipantState.firstUserMessage ?? '';
		const issueItems: IssueSearchResultItem[] = options.parameters.arrayOfIssues;
		if (issueItems.length === 0) {
			return {
				[MimeTypes.textPlain]: 'No issues found. Please try another query.'
			};
		}
		Logger.debug(`Displaying ${issueItems.length} issues, first issue ${issueItems[0].number}`, DisplayIssuesTool.ID);
		const importantColumns = await this.getImportantColumns(issueItemsInfo, issueItems, token);

		const titleRow = `| ${importantColumns.join(' | ')} |`;
		Logger.debug(`Columns ${titleRow} issues`, DisplayIssuesTool.ID);
		const separatorRow = `| ${importantColumns.map(() => '---').join(' | ')} |\n`;
		const issues = new vscode.MarkdownString(titleRow);
		issues.supportHtml = true;
		issues.appendMarkdown('\n');
		issues.appendMarkdown(separatorRow);
		issues.appendMarkdown(issueItems.slice(0, 10).map(issue => {
			return this.issueToRow(issue, importantColumns);
		}).join('\n'));

		return {
			[MimeTypes.textPlain]: `The user has already been shown a markdown table of the issues. There is no need to display further information about these issues. Do NOT display them again.`,
			[MimeTypes.textMarkdown]: issues.value,
			[MimeTypes.textDisplay]: vscode.l10n.t('Here\'s a markdown table of the first 10 issues: ')
		};
	}

}