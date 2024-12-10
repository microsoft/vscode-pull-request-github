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
import { concatAsyncIterable, TOOL_MARKDOWN_RESULT, ToolBase } from './toolsUtils';

export type DisplayIssuesParameters = SearchToolResult;

type IssueColumn = keyof IssueSearchResultItem;

const LLM_FIND_IMPORTANT_COLUMNS_INSTRUCTIONS = `Instructions:
You are an expert on GitHub issues. You can help the user identify the most important columns for rendering issues based on a query for issues:
- Include a column related to the sort value, if given.
- Output a newline separated list of columns only, max 4 columns.
- List the columns in the order they should be displayed.
- Don't change the casing.
- Don't include columns that will all have the same value for all the resulting issues.
Here are the possible columns:
`;

export class DisplayIssuesTool extends ToolBase<DisplayIssuesParameters> {
	public static readonly toolId = 'github-pull-request_renderIssues';
	private static ID = 'DisplayIssuesTool';
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

	private async getImportantColumns(issueItemsInfo: vscode.LanguageModelTextPart | undefined, issues: IssueSearchResultItem[], token: vscode.CancellationToken): Promise<IssueColumn[]> {
		if (!issueItemsInfo) {
			return ['number', 'title', 'state'];
		}

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
		messages.push(new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, issueItemsInfo?.value));
		const response = await model.sendRequest(messages, chatOptions, token);
		const result = this.postProcess(await concatAsyncIterable(response.text), issues);
		const indexOfUrl = result.indexOf('url');
		if (result.length === 0) {
			return ['number', 'title', 'state'];
		} else if (indexOfUrl >= 0) {
			// Never include the url column
			result.splice(indexOfUrl, 1);
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
					return issue[column]?.map((label) => label?.name && label.color ? makeLabel({ name: label.name, color: label.color }) : '').join(', ');
				case 'assignees':
					return issue[column]?.map((assignee) => this.renderUser(assignee)).join(', ');
				case 'author':
					const account = issue[column];
					return account ? this.renderUser(account) : '';
				case 'createdAt':
				case 'updatedAt':
					const updatedAt = issue[column];
					return updatedAt ? new Date(updatedAt).toLocaleDateString() : '';
				case 'milestone':
					return issue[column];
				default:
					return issue[column];
			}
		}).join(' | ')} |`;
	}

	private foundIssuesCount(params: DisplayIssuesParameters): number {
		return params.totalIssues !== undefined ? params.totalIssues : (params.arrayOfIssues?.length ?? 0);
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<DisplayIssuesParameters>): Promise<vscode.PreparedToolInvocation> {
		const maxDisplay = 10;
		const foundIssuesCount = this.foundIssuesCount(options.input);
		const actualDisplay = Math.min(maxDisplay, foundIssuesCount);
		if (actualDisplay === 0) {
			return {
				invocationMessage: vscode.l10n.t('No issues found')
			};
		} else if (actualDisplay < foundIssuesCount) {
			return {
				invocationMessage: vscode.l10n.t('Found {0} issues. Generating a markdown table of the first {1}', foundIssuesCount, actualDisplay)
			};
		} else {
			return {
				invocationMessage: vscode.l10n.t('Found {0} issues. Generating a markdown table', foundIssuesCount)
			};
		}
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<DisplayIssuesParameters>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult | undefined> {
		const issueItemsInfo: vscode.LanguageModelTextPart | undefined = this.chatParticipantState.firstUserMessage;
		const issueItems: IssueSearchResultItem[] | undefined = options.input.arrayOfIssues;
		if (!issueItems || issueItems.length === 0) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(vscode.l10n.t('No issues found. Please try another query.'))]);
		}
		Logger.debug(`Displaying ${this.foundIssuesCount(options.input)} issues, first issue ${issueItems[0].number}`, DisplayIssuesTool.ID);
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

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(TOOL_MARKDOWN_RESULT),
		new vscode.LanguageModelTextPart(issues.value),
		new vscode.LanguageModelTextPart(`The issues have been shown to the user. Simply say that you've already displayed the issue or first 10 issues.`)]);
	}

}