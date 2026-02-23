/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { ActivePullRequestTool } from './activePullRequestTool';
import { FetchIssueTool } from './fetchIssueTool';
import { FetchLabelsTool } from './fetchLabelsTool';
import { FetchNotificationTool } from './fetchNotificationTool';
import { OpenPullRequestTool } from './openPullRequestTool';
import { PullRequestStatusChecksTool } from './pullRequestStatusChecksTool';
import { SearchTool } from './searchTools';
import { CredentialStore } from '../../github/credentials';
import { RepositoriesManager } from '../../github/repositoriesManager';

export function registerTools(context: vscode.ExtensionContext, credentialStore: CredentialStore, repositoriesManager: RepositoriesManager) {
	registerFetchingTools(context, credentialStore, repositoriesManager);
	registerSearchTools(context, credentialStore, repositoriesManager);
	context.subscriptions.push(vscode.lm.registerTool(ActivePullRequestTool.toolId, new ActivePullRequestTool(repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool(OpenPullRequestTool.toolId, new OpenPullRequestTool(repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool(PullRequestStatusChecksTool.toolId, new PullRequestStatusChecksTool(credentialStore, repositoriesManager)));
}

function registerFetchingTools(context: vscode.ExtensionContext, credentialStore: CredentialStore, repositoriesManager: RepositoriesManager) {
	context.subscriptions.push(vscode.lm.registerTool(FetchIssueTool.toolId, new FetchIssueTool(credentialStore, repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool(FetchLabelsTool.toolId, new FetchLabelsTool(credentialStore, repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool(FetchNotificationTool.toolId, new FetchNotificationTool(credentialStore, repositoriesManager)));
}

function registerSearchTools(context: vscode.ExtensionContext, credentialStore: CredentialStore, repositoriesManager: RepositoriesManager) {
	context.subscriptions.push(vscode.lm.registerTool(SearchTool.toolId, new SearchTool(credentialStore, repositoriesManager)));
}