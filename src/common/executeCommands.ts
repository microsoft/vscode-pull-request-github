/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export namespace contexts {
	export const VIEWED_FILES = 'azureDevOps:viewedFiles'; // Array of file paths for viewed files
	export const UNVIEWED_FILES = 'azureDevOps:unviewedFiles'; // Array of file paths for unviewed files
	export const IN_REVIEW_MODE = 'azureDevOps:inReviewMode'; // Boolean indicating if the extension is currently in "review mode" (has a non-ignored PR checked out)
	export const REPOS_NOT_IN_REVIEW_MODE = 'azureDevOps:reposNotInReviewMode'; // Array of URIs for repos that are not in review mode
	export const REPOS_IN_REVIEW_MODE = 'azureDevOps:reposInReviewMode'; // Array of URIs for repos that are in review mode
	export const ACTIVE_PR_COUNT = 'azureDevOps:activePRCount'; // Number of PRs that are currently checked out
	export const LOADING_PRS_TREE = 'azureDevOps:loadingPrsTree';
	export const LOADING_ISSUES_TREE = 'azureDevOps:loadingIssuesTree';
	export const HAS_ENTERPRISE_URIS = 'azureDevOps:hasEnterpriseUris';
	export const CREATE_PR_PERMISSIONS = 'azureDevOps:createPrPermissions';
	export const CAN_ADD_TO_STACK = 'azureDevOps:canAddToStack';
	export const RESOLVING_CONFLICTS = 'azureDevOps:resolvingConflicts';
	export const PULL_REQUEST_DESCRIPTION_VISIBLE = 'azureDevOps:pullRequestDescriptionVisible'; // Boolean indicating if the pull request description is visible
	export const ACTIVE_COMMENT_HAS_SUGGESTION = 'azureDevOps:activeCommentHasSuggestion'; // Boolean indicating if the active comment has a suggestion
	export const CREATING = 'pr:creating';
	export const NOTIFICATION_COUNT = 'azureDevOps:notificationCount'; // Number of notifications in the notifications view
	export const ACTIVATED = 'jhare96.vscode-pull-request-azdo.activated'; // Boolean indicating if the extension has been activated
}

export namespace commands {
	export const OPEN_CHAT = 'workbench.action.chat.open';
	export const NEW_CHAT = 'workbench.action.chat.newChat';
	export const SHOW_CHAT = 'workbench.panel.chat';
	export const CHAT_SETUP_ACTION_ID = 'workbench.action.chat.triggerSetup';
	export const MANAGE_EXTENSION_ACCOUNT_PREFERENCES = '_manageAccountPreferencesForExtension';

	export const QUICK_CHAT_OPEN = 'workbench.action.quickchat.toggle';

	export function executeCommand(command: string, arg1?: any, arg2?: any) {
		return vscode.commands.executeCommand(command, arg1, arg2);
	}

	export function focusView(viewId: string) {
		return executeCommand(`${viewId}.focus`);
	}

	export function setContext(context: string, value: any) {
		return executeCommand('setContext', context, value);
	}

	export function openFolder(ur: vscode.Uri, options: { forceNewWindow?: boolean, forceReuseWindow?: boolean }) {
		return executeCommand('vscode.openFolder', ur, options);
	}
}