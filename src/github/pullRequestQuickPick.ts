/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { PullRequestNumberData } from './graphql';

export function getPullRequestQuickPickItem(pr: PullRequestNumberData): vscode.QuickPickItem & { prNumber: number } {
	return {
		label: `#${pr.number}`,
		description: `${pr.title} by @${pr.author.login}`,
		prNumber: pr.number,
	};
}
