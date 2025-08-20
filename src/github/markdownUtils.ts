/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';
import 'url-search-params-polyfill';
import * as vscode from 'vscode';
import { ensureEmojis } from '../common/emoji';
import Logger from '../common/logger';
import { CODE_PERMALINK, findCodeLinkLocally } from '../issues/issueLinkLookup';
import { PullRequestDefaults } from './folderRepositoryManager';
import { GithubItemStateEnum, User } from './interface';
import { IssueModel } from './issueModel';
import { PullRequestModel } from './pullRequestModel';
import { RepositoriesManager } from './repositoriesManager';
import { getIssueNumberLabelFromParsed, ISSUE_OR_URL_EXPRESSION, makeLabel, parseIssueExpressionOutput, UnsatisfiedChecks } from './utils';

function getIconString(issue: IssueModel) {
	switch (issue.state) {
		case GithubItemStateEnum.Open: {
			return issue instanceof PullRequestModel ? '$(git-pull-request)' : '$(issues)';
		}
		case GithubItemStateEnum.Closed: {
			return issue instanceof PullRequestModel ? '$(git-pull-request)' : '$(issue-closed)';
		}
		case GithubItemStateEnum.Merged:
			return '$(git-merge)';
	}
}

function getIconMarkdown(issue: IssueModel) {
	if (issue instanceof PullRequestModel) {
		return getIconString(issue);
	}
	switch (issue.state) {
		case GithubItemStateEnum.Open: {
			return `<span style="color:#22863a;">$(issues)</span>`;
		}
		case GithubItemStateEnum.Closed: {
			// Use grey for issues closed as "not planned", purple for "completed"
			const color = issue.stateReason === 'NOT_PLANNED' ? '#6a737d' : '#8957e5';
			return `<span style="color:${color};">$(issue-closed)</span>`;
		}
	}
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
	markdown.appendMarkdown(
		`![Avatar](${user.avatarUrl}|height=50,width=50) ${user.name ? `**${user.name}** ` : ''}[${user.login}](${user.url})`,
	);
	if (user.bio) {
		markdown.appendText('  \r\n' + user.bio.replace(/\r\n/g, ' '));
	}

	const date = repoCommitDate(user, origin.owner + '/' + origin.repo);
	if (user.location || date) {
		markdown.appendMarkdown('  \r\n\r\n---');
	}
	if (user.location) {
		markdown.appendMarkdown(`  \r\n${vscode.l10n.t('{0} {1}', '$(location)', user.location)}`);
	}
	if (date) {
		markdown.appendMarkdown(`  \r\n${vscode.l10n.t('{0} Committed to this repository on {1}', '$(git-commit)', date)}`);
	}
	if (user.company) {
		markdown.appendMarkdown(`  \r\n${vscode.l10n.t({ message: '{0} Member of {1}', args: ['$(jersey)', user.company], comment: ['An organization that the user is a member of.', 'The first placeholder is an icon and shouldn\'t be localized.', 'The second placeholder is the name of the organization.'] })}`);
	}
	return markdown;
}

async function findAndModifyString(
	text: string,
	find: RegExp,
	transformer: (match: RegExpMatchArray) => Promise<string | undefined>,
): Promise<string> {
	let searchResult = text.search(find);
	let position = 0;
	while (searchResult >= 0 && searchResult < text.length) {
		let newBodyFirstPart: string | undefined;
		if (searchResult === 0 || text.charAt(searchResult - 1) !== '&') {
			const match = text.substring(searchResult).match(find)!;
			if (match) {
				const transformed = await transformer(match);
				if (transformed) {
					newBodyFirstPart = text.slice(0, searchResult) + transformed;
					text = newBodyFirstPart + text.slice(searchResult + match[0].length);
				}
			}
		}
		position = newBodyFirstPart ? newBodyFirstPart.length : searchResult + 1;
		const newSearchResult = text.substring(position).search(find);
		searchResult = newSearchResult > 0 ? position + newSearchResult : newSearchResult;
	}
	return text;
}

