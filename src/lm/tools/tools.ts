/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { ChatParticipantState } from '../participants';
import { DisplayIssuesTool } from './displayIssuesTool';
import { FetchTool } from './fetchTool';
import { ConvertToSearchSyntaxTool, SearchTool } from './searchTools';
import { SuggestFixTool } from './suggestFixTool';

export function registerTools(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
	registerFetchTool(context, repositoriesManager, chatParticipantState);
	registerSuggestFixTool(context, repositoriesManager);
	registerSearchTools(context, repositoriesManager, chatParticipantState);
}

function registerFetchTool(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_fetch', new FetchTool(repositoriesManager, chatParticipantState)));
}

function registerSuggestFixTool(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_suggest-fix', new SuggestFixTool(repositoriesManager)));
}

function registerSearchTools(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_formSearchQuery', new ConvertToSearchSyntaxTool(repositoriesManager, chatParticipantState)));
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_doSearch', new SearchTool(repositoriesManager, chatParticipantState)));
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_renderIssues', new DisplayIssuesTool(chatParticipantState)));
}