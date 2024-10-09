/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { RepositoriesManager } from '../github/repositoriesManager';
import { DisplayIssuesTool } from './displayIssuesTool';
import { IssueTool } from './issueTool';
import { ConvertToSearchSyntaxTool, SearchTool } from './searchTools';

export function registerTools(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager) {
	registerIssueTool(context, repositoriesManager);
	registerSearchTools(context, repositoriesManager);
}

function registerIssueTool(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_issue', new IssueTool(repositoriesManager)));
}
function registerSearchTools(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_searchSyntax', new ConvertToSearchSyntaxTool(repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_doSearch', new SearchTool(repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_renderIssues', new DisplayIssuesTool(repositoriesManager)));
}
