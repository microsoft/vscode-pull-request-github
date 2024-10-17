/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { CredentialStore } from '../../github/credentials';
import { RepositoriesManager } from '../../github/repositoriesManager';
import { ChatParticipantState } from '../participants';
import { DisplayIssuesTool } from './displayIssuesTool';
import { FetchIssueOrPRTool } from './fetchIssuePRTool';
import { FetchNotificationTool } from './fetchNotificationTool';
import { ConvertToSearchSyntaxTool, SearchTool } from './searchTools';
import { SuggestFixTool } from './suggestFixTool';
import { IssueAndPRSummarizationTool } from './summarizeIssuePRTool';
import { NotificationSummarizationTool } from './summarizeNotificationsTool';

export function registerTools(context: vscode.ExtensionContext, credentialStore: CredentialStore, repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
	registerFetchIssueOrPRTool(context, credentialStore, repositoriesManager, chatParticipantState);
	registerFetchNotificationTool(context, credentialStore, repositoriesManager, chatParticipantState);
	registerIssueAndPRSummarizationTool(context);
	registerNotificationSummarizationTool(context);
	registerSuggestFixTool(context, repositoriesManager);
	registerSearchTools(context, credentialStore, repositoriesManager, chatParticipantState);
}

function registerFetchIssueOrPRTool(context: vscode.ExtensionContext, credentialStore: CredentialStore, repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_issue_pr_fetch', new FetchIssueOrPRTool(credentialStore, repositoriesManager, chatParticipantState)));
}

function registerFetchNotificationTool(context: vscode.ExtensionContext, credentialStore: CredentialStore, repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_notification_fetch', new FetchNotificationTool(credentialStore, repositoriesManager, chatParticipantState)));
}

function registerIssueAndPRSummarizationTool(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_issue_pr_summarize', new IssueAndPRSummarizationTool()));
}

function registerNotificationSummarizationTool(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_notification_summarize', new NotificationSummarizationTool()));
}

function registerSuggestFixTool(context: vscode.ExtensionContext, repositoriesManager: RepositoriesManager) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_suggest-fix', new SuggestFixTool(repositoriesManager)));
}

function registerSearchTools(context: vscode.ExtensionContext, credentialStore: CredentialStore, repositoriesManager: RepositoriesManager, chatParticipantState: ChatParticipantState) {
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_formSearchQuery', new ConvertToSearchSyntaxTool(credentialStore, repositoriesManager, chatParticipantState)));
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_doSearch', new SearchTool(credentialStore, repositoriesManager, chatParticipantState)));
	context.subscriptions.push(vscode.lm.registerTool('github-pull-request_renderIssues', new DisplayIssuesTool(chatParticipantState)));
}