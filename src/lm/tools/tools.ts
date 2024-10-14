/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { DisplayIssuesTool } from '../displayIssuesTool';
import { ChatParticipantState } from '../participants';
import { ConvertToSearchSyntaxTool, SearchTool } from '../searchTools';
import { IssueTool } from './issueTool';
import { SuggestFixTool } from './suggestFixTool';

export function registerTools(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
	registerIssueTool(context, repositoriesManager);
	registerSuggestFixTool(context, repositoriesManager);
	registerSearchTools(context, repositoriesManager, chatParticipantState);
}

function registerIssueTool(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_issue', new IssueTool(repositoriesManager)));
}

function registerSuggestFixTool(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_suggest-fix', new SuggestFixTool(repositoriesManager)));
}

function registerSearchTools(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_formSearchQuery', new ConvertToSearchSyntaxTool(repositoriesManager, chatParticipantState)));
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_doSearch', new SearchTool(repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_renderIssues', new DisplayIssuesTool(chatParticipantState)));
}