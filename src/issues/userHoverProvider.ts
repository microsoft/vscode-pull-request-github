/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestManager } from '../github/pullRequestManager';
import { userMarkdown, USER_EXPRESSION } from './util';

export class UserHoverProvider implements vscode.HoverProvider {
	constructor(private manager: PullRequestManager) { }

	provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover | undefined> {
		if (document.lineAt(position).range.end.character > 300) {
			return;
		}

		let wordPosition = document.getWordRangeAtPosition(position, USER_EXPRESSION);
		if (wordPosition && (wordPosition.start.character > 0)) {
			wordPosition = new vscode.Range(new vscode.Position(wordPosition.start.line, wordPosition.start.character), wordPosition.end);
			const word = document.getText(wordPosition);
			const match = word.match(USER_EXPRESSION);
			if (match) {
				return this.createHover(match[1], wordPosition);
			}
		} else {
			return;
		}
	}

	private async createHover(username: string, range: vscode.Range): Promise<vscode.Hover | undefined> {
		const origin = await this.manager.getPullRequestDefaults();
		const user = await this.manager.resolveUser(origin.owner, origin.repo, username);
		return (user && user.name) ? new vscode.Hover(userMarkdown(origin, user), range) : undefined;
	}
}