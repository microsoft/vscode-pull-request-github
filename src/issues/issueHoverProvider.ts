/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestManager } from '../github/pullRequestManager';
import { getIssue, ISSUE_OR_URL_EXPRESSION, ParsedIssue, parseIssueExpressionOutput, issueMarkdown, shouldShowHover } from './util';
import { StateManager } from './stateManager';
import { ITelemetry } from '../common/telemetry';

export class IssueHoverProvider implements vscode.HoverProvider {
	constructor(private manager: PullRequestManager, private stateManager: StateManager, private context: vscode.ExtensionContext, private telemetry: ITelemetry) { }

	async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
		if (!(await shouldShowHover(document, position))) {
			return;
		}

		let wordPosition = document.getWordRangeAtPosition(position, ISSUE_OR_URL_EXPRESSION);
		if (wordPosition && (wordPosition.start.character > 0)) {
			wordPosition = new vscode.Range(new vscode.Position(wordPosition.start.line, wordPosition.start.character - 1), wordPosition.end);
			const word = document.getText(wordPosition);
			const match = word.match(ISSUE_OR_URL_EXPRESSION);
			const tryParsed = parseIssueExpressionOutput(match);
			if (tryParsed && match && tryParsed.issueNumber <= this.stateManager.maxIssueNumber) {
				return this.createHover(match[0], tryParsed, wordPosition);
			}
		} else {
			return;
		}
	}

	private async createHover(value: string, parsed: ParsedIssue, range: vscode.Range): Promise<vscode.Hover | undefined> {
		const issue = await getIssue(this.stateManager, this.manager, value, parsed);
		if (issue) {
			/* __GDPR__
				"issue.issueHover" : {}
			*/
			this.telemetry.sendTelemetryEvent('issues.issueHover');
			return new vscode.Hover(issueMarkdown(issue, this.context, parsed.commentNumber), range);
		} else {
			return;
		}
	}
}