/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export namespace contexts {
	export const VIEWED_FILES = 'github:viewedFiles';
	export const UNVIEWED_FILES = 'github:unviewedFiles';
	export const IN_REVIEW_MODE = 'github:inReviewMode';
	export const REPOS_NOT_IN_REVIEW_MODE = 'github:reposNotInReviewMode';
	export const REPOS_IN_REVIEW_MODE = 'github:reposInReviewMode';
	export const ACTIVE_PR_COUNT = 'github:activePRCount';
	export const LOADING_PRS_TREE = 'github:loadingPrsTree';
	export const LOADING_ISSUES_TREE = 'github:loadingIssuesTree';
	export const CREATE_PR_PERMISSIONS = 'github:createPrPermissions';
}

export namespace commands {
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