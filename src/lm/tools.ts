/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { RepositoriesManager } from '../github/repositoriesManager';
import { IssueTool } from './issueTool';

export function registerTools(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager) {
	registerIssueTool(context, repositoriesManager);
}

function registerIssueTool(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_issue', new IssueTool(repositoriesManager)));
}