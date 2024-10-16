/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatParticipantState } from '../participants';

export interface IToolCall {
	tool: vscode.LanguageModelToolDescription;
	call: vscode.LanguageModelToolCallPart;
	result: Thenable<vscode.LanguageModelToolResult>;
}

export interface IssueToolParameters {
	issueNumber: number;
	repo: {
		owner: string;
		name: string;
	};
}

export interface IssueResult {
	title: string;
	body: string;
	comments: {
		body: string;
	}[];
}

export abstract class ToolBase<T> implements vscode.LanguageModelTool<T> {
	constructor(protected readonly chatParticipantState: ChatParticipantState) { }
	abstract invoke(options: vscode.LanguageModelToolInvocationOptions<T>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.LanguageModelToolResult>;
}

export async function concatAsyncIterable(asyncIterable: AsyncIterable<string>): Promise<string> {
	let result = '';
	for await (const chunk of asyncIterable) {
		result += chunk;
	}
	return result;
}

export const enum MimeTypes {
	textPlain = 'text/plain',
	textMarkdown = 'text/markdown',
	textJson = 'text/json',
	textDisplay = 'text/display' // our own made up mime type for stuff that should be shown in chat to the user
}
