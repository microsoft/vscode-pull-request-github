/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { ActivePullRequestTool } from './activePullRequestTool';
import { CreatePullRequestTool } from './createPullRequestTool';
import { FetchIssueTool } from './fetchIssueTool';
import { FetchLabelsTool } from './fetchLabelsTool';
import { FetchNotificationTool } from './fetchNotificationTool';
import { OpenPullRequestTool } from './openPullRequestTool';
import { OpenPullRequestWebviewTool } from './openPullRequestWebviewTool';
import { PullRequestStatusChecksTool } from './pullRequestStatusChecksTool';
import { ResolveReviewThreadTool } from './resolveReviewThreadTool';
import { SearchTool } from './searchTools';
import { ITelemetry } from '../../common/telemetry';
import { CredentialStore } from '../../github/credentials';
import { FolderRepositoryManagerResolver } from '../../github/folderRepositoryManagerResolver';
import { RepositoriesManager } from '../../github/repositoriesManager';

export function registerTools(context: vscode.ExtensionContext, credentialStore: CredentialStore, repositoriesManager: RepositoriesManager, folderRepositoryManagerResolver: FolderRepositoryManagerResolver, telemetry: ITelemetry) {
	registerFetchingTools(context, credentialStore, repositoriesManager);
	registerSearchTools(context, credentialStore, repositoriesManager);
	context.subscriptions.push(vscode.lm.registerTool(ActivePullRequestTool.toolId, new ActivePullRequestTool(repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool(OpenPullRequestTool.toolId, new OpenPullRequestTool(repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool(OpenPullRequestWebviewTool.toolId, new OpenPullRequestWebviewTool(credentialStore, repositoriesManager, folderRepositoryManagerResolver, telemetry, context.extensionUri)));
	context.subscriptions.push(vscode.lm.registerTool(PullRequestStatusChecksTool.toolId, new PullRequestStatusChecksTool(credentialStore, repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool(CreatePullRequestTool.toolId, new CreatePullRequestTool(credentialStore, repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool(ResolveReviewThreadTool.toolId, new ResolveReviewThreadTool(repositoriesManager)));
}

function registerFetchingTools(context: vscode.ExtensionContext, credentialStore: CredentialStore, repositoriesManager: RepositoriesManager) {
	context.subscriptions.push(vscode.lm.registerTool(FetchIssueTool.toolId, new FetchIssueTool(credentialStore, repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool(FetchLabelsTool.toolId, new FetchLabelsTool(credentialStore, repositoriesManager)));
	context.subscriptions.push(vscode.lm.registerTool(FetchNotificationTool.toolId, new FetchNotificationTool(credentialStore, repositoriesManager)));
}

function registerSearchTools(context: vscode.ExtensionContext, credentialStore: CredentialStore, repositoriesManager: RepositoriesManager) {
	context.subscriptions.push(vscode.lm.registerTool(SearchTool.toolId, new SearchTool(credentialStore, repositoriesManager)));
}