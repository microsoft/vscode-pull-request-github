/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { PullRequestManager } from '../github/pullRequestManager';
import { PullRequestModel } from '../github/pullRequestModel';
import * as LRUCache from 'lru-cache';
import * as vscode from 'vscode';
import { getIssue, ISSUE_EXPRESSION, ParsedIssue } from './util';

export class IssueLinkProvider implements vscode.DocumentLinkProvider {
	private linkMap: Map<vscode.DocumentLink, { value: string, parsed: ParsedIssue }> = new Map();

	constructor(private manager: PullRequestManager, private resolvedIssues: LRUCache<string, PullRequestModel>) { }

	provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DocumentLink[]> {
		const links: vscode.DocumentLink[] = [];
		for (let i = 0; i < document.lineCount; i++) {
			let searchResult = -1;
			let lineOffset = 0;
			let lineSubstring = document.lineAt(i).text;
			while ((searchResult = lineSubstring.search(ISSUE_EXPRESSION)) >= 0) {
				const match = lineSubstring.match(ISSUE_EXPRESSION);
				if (match && (match.length > 1)) {
					const link = new vscode.DocumentLink(new vscode.Range(new vscode.Position(i, searchResult + lineOffset), new vscode.Position(i, searchResult + lineOffset + match[0].length)));
					links.push(link);
					this.linkMap.set(link, { value: match[0], parsed: { owner: match[2], name: match[3], issueNumber: parseInt(match[4]) } });
				}
				lineOffset += searchResult + (match ? match[0].length : 0) + 1;
				lineSubstring = lineSubstring.substring(lineOffset, lineSubstring.length);
			}
		}
		return links;
	}

	async resolveDocumentLink(link: vscode.DocumentLink, _token: vscode.CancellationToken): Promise<vscode.DocumentLink | undefined> {
		const mappedLink = this.linkMap.get(link);
		if (mappedLink) {
			const issue = await getIssue(this.resolvedIssues, this.manager, mappedLink.value, mappedLink.parsed);
			if (issue) {
				link.target = await vscode.env.asExternalUri(vscode.Uri.parse(issue.html_url));
			}
		}
		return link;
	}
}