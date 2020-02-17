/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as LRUCache from 'lru-cache';
import * as marked from 'marked';
import * as vscode from 'vscode';
import { PullRequestManager } from '../github/pullRequestManager';
import { IssueModel } from '../github/issueModel';
import { GithubItemStateEnum } from '../github/interface';
import { PullRequestModel } from '../github/pullRequestModel';

export const ISSUE_EXPRESSION = /(([^\s]+)\/([^\s]+))?#([0-9]+)/;
export const ISSUE_OR_URL_EXPRESSION = /(https?:\/\/github\.com\/(([^\s]+)\/([^\s]+))\/[^\s]+\/([0-9]+))|(([^\s]+)\/([^\s]+))?#([0-9]+)/;

export type ParsedIssue = { owner: string | undefined, name: string | undefined, issueNumber: number };

export function parseIssueExpressionOutput(output: RegExpMatchArray | null): ParsedIssue | undefined {
	if (!output) {
		return undefined;
	}
	const issue: ParsedIssue = { owner: undefined, name: undefined, issueNumber: 0 };
	if (output.length === 5) {
		issue.owner = output[2];
		issue.name = output[3];
		issue.issueNumber = parseInt(output[4]);
		return issue;
	} else if (output.length === 10) {
		issue.owner = output[3] || output[7];
		issue.name = output[4] || output[8];
		issue.issueNumber = parseInt(output[5] || output[9]);
		return issue;
	} else {
		return undefined;
	}
}

export async function getIssue(cache: LRUCache<string, IssueModel>, manager: PullRequestManager, issueValue: string, parsed: ParsedIssue): Promise<IssueModel | undefined> {
	if (cache.has(issueValue)) {
		return cache.get(issueValue);
	} else {
		let owner: string | undefined = undefined;
		let name: string | undefined = undefined;
		let issueNumber: number | undefined = undefined;
		const origin = await manager.getOrigin();
		if (!parsed) {
			const tryParse = parseIssueExpressionOutput(issueValue.match(ISSUE_OR_URL_EXPRESSION));
			if (tryParse && (!tryParse.name || !tryParse.owner)) {
				owner = origin.remote.owner;
				name = origin.remote.repositoryName;
			}
		} else {
			owner = parsed.owner ? parsed.owner : origin.remote.owner;
			name = parsed.name ? parsed.name : origin.remote.repositoryName;
			issueNumber = parsed.issueNumber;
		}

		if (owner && name && (issueNumber !== undefined)) {

			let issue = await manager.resolveIssue(owner, name, issueNumber);
			if (!issue) {
				issue = await manager.resolvePullRequest(owner, name, issueNumber);
			}
			if (issue) {
				cache.set(issueValue, issue);
			}

			return issue;
		}
	}
	return undefined;
}

export function issueMarkdown(issue: IssueModel): vscode.MarkdownString {
	const markdown: vscode.MarkdownString = new vscode.MarkdownString(undefined, true);
	const date = new Date(issue.createdAt);
	markdown.appendMarkdown(`${issue.remote.owner}/${issue.remote.repositoryName} on ${date.toLocaleString('default', { day: 'numeric', month: 'short', year: 'numeric' })}  \n`);
	markdown.appendMarkdown(`**${getIcon(issue)} ${issue.title}** [#${issue.number}](${issue.html_url})  \n`);
	const body = marked.parse(issue.body, {
		renderer: new PlainTextRenderer()
	});
	markdown.appendMarkdown(((body.length > 85) ? (body.substr(0, 130) + '...') : body) + '  \n');
	if (issue.item.labels.length > 0) {
		issue.item.labels.forEach(label => {
			markdown.appendMarkdown(`_${label.name}_ `);
		});
	}
	return markdown;
}

function getIcon(issue: IssueModel) {
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

export class PlainTextRenderer extends marked.Renderer {
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
