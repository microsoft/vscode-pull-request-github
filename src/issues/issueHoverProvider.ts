/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ITelemetry } from '../common/telemetry';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { RepositoriesManager } from '../github/repositoriesManager';
import { ISSUE_OR_URL_EXPRESSION, ParsedIssue, parseIssueExpressionOutput } from '../github/utils';
import { StateManager } from './stateManager';
import {
	getIssue,
	issueMarkdown,
	shouldShowHover,
} from './util';

export class IssueHoverProvider implements vscode.HoverProvider {
	constructor(
		private manager: RepositoriesManager,
		private stateManager: StateManager,
		private context: vscode.ExtensionContext,
		private telemetry: ITelemetry,
	) { }

	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<vscode.Hover | undefined> {
		if (!(await shouldShowHover(document, position))) {
			return;
		}

		let wordPosition = document.getWordRangeAtPosition(position, ISSUE_OR_URL_EXPRESSION);
		if (wordPosition && wordPosition.start.character > 0) {
			wordPosition = new vscode.Range(
				new vscode.Position(wordPosition.start.line, wordPosition.start.character),
				wordPosition.end,
			);
			const word = document.getText(wordPosition);
			const match = word.match(ISSUE_OR_URL_EXPRESSION);
			const tryParsed = parseIssueExpressionOutput(match);

			const folderManager = this.manager.getManagerForFile(document.uri) ?? this.manager.folderManagers[0];
			if (!folderManager) {
				return;
			}

			if (
				tryParsed &&
				match &&
				// Only check the max issue number if the owner/repo format isn't used here.
				(tryParsed.owner || tryParsed.issueNumber <= this.stateManager.maxIssueNumber(folderManager.repository.rootUri))
			) {
				return this.createHover(folderManager, match[0], tryParsed, wordPosition);
			}
		} else {
			return;
		}
	}

	private async createHover(
		folderManager: FolderRepositoryManager,
		value: string,
		parsed: ParsedIssue,
		range: vscode.Range,
	): Promise<vscode.Hover | undefined> {
		const issue = await getIssue(this.stateManager, folderManager, value, parsed);
		if (!issue) {
			return;
		}
		/* __GDPR__
			"issue.issueHover" : {}
		*/
		this.telemetry.sendTelemetryEvent('issues.issueHover');
		return new vscode.Hover(await issueMarkdown(issue, this.context, this.manager, parsed.commentNumber), range);
	}
}