function findLinksInIssue(body: string, issue: IssueModel): Promise<string> {
	return findAndModifyString(body, ISSUE_OR_URL_EXPRESSION, async (match: RegExpMatchArray) => {
		const tryParse = parseIssueExpressionOutput(match);
		if (tryParse) {
			const issueNumberLabel = getIssueNumberLabelFromParsed(tryParse); // get label before setting owner and name.
			if (!tryParse.owner || !tryParse.name) {
				tryParse.owner = issue.remote.owner;
				tryParse.name = issue.remote.repositoryName;
			}
			return `[${issueNumberLabel}](https://github.com/${tryParse.owner}/${tryParse.name}/issues/${tryParse.issueNumber})`;
		}
		return undefined;
	});
}

async function findCodeLinksInIssue(body: string, repositoriesManager: RepositoriesManager) {
	return findAndModifyString(body, CODE_PERMALINK, async (match: RegExpMatchArray) => {
		const codeLink = await findCodeLinkLocally(match, repositoriesManager);
		if (codeLink) {
			Logger.trace('finding code links in issue', 'Issues');
			const textDocument = await vscode.workspace.openTextDocument(codeLink?.file);
			const endingTextDocumentLine = textDocument.lineAt(
				codeLink.end < textDocument.lineCount ? codeLink.end : textDocument.lineCount - 1,
			);
			const query = [
				codeLink.file,
				{
					selection: {
						start: {
							line: codeLink.start,
							character: 0,
						},
						end: {
							line: codeLink.end,
							character: endingTextDocumentLine.text.length,
						},
					},
				},
			];
			const openCommand = vscode.Uri.parse(`command:vscode.open?${encodeURIComponent(JSON.stringify(query))}`);
			return `[${match[0]}](${openCommand} "Open ${codeLink.file.fsPath}")`;
		}
		return undefined;
	});
}

export const ISSUE_BODY_LENGTH: number = 200;
export async function issueMarkdown(
	issue: IssueModel,
	context: vscode.ExtensionContext,
	repositoriesManager: RepositoriesManager,
	commentNumber?: number,
	prChecks?: UnsatisfiedChecks
): Promise<vscode.MarkdownString> {
	const markdown: vscode.MarkdownString = new vscode.MarkdownString(undefined, true);
	markdown.supportHtml = true;
	const date = new Date(issue.createdAt);
	const ownerName = `${issue.remote.owner}/${issue.remote.repositoryName}`;
	markdown.appendMarkdown(
		`[${ownerName}](https://github.com/${ownerName}) on ${date.toLocaleString('default', {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
		})}  \n`,
	);
	const titleWithDraft = (issue instanceof PullRequestModel && issue.isDraft) ? `\[DRAFT\] ${issue.title}` : issue.title;
	const title = marked
		.parse(titleWithDraft, {
			renderer: new PlainTextRenderer(),
		})
		.trim();
	markdown.appendMarkdown(
		`${getIconMarkdown(issue)} **${title}** [#${issue.number}](${issue.html_url})  \n`,
	);
	let body = marked.parse(issue.body, {
		renderer: new PlainTextRenderer(),
	});
	markdown.appendMarkdown('  \n');
	body = body.length > ISSUE_BODY_LENGTH ? body.substr(0, ISSUE_BODY_LENGTH) + '...' : body;
	body = await findLinksInIssue(body, issue);
	body = await findCodeLinksInIssue(body, repositoriesManager);

	markdown.appendMarkdown(body + '  \n');

	if (issue.item.labels.length > 0) {
		await ensureEmojis(context);
		markdown.appendMarkdown('&nbsp;  \n');
		issue.item.labels.forEach(label => {
			markdown.appendMarkdown(
				`[${makeLabel(label)}](https://github.com/${ownerName}/labels/${encodeURIComponent(
					label.name,
				)}) `,
			);
		});
	}

	if (issue.item.comments && commentNumber) {
		for (const comment of issue.item.comments) {
			if (comment.databaseId === commentNumber) {
				markdown.appendMarkdown('  \r\n\r\n---\r\n');
				markdown.appendMarkdown('&nbsp;  \n');
				markdown.appendMarkdown(
					`![Avatar](${comment.author.avatarUrl}|height=15,width=15) &nbsp;&nbsp;**${comment.author.login}** commented`,
				);
				markdown.appendMarkdown('&nbsp;  \n');
				let commentText = marked.parse(
					comment.body.length > ISSUE_BODY_LENGTH
						? comment.body.substr(0, ISSUE_BODY_LENGTH) + '...'
						: comment.body,
					{ renderer: new PlainTextRenderer() },
				);
				commentText = await findLinksInIssue(commentText, issue);
				markdown.appendMarkdown(commentText);
			}
		}
	}

	if (prChecks) {
		const statusMessage = getStatusDecoration(prChecks)?.tooltip;
		if (statusMessage) {
			markdown.appendMarkdown('  \r\n\r\n');
			markdown.appendMarkdown(`_${statusMessage}_`);
		}
	}

	return markdown;
}

