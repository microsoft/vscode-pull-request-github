/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestManager } from '../github/pullRequestManager';
import { userMarkdown } from './util';

const USER_EXPRESSION: RegExp = /\@([^\s]+)/;

export class UserHoverProvider implements vscode.HoverProvider {
	constructor(private manager: PullRequestManager) { }

	provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover | undefined> {
		let wordPosition = document.getWordRangeAtPosition(position, USER_EXPRESSION);
		if (wordPosition && (wordPosition.start.character > 0)) {
			wordPosition = new vscode.Range(new vscode.Position(wordPosition.start.line, wordPosition.start.character), wordPosition.end);
			const word = document.getText(wordPosition);
			const match = word.match(USER_EXPRESSION);
			if (match) {
				return this.createHover(match[1]);
			}
		} else {
			return undefined;
		}
	}

	private async createHover(username: string): Promise<vscode.Hover | undefined> {
		const origin = await this.manager.getOrigin();
		const user = await this.manager.resolveUser(origin.remote.owner, origin.remote.repositoryName, username);
		return user ? new vscode.Hover(userMarkdown(origin, user)) : undefined;
	}
}