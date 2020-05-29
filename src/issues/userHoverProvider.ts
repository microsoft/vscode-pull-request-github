/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestManager } from '../github/pullRequestManager';
import { userMarkdown, USER_EXPRESSION, shouldShowHover } from './util';
import { ITelemetry } from '../common/telemetry';

export class UserHoverProvider implements vscode.HoverProvider {
	constructor(private manager: PullRequestManager, private telemetry: ITelemetry) { }

	async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
		if (!(await shouldShowHover(document, position))) {
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
		try {
			const origin = await this.manager.getPullRequestDefaults();
			const user = await this.manager.resolveUser(origin.owner, origin.repo, username);
			if (user && user.name) {
				/* __GDPR__
					"issue.userHover" : {}
				*/
				this.telemetry.sendTelemetryEvent('issues.userHover');
				return new vscode.Hover(userMarkdown(origin, user), range);
			} else {
				return;
			}
		} catch (e) {
			// No need to notify about a hover that doesn't work
			return;
		}
	}
}