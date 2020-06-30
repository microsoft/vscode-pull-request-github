/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { PullRequestManager, PRManagerState } from '../github/pullRequestManager';
import * as vscode from 'vscode';
import { getIssue, ISSUE_EXPRESSION, ParsedIssue, parseIssueExpressionOutput, MAX_LINE_LENGTH, isComment } from './util';
import { StateManager } from './stateManager';

const MAX_LINE_COUNT = 2000;

class IssueDocumentLink extends vscode.DocumentLink {
	constructor(range: vscode.Range, public readonly mappedLink: { readonly value: string, readonly parsed: ParsedIssue }) {
		super(range);
	}
}

interface Link extends vscode.TerminalLink {
	startIndex: number,
	endIndex: number,
	tooltip?: string,
	mappedLink: { readonly value: string, readonly parsed: ParsedIssue }
}

abstract class LinkProvider {
	constructor(protected manager: PullRequestManager, protected stateManager: StateManager) { }

	async provideLink(line: string, wraps: boolean = false): Promise<Link[]> {
		const links: Link[] = [];
		let lineOffset = 0;
		let searchResult = -1;
		const lineLength = wraps ? line.length : Math.min(line.length, MAX_LINE_LENGTH);
		let lineSubstring = line.substring(0, lineLength);
		while ((searchResult = lineSubstring.search(ISSUE_EXPRESSION)) >= 0) {
			const match = lineSubstring.match(ISSUE_EXPRESSION);
			const parsed = parseIssueExpressionOutput(match);
			if (match && parsed) {
				links.push({
					startIndex: searchResult + lineOffset,
					endIndex: searchResult + lineOffset + match[0].length - 1,
					mappedLink: { value: match[0], parsed }
				});
			}
			lineOffset += searchResult + (match ? match[0].length : 0);
			lineSubstring = line.substring(lineOffset, line.length);
		}
		return links;
	}

	async resolveUri(value: string, parsed: ParsedIssue): Promise<vscode.Uri | undefined> {
		if (this.manager.state === PRManagerState.RepositoriesLoaded) {
			const issue = await getIssue(this.stateManager, this.manager, value, parsed);
			if (issue) {
				return vscode.env.asExternalUri(vscode.Uri.parse(issue.html_url));
			}
		}
		return undefined
	}
}

export class IssueDocumentLinkProvider extends LinkProvider implements vscode.DocumentLinkProvider {
	constructor(manager: PullRequestManager, stateManager: StateManager) { super(manager, stateManager) }

	async provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentLink[]> {
		const links: vscode.DocumentLink[] = [];
		const wraps: boolean = vscode.workspace.getConfiguration('editor', document).get('wordWrap', 'off') !== 'off';
		for (let i = 0; i < Math.min(document.lineCount, MAX_LINE_COUNT); i++) {
			const possibleLinks = await this.provideLink(document.lineAt(i).text, wraps);
			for (const possibleLink of possibleLinks) {
				const startPosition = new vscode.Position(i, possibleLink.startIndex);
				if (await isComment(document, startPosition)) {
					const link = new IssueDocumentLink(new vscode.Range(startPosition, new vscode.Position(i, possibleLink.endIndex)),
						possibleLink.mappedLink);
					links.push(link);
				}

			}
		}
		return links;
	}

	async resolveDocumentLink(link: IssueDocumentLink, _token: vscode.CancellationToken): Promise<vscode.DocumentLink | undefined> {
		const uri = await this.resolveUri(link.mappedLink.value, link.mappedLink.parsed);
		if (uri) {
			link.target = uri;
		}
		return link;
	}
}

export class TermLinkProv extends LinkProvider implements vscode.TerminalLinkProvider<Link> {
	constructor(manager: PullRequestManager, stateManager: StateManager) { super(manager, stateManager) }

	async provideTerminalLinks(context: vscode.TerminalLinkContext): Promise<Link[]> {
		return (await this.provideLink(context.line)).map(link => {
			link.endIndex++;
			return link;
		});
	}
	handleTerminalLink(link: Link): void {
		this.resolveUri(link.mappedLink.value, link.mappedLink.parsed).then(uri => {
			if (uri) {
				return vscode.env.openExternal(uri);
			}
		});
	}

}