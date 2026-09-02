/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export interface GitHubIssueOrPullRequestUri {
	kind: 'issue' | 'pullRequest';
	owner: string;
	repo: string;
	number: number;
}

const GITHUB_PATH_PART = /^[A-Za-z0-9_.-]+$/;

export function parseGitHubIssueOrPullRequestUri(uri: vscode.Uri): GitHubIssueOrPullRequestUri | undefined {
	if ((uri.scheme !== 'http' && uri.scheme !== 'https') || uri.authority.toLowerCase() !== 'github.com') {
		return undefined;
	}

	const pathParts = uri.path.split('/').filter(Boolean);
	const kind = pathParts[2] === 'pull'
		? 'pullRequest'
		: pathParts[2] === 'issues'
			? 'issue'
			: undefined;
	if (pathParts.length < 4 || !kind || !GITHUB_PATH_PART.test(pathParts[0]) || !GITHUB_PATH_PART.test(pathParts[1])) {
		return undefined;
	}

	if (!/^[1-9][0-9]*$/.test(pathParts[3])) {
		return undefined;
	}

	const number = Number(pathParts[3]);
	if (!Number.isSafeInteger(number)) {
		return undefined;
	}

	return {
		kind,
		owner: pathParts[0],
		repo: pathParts[1],
		number,
	};
}

export function openWithDefaultExternalOpener(uri: vscode.Uri): Thenable<boolean> {
	return vscode.env.openExternal(uri, { allowContributedOpeners: 'default' });
}
