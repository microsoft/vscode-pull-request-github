/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { EDITOR, WORD_WRAP } from '../common/settingKeys';
import { toOpenIssueWebviewUri, toOpenPullRequestWebviewUri } from '../common/uri';
import { ReposManagerState } from '../github/folderRepositoryManager';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { ISSUE_EXPRESSION, ParsedIssue, parseIssueExpressionOutput } from '../github/utils';
import { StateManager } from './stateManager';
import {
	getIssue,
	isComment,
	MAX_LINE_LENGTH,
} from './util';

const MAX_LINE_COUNT = 2000;

class IssueDocumentLink extends vscode.DocumentLink {
	constructor(
		range: vscode.Range,
		public readonly mappedLink: { readonly value: string; readonly parsed: ParsedIssue },
		public readonly uri: vscode.Uri,
	) {
		super(range);
	}
}

export class IssueLinkProvider implements vscode.DocumentLinkProvider {
	constructor(private manager: RepositoriesManager, private stateManager: StateManager) { }

	async provideDocumentLinks(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): Promise<vscode.DocumentLink[]> {
		const links: vscode.DocumentLink[] = [];
		const wraps: boolean = vscode.workspace.getConfiguration(EDITOR, document).get(WORD_WRAP, 'off') !== 'off';
		for (let i = 0; i < Math.min(document.lineCount, MAX_LINE_COUNT); i++) {
			let searchResult = -1;
			let lineOffset = 0;
			const line = document.lineAt(i).text;
			const lineLength = wraps ? line.length : Math.min(line.length, MAX_LINE_LENGTH);
			let lineSubstring = line.substring(0, lineLength);
			while ((searchResult = lineSubstring.search(ISSUE_EXPRESSION)) >= 0) {
				const match = lineSubstring.match(ISSUE_EXPRESSION);
				const parsed = parseIssueExpressionOutput(match);
				if (match && parsed) {
					const startPosition = new vscode.Position(i, searchResult + lineOffset);
					if (await isComment(document, startPosition)) {
						const link = new IssueDocumentLink(
							new vscode.Range(
								startPosition,
								new vscode.Position(i, searchResult + lineOffset + match[0].length - 1),
							),
							{ value: match[0], parsed },
							document.uri,
						);
						links.push(link);
					}
				}
				lineOffset += searchResult + (match ? match[0].length : 0);
				lineSubstring = line.substring(lineOffset, line.length);
			}
		}
		return links;
	}

	async resolveDocumentLink(
		link: IssueDocumentLink,
		_token: vscode.CancellationToken,
	): Promise<vscode.DocumentLink | undefined> {
		if (this.manager.state === ReposManagerState.RepositoriesLoaded) {
			const folderManager = this.manager.getManagerForFile(link.uri);
			if (!folderManager) {
				return;
			}
			const issue = await getIssue(
				this.stateManager,
				folderManager,
				link.mappedLink.value,
				link.mappedLink.parsed,
			);
			if (issue) {
				// Check if it's a pull request or an issue
				if (issue instanceof PullRequestModel) {
					// Use pull request webview URI
					link.target = await toOpenPullRequestWebviewUri({
						owner: issue.remote.owner,
						repo: issue.remote.repositoryName,
						pullRequestNumber: issue.number,
					});
				} else {
					// Use issue webview URI
					link.target = await toOpenIssueWebviewUri({
						owner: issue.remote.owner,
						repo: issue.remote.repositoryName,
						issueNumber: issue.number,
					});
				}
			}
			return link;
		}
	}
}
