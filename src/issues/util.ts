/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';
import * as vscode from 'vscode';
import { PullRequestManager, PullRequestDefaults } from '../github/pullRequestManager';
import { IssueModel } from '../github/issueModel';
import { GithubItemStateEnum, User } from '../github/interface';
import { PullRequestModel } from '../github/pullRequestModel';
import { StateManager } from './stateManager';

export const ISSUE_EXPRESSION = /(([^\s]+)\/([^\s]+))?#([1-9][0-9]*)($|[\s\:\;\-\(\=])/;
export const ISSUE_OR_URL_EXPRESSION = /(https?:\/\/github\.com\/(([^\s]+)\/([^\s]+))\/[^\s]+\/([0-9]+))|(([^\s]+)\/([^\s]+))?#([1-9][0-9]*)($|[\s\:\;\-\(\=])/;

export const USER_EXPRESSION: RegExp = /\@([^\s]+)/;

export const MAX_LINE_LENGTH = 150;

export type ParsedIssue = { owner: string | undefined, name: string | undefined, issueNumber: number };
export const ISSUES_CONFIGURATION: string = 'githubIssues';
export const QUERIES_CONFIGURATION = 'queries';
export const DEFAULT_QUERY_CONFIGURATION = 'default';
export const BRANCH_NAME_CONFIGURATION = 'workingIssueBranch';
export const BRANCH_CONFIGURATION = 'useBranchForIssues';

export function parseIssueExpressionOutput(output: RegExpMatchArray | null): ParsedIssue | undefined {
	if (!output) {
		return undefined;
	}
	const issue: ParsedIssue = { owner: undefined, name: undefined, issueNumber: 0 };
	if (output.length === 6) {
		issue.owner = output[2];
		issue.name = output[3];
		issue.issueNumber = parseInt(output[4]);
		return issue;
	} else if (output.length === 11) {
		issue.owner = output[3] || output[7];
		issue.name = output[4] || output[8];
		issue.issueNumber = parseInt(output[5] || output[9]);
		return issue;
	} else {
		return undefined;
	}
}

