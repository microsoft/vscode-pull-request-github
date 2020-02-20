/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as LRUCache from 'lru-cache';
import * as marked from 'marked';
import * as vscode from 'vscode';
import { PullRequestManager } from '../github/pullRequestManager';
import { IssueModel } from '../github/issueModel';
import { GithubItemStateEnum, User } from '../github/interface';
import { PullRequestModel } from '../github/pullRequestModel';
import { GitHubRepository } from '../github/githubRepository';

export const ISSUE_EXPRESSION = /(([^\s]+)\/([^\s]+))?#([1-9][0-9]*)/;
export const ISSUE_OR_URL_EXPRESSION = /(https?:\/\/github\.com\/(([^\s]+)\/([^\s]+))\/[^\s]+\/([0-9]+))|(([^\s]+)\/([^\s]+))?#([1-9][0-9]*)/;

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

function repoCommitDate(user: User, repoNameWithOwner: string): string | undefined {
	let date: string | undefined = undefined;
	user.commitContributions.forEach(element => {
		if (repoNameWithOwner.toLowerCase() === element.repoNameWithOwner.toLowerCase()) {
			date = element.createdAt.toLocaleString('default', { day: 'numeric', month: 'short', year: 'numeric' });
		}
	});
	return date;
}

export function userMarkdown(origin: GitHubRepository, user: User): vscode.MarkdownString {
	const markdown: vscode.MarkdownString = new vscode.MarkdownString(undefined, true);
	markdown.appendMarkdown(`![Avatar](${user.avatarUrl}) **${user.name}** [${user.login}](${user.url})`);
	if (user.bio) {
		markdown.appendText('  \r\n' + user.bio.replace(/\r\n/g, ' '));
	}

	const date = repoCommitDate(user, origin.remote.owner + '/' + origin.remote.repositoryName);
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
	return markdown;
}

export function issueMarkdown(issue: IssueModel): vscode.MarkdownString {
	const markdown: vscode.MarkdownString = new vscode.MarkdownString(undefined, true);
	const date = new Date(issue.createdAt);
	const ownerName = `${issue.remote.owner}/${issue.remote.repositoryName}`;
	markdown.appendMarkdown(`[${ownerName}](https://github.com/${ownerName}) on ${date.toLocaleString('default', { day: 'numeric', month: 'short', year: 'numeric' })}  \n`);
	markdown.appendMarkdown(`**${getIcon(issue)} ${issue.title}** [#${issue.number}](${issue.html_url})  \n`);
	let body = marked.parse(issue.body, {
		renderer: new PlainTextRenderer()
	});
	markdown.appendMarkdown('  \n');
	body = ((body.length > 200) ? (body.substr(0, 200) + '...') : body);
	// Check the body for "links"
	let searchResult = body.search(ISSUE_EXPRESSION);
	let position = 0;
	while ((searchResult >= 0) && (searchResult < body.length)) {
		let newBodyFirstPart: string | undefined;
		if (searchResult === 0 || body.charAt(searchResult - 1) !== '&') {
			const match = body.substring(searchResult).match(ISSUE_EXPRESSION)!;
			const tryParse = parseIssueExpressionOutput(match);
			if (tryParse) {
				if (!tryParse.owner || !tryParse.name) {
					tryParse.owner = issue.remote.owner;
					tryParse.name = issue.remote.repositoryName;
				}
				newBodyFirstPart = body.slice(0, searchResult + position) + `[${match[0]}](https://github.com/${tryParse.owner}/${tryParse.name}/issues/${tryParse.issueNumber})`;
				body = newBodyFirstPart + body.slice(position + searchResult + match[0].length);
			}
		}
		position = newBodyFirstPart ? newBodyFirstPart.length : searchResult + 1;
		const newSearchResult = body.substring(position).search(ISSUE_EXPRESSION);
		searchResult = newSearchResult > 0 ? position + newSearchResult : newSearchResult;
	}
	markdown.appendMarkdown(body + '  \n');
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

export interface NewIssue {
	document: vscode.TextDocument;
	lineNumber: number;
	line: string;
	insertIndex: number;
	range: vscode.Range | vscode.Selection;
}

export async function createGithubPermalink(manager: PullRequestManager, positionInfo?: NewIssue): Promise<string | undefined> {
	let document: vscode.TextDocument;
	let range: vscode.Range;
	if (!positionInfo && vscode.window.activeTextEditor) {
		document = vscode.window.activeTextEditor.document;
		range = vscode.window.activeTextEditor.selection;
	} else if (positionInfo) {
		document = positionInfo.document;
		range = positionInfo.range;
	} else {
		return undefined;
	}

	const origin = await manager.getOrigin();
	const pathSegment = vscode.Uri.parse(vscode.workspace.asRelativePath(document.uri)).toString().substring(8);
	if (manager.repository.state.HEAD && manager.repository.state.HEAD.commit && (manager.repository.state.HEAD.ahead === 0)) {
		return `https://github.com/${origin.remote.owner}/${origin.remote.repositoryName}/blob/${manager.repository.state.HEAD.commit}/${pathSegment}#L${range.start.line + 1}-L${range.end.line + 1}`;
	} else if (manager.repository.state.HEAD && manager.repository.state.HEAD.ahead && (manager.repository.state.HEAD.ahead > 0)) {
		return `https://github.com/${origin.remote.owner}/${origin.remote.repositoryName}/blob/${manager.repository.state.HEAD.upstream!.name}/${pathSegment}#L${range.start.line + 1}-L${range.end.line + 1}`;
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
