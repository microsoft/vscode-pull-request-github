/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestManager } from '../github/pullRequestManager';
import { User } from '../github/interface';

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
		if (user) {
			const markdown: vscode.MarkdownString = new vscode.MarkdownString(undefined, true);
			markdown.appendMarkdown(`![Avatar](${user.avatarUrl}) **${user.name}** [${user.login}](${user.url})`);
			if (user.bio) {
				markdown.appendText('  \r\n' + user.bio.replace(/\r\n/g, ' '));
			}

			const date = this.repoCommitDate(user, origin.remote.owner + '/' + origin.remote.repositoryName);
			if (user.location || date) {
				markdown.appendMarkdown('  \r\n\r\n---');
			}
			if (user.location) {
				markdown.appendMarkdown(`  \r\n$(location) ${user.location}`);
			}
			if (date) {
				markdown.appendMarkdown(`  \r\n$(git-commit) Committed to this repository on ${date}`);
			}
			if (user.company) {
				markdown.appendMarkdown(`  \r\n$(jersey) Member of ${user.company}`);
			}

			return new vscode.Hover(markdown);
		} else {
			return undefined;
		}
	}

	private repoCommitDate(user: User, repoNameWithOwner: string): string | undefined {
		let date: string | undefined = undefined;
		user.commitContributions.forEach(element => {
			if (repoNameWithOwner.toLowerCase() === element.repoNameWithOwner.toLowerCase()) {
				date = element.createdAt.toLocaleString('default', { day: 'numeric', month: 'short', year: 'numeric' });
			}
		});
		return date;
	}
}