export async function getIssue(stateManager: StateManager, manager: PullRequestManager, issueValue: string, parsed: ParsedIssue): Promise<IssueModel | undefined> {
	if (stateManager.resolvedIssues.has(issueValue)) {
		return stateManager.resolvedIssues.get(issueValue);
	} else {
		let owner: string | undefined = undefined;
		let name: string | undefined = undefined;
		let issueNumber: number | undefined = undefined;
		const remotes = manager.getGitHubRemotes();
		for (const remote of remotes) {
			if (!parsed) {
				const tryParse = parseIssueExpressionOutput(issueValue.match(ISSUE_OR_URL_EXPRESSION));
				if (tryParse && (!tryParse.name || !tryParse.owner)) {
					owner = remote.owner;
					name = remote.repositoryName;
				}
			} else {
				owner = parsed.owner ? parsed.owner : remote.owner;
				name = parsed.name ? parsed.name : remote.repositoryName;
				issueNumber = parsed.issueNumber;
			}

			if (owner && name && (issueNumber !== undefined)) {
				let issue = await manager.resolveIssue(owner, name, issueNumber);
				if (!issue) {
					issue = await manager.resolvePullRequest(owner, name, issueNumber);
				}
				if (issue) {
					stateManager.resolvedIssues.set(issueValue, issue);
					return issue;
				}
			}
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

export function userMarkdown(origin: PullRequestDefaults, user: User): vscode.MarkdownString {
	const markdown: vscode.MarkdownString = new vscode.MarkdownString(undefined, true);
	markdown.appendMarkdown(`![Avatar](${user.avatarUrl}|height=50,width=50) **${user.name}** [${user.login}](${user.url})`);
	if (user.bio) {
		markdown.appendText('  \r\n' + user.bio.replace(/\r\n/g, ' '));
	}

	const date = repoCommitDate(user, origin.owner + '/' + origin.repo);
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

function convertHexToRgb(hex: string): { r: number, g: number, b: number } | undefined {
	const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	return result ? {
		r: parseInt(result[1], 16),
		g: parseInt(result[2], 16),
		b: parseInt(result[3], 16)
	} : undefined;
}

function makeLabel(color: string, text: string): string {
	const rgbColor = convertHexToRgb(color);
	let textColor: string = 'white';
	if (rgbColor) {
		// Color algorithm from https://stackoverflow.com/questions/1855884/determine-font-color-based-on-background-color
		const luminance = (0.299 * rgbColor.r + 0.587 * rgbColor.g + 0.114 * rgbColor.b) / 255;
		if (luminance > 0.5) {
			textColor = 'black';
		}
	}

	return `<svg height="18" width="150" xmlns="http://www.w3.org/2000/svg">
	<style>
		:root {
			--light: 80;
			--threshold: 60;
		}
		.label {
			font-weight: bold;
			fill: ${textColor};
			font-family: sans-serif;
			--switch: calc((var(--light) - var(--threshold)) * -100%);
			color: hsl(0, 0%, var(--switch));
			font-size: 12px;
		}
  	</style>
	<defs>
		<filter y="-0.1" height="1.3" id="solid">
			<feFlood flood-color="#${color}"/>
			<feComposite in="SourceGraphic" />
		</filter>
	</defs>
  	<text filter="url(#solid)" class="label" y="13" xml:space="preserve">  ${text} </text>
</svg>`;
}

export const ISSUE_BODY_LENGTH: number = 200;
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
	body = ((body.length > ISSUE_BODY_LENGTH) ? (body.substr(0, ISSUE_BODY_LENGTH) + '...') : body);
	// Check the body for "links"
	let searchResult = body.search(ISSUE_OR_URL_EXPRESSION);
	let position = 0;
	while ((searchResult >= 0) && (searchResult < body.length)) {
		let newBodyFirstPart: string | undefined;
		if (searchResult === 0 || body.charAt(searchResult - 1) !== '&') {
			const match = body.substring(searchResult).match(ISSUE_OR_URL_EXPRESSION)!;
			const tryParse = parseIssueExpressionOutput(match);
			if (tryParse) {
				const issueNumberLabel = getIssueNumberLabelFromParsed(tryParse); // get label before setting owner and name.
				if (!tryParse.owner || !tryParse.name) {
					tryParse.owner = issue.remote.owner;
					tryParse.name = issue.remote.repositoryName;
				}
				newBodyFirstPart = body.slice(0, searchResult) + `[${issueNumberLabel}](https://github.com/${tryParse.owner}/${tryParse.name}/issues/${tryParse.issueNumber})`;
				body = newBodyFirstPart + body.slice(searchResult + match[0].length);
			}
		}
		position = newBodyFirstPart ? newBodyFirstPart.length : searchResult + 1;
		const newSearchResult = body.substring(position).search(ISSUE_OR_URL_EXPRESSION);
		searchResult = newSearchResult > 0 ? position + newSearchResult : newSearchResult;
	}
	markdown.appendMarkdown(body + '  \n');
	markdown.appendMarkdown('&nbsp;  \n');

	if (issue.item.labels.length > 0) {
		issue.item.labels.forEach(label => {
			const uri = 'data:image/svg+xml;utf8,' + encodeURIComponent(makeLabel(label.color, label.name));
			markdown.appendMarkdown(`[![](${uri})](https://github.com/${ownerName}/labels/${encodeURIComponent(label.name)}) `);
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

const VARIABLE_PATTERN = /\$\{(.*?)\}/g;
export async function variableSubstitution(value: string, issueModel: IssueModel, user?: string, repo?: PullRequestDefaults): Promise<string> {
	return value.replace(VARIABLE_PATTERN, (match: string, variable: string) => {
		switch (variable) {
			case 'user': return user ? user : '';
			case 'issueNumber': return `${issueModel.number}`;
			case 'issueNumberLabel': return `${getIssueNumberLabel(issueModel, repo)}`;
			case 'issueTitle': return issueModel.title;
			default: return match;
		}
	});
}

export function getIssueNumberLabel(issue: IssueModel, repo?: PullRequestDefaults) {
	const parsedIssue: ParsedIssue = { issueNumber: issue.number, owner: undefined, name: undefined };
	if (repo && ((repo.owner.toLowerCase() !== issue.remote.owner.toLowerCase()) || (repo.repo.toLowerCase() !== issue.remote.repositoryName.toLowerCase()))) {
		parsedIssue.owner = issue.remote.owner;
		parsedIssue.name = issue.remote.repositoryName;
	}
	return getIssueNumberLabelFromParsed(parsedIssue);

}

function getIssueNumberLabelFromParsed(parsed: ParsedIssue) {
	if (!parsed.owner || !parsed.name) {
		return `#${parsed.issueNumber}`;
	} else {
		return `${parsed.owner}/${parsed.name}#${parsed.issueNumber}`;
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
		return text + ' ';
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