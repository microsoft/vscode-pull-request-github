/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export namespace contexts {
	export const VIEWED_FILES = 'github:viewedFiles'; // Array of file paths for viewed files
	export const UNVIEWED_FILES = 'github:unviewedFiles'; // Array of file paths for unviewed files
	export const IN_REVIEW_MODE = 'github:inReviewMode'; // Boolean indicating if the extension is currently in "review mode" (has a non-ignored PR checked out)
	export const REPOS_NOT_IN_REVIEW_MODE = 'github:reposNotInReviewMode'; // Array of URIs for repos that are not in review mode
	export const REPOS_IN_REVIEW_MODE = 'github:reposInReviewMode'; // Array of URIs for repos that are in review mode
	export const ACTIVE_PR_COUNT = 'github:activePRCount'; // Number of PRs that are currently checked out
	export const LOADING_PRS_TREE = 'github:loadingPrsTree';
	export const LOADING_ISSUES_TREE = 'github:loadingIssuesTree';
	export const CREATE_PR_PERMISSIONS = 'github:createPrPermissions';
	export const RESOLVING_CONFLICTS = 'github:resolvingConflicts';
	export const PULL_REQUEST_DESCRIPTION_VISIBLE = 'github:pullRequestDescriptionVisible'; // Boolean indicating if the pull request description is visible
	export const ACTIVE_COMMENT_HAS_SUGGESTION = 'github:activeCommentHasSuggestion'; // Boolean indicating if the active comment has a suggestion
	export const CREATING = 'pr:creating';
	export const NOTIFICATION_COUNT = 'github:notificationCount'; // Number of notifications in the notifications view
}

export namespace commands {
	export const OPEN_CHAT = 'workbench.action.chat.open';
	export const CHAT_SETUP_ACTION_ID = 'workbench.action.chat.triggerSetup';

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
}