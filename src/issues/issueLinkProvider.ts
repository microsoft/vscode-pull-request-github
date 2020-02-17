/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { PullRequestManager } from '../github/pullRequestManager';
import { PullRequestModel } from '../github/pullRequestModel';
import * as LRUCache from 'lru-cache';
import * as vscode from 'vscode';
import { getIssue, ISSUE_EXPRESSION, ParsedIssue, parseIssueExpressionOutput } from './util';

const MAX_LINE_COUNT = 2000;
const MAX_LINE_LENGTH = 150;

class IssueDocumentLink extends vscode.DocumentLink {
	constructor(range: vscode.Range, public readonly mappedLink: { readonly value: string, readonly parsed: ParsedIssue }) {
		super(range);
	}
}

export class IssueLinkProvider implements vscode.DocumentLinkProvider {
	constructor(private manager: PullRequestManager, private resolvedIssues: LRUCache<string, PullRequestModel>) { }

	provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DocumentLink[]> {
		const links: vscode.DocumentLink[] = [];
		const wraps: boolean = vscode.workspace.getConfiguration('editor', document).get('wordWrap', 'off') !== 'off';
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
					const link = new IssueDocumentLink(new vscode.Range(new vscode.Position(i, searchResult + lineOffset), new vscode.Position(i, searchResult + lineOffset + match[0].length)),
						{ value: match[0], parsed });
					links.push(link);
				}
				lineOffset += searchResult + (match ? match[0].length : 0);
				lineSubstring = line.substring(lineOffset, line.length);
			}
		}
		return links;
	}

	async resolveDocumentLink(link: IssueDocumentLink, _token: vscode.CancellationToken): Promise<vscode.DocumentLink | undefined> {
		const issue = await getIssue(this.resolvedIssues, this.manager, link.mappedLink.value, link.mappedLink.parsed);
		if (issue) {
			link.target = await vscode.env.asExternalUri(vscode.Uri.parse(issue.html_url));
		}
		return link;
	}
}