export class PlainTextRenderer extends marked.Renderer {
	override code(code: string, _infostring: string | undefined): string {
		return code;
	}
	override blockquote(quote: string): string {
		return quote;
	}
	override html(_html: string): string {
		return '';
	}
	override heading(text: string, _level: 1 | 2 | 3 | 4 | 5 | 6, _raw: string, _slugger: marked.Slugger): string {
		return text + ' ';
	}
	override hr(): string {
		return '';
	}
	override list(body: string, _ordered: boolean, _start: number): string {
		return body;
	}
	override listitem(text: string): string {
		return ' ' + text;
	}
	override checkbox(_checked: boolean): string {
		return '';
	}
	override paragraph(text: string): string {
		return text.replace(/\</g, '\\\<').replace(/\>/g, '\\\>') + ' ';
	}
	override table(header: string, body: string): string {
		return header + ' ' + body;
	}
	override tablerow(content: string): string {
		return content;
	}
	override tablecell(
		content: string,
		_flags: {
			header: boolean;
			align: 'center' | 'left' | 'right' | null;
		},
	): string {
		return content;
	}
	override strong(text: string): string {
		return text;
	}
	override em(text: string): string {
		return text;
	}
	override codespan(code: string): string {
		return `\\\`${code}\\\``;
	}
	override br(): string {
		return ' ';
	}
	override del(text: string): string {
		return text;
	}
	override image(_href: string, _title: string, _text: string): string {
		return '';
	}
	override text(text: string): string {
		return text;
	}
	override link(href: string, title: string, text: string): string {
		return text + ' ';
	}
}

export function getStatusDecoration(status: UnsatisfiedChecks): vscode.FileDecoration2 | undefined {
	if ((status & UnsatisfiedChecks.CIFailed) && (status & UnsatisfiedChecks.ReviewRequired)) {
		return {
			propagate: false,
			badge: new vscode.ThemeIcon('close', new vscode.ThemeColor('list.errorForeground')),
			tooltip: 'Review required and some checks have failed'
		};
	} else if (status & UnsatisfiedChecks.CIFailed) {
		return {
			propagate: false,
			badge: new vscode.ThemeIcon('close', new vscode.ThemeColor('list.errorForeground')),
			tooltip: 'Some checks have failed'
		};
	} else if (status & UnsatisfiedChecks.ChangesRequested) {
		return {
			propagate: false,
			badge: new vscode.ThemeIcon('request-changes', new vscode.ThemeColor('list.errorForeground')),
			tooltip: 'Changes requested'
		};
	} else if (status & UnsatisfiedChecks.CIPending) {
		return {
			propagate: false,
			badge: new vscode.ThemeIcon('sync', new vscode.ThemeColor('list.warningForeground')),
			tooltip: 'Checks pending'
		};
	} else if (status & UnsatisfiedChecks.ReviewRequired) {
		return {
			propagate: false,
			badge: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('list.warningForeground')),
			tooltip: 'Review required'
		};
	} else if (status === UnsatisfiedChecks.None) {
		return {
			propagate: false,
			badge: new vscode.ThemeIcon('check-all', new vscode.ThemeColor('issues.open')),
			tooltip: 'All checks passed'
		};
	}

}