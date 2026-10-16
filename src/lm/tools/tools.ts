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
import { PullRequestStatusChecksTool } from './pullRequestStatusChecksTool';
import { ResolveReviewThreadTool } from './resolveReviewThreadTool';
import { SearchTool } from './searchTools';
import { CredentialStore } from '../../github/credentials';
import { RepositoriesManager } from '../../github/repositoriesManager';

export function createTools(credentialStore: CredentialStore, repositoriesManager: RepositoriesManager): Map<string, vscode.LanguageModelTool<unknown>> {
	const tools = new Map<string, vscode.LanguageModelTool<unknown>>();
	tools.set(FetchIssueTool.toolId, new FetchIssueTool(credentialStore, repositoriesManager));
	tools.set(FetchLabelsTool.toolId, new FetchLabelsTool(credentialStore, repositoriesManager));
	tools.set(FetchNotificationTool.toolId, new FetchNotificationTool(credentialStore, repositoriesManager));
	tools.set(SearchTool.toolId, new SearchTool(credentialStore, repositoriesManager));
	tools.set(ActivePullRequestTool.toolId, new ActivePullRequestTool(repositoriesManager));
	tools.set(OpenPullRequestTool.toolId, new OpenPullRequestTool(repositoriesManager));
	tools.set(PullRequestStatusChecksTool.toolId, new PullRequestStatusChecksTool(credentialStore, repositoriesManager));
	tools.set(CreatePullRequestTool.toolId, new CreatePullRequestTool(credentialStore, repositoriesManager));
	tools.set(ResolveReviewThreadTool.toolId, new ResolveReviewThreadTool(repositoriesManager));
	return tools;
}

export function registerTools(context: vscode.ExtensionContext, credentialStore: CredentialStore, repositoriesManager: RepositoriesManager) {
	for (const [toolId, tool] of createTools(credentialStore, repositoriesManager)) {
		context.subscriptions.push(vscode.lm.registerTool(toolId, tool));
	}
}
