/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestManager } from '../github/pullRequestManager';
import * as marked from 'marked';
import * as LRUCache from 'lru-cache';
import { PullRequestModel } from '../github/pullRequestModel';
import { getIssue, ISSUE_OR_URL_EXPRESSION, ParsedIssue, parseIssueExpressionOutput } from './util';
import { GithubItemStateEnum } from '../github/interface';
import { IssueModel } from '../github/issueModel';

export class IssueHoverProvider implements vscode.HoverProvider {
	constructor(private manager: PullRequestManager, private resolvedIssues: LRUCache<string, PullRequestModel>) { }

	provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover | undefined> {
		let wordPosition = document.getWordRangeAtPosition(position, ISSUE_OR_URL_EXPRESSION);
		if (wordPosition && (wordPosition.start.character > 0)) {
			wordPosition = new vscode.Range(new vscode.Position(wordPosition.start.line, wordPosition.start.character - 1), wordPosition.end);
			const word = document.getText(wordPosition);
			const match = word.match(ISSUE_OR_URL_EXPRESSION);
			const tryParsed = parseIssueExpressionOutput(match);
			if (tryParsed && match) {
				return this.createHover(match[0], tryParsed);
			}
		} else {
			return undefined;
		}
	}

	private async createHover(value: string, parsed: ParsedIssue): Promise<vscode.Hover | undefined> {
		const issue = await getIssue(this.resolvedIssues, this.manager, value, parsed);
		if (issue) {
			const markdown: vscode.MarkdownString = new vscode.MarkdownString(undefined, true);
			const date = new Date(issue.createdAt);
			markdown.appendMarkdown(`${issue.remote.owner}/${issue.remote.repositoryName} on ${date.toLocaleString('default', { day: 'numeric', month: 'short', year: 'numeric' })}  \n`);
			markdown.appendMarkdown(`**${this.getIcon(issue)} ${issue.title}** [#${issue.number}](${issue.html_url})  \n`);
			const body = marked.parse(issue.body, {
				renderer: new PlainTextRenderer()
			});
			markdown.appendMarkdown(((body.length > 85) ? (body.substr(0, 130) + '...') : body) + '  \n');
			if (issue.item.labels.length > 0) {
				issue.item.labels.forEach(label => {
					markdown.appendMarkdown(`_${label.name}_ `);
				});
			}
			return new vscode.Hover(markdown);
		} else {
			return undefined;
		}
	}

	private getIcon(issue: IssueModel) {
		switch (issue.state) {
			case GithubItemStateEnum.Open: {
				return issue instanceof PullRequestModel ? '$(git-pull-request)' : '$(issues)';
			}
			case GithubItemStateEnum.Closed: {
				return issue instanceof PullRequestModel ? '$(git-pull-request)' : '$(issue-closed)';
			}
			case GithubItemStateEnum.Merged: return '$(git-merge)';
		}
	}
}

class PlainTextRenderer extends marked.Renderer {
	code(code: string): string {
		return code;
	}
	blockquote(quote: string): string {
		return quote;
	}
	html(html: string): string {
		return html;
	}
	heading(text: string, _level: 1 | 2 | 3 | 4 | 5 | 6, _raw: string, _slugger: marked.Slugger): string {
		return text + ' ';
	}
	hr(): string {
		return '';
	}
	list(body: string, _ordered: boolean, _start: number): string {
		return body;
	}
	listitem(text: string): string {
		return ' ' + text;
	}
	checkbox(_checked: boolean): string {
		return '';
	}
	paragraph(text: string): string {
		return text;
	}
	table(header: string, body: string): string {
		return header + ' ' + body;
	}
	tablerow(content: string): string {
		return content;
	}
	tablecell(content: string, _flags: {
		header: boolean;
		align: 'center' | 'left' | 'right' | null;
	}): string {
		return content;
	}
	strong(text: string): string {
		return text;
	}
	em(text: string): string {
		return text;
	}
	codespan(code: string): string {
		return code;
	}
	br(): string {
		return ' ';
	}
	del(text: string): string {
		return text;
	}
	image(_href: string, _title: string, _text: string): string {
		return '';
	}
	text(text: string): string {
		return text;
	}
	link(href: string, title: string, text: string): string {
		return text + ' ';
	}
}