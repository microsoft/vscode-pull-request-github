/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URL } from 'url';
import LRUCache from 'lru-cache';
import * as marked from 'marked';
import 'url-search-params-polyfill';
import * as vscode from 'vscode';
import { gitHubLabelColor } from '../../src/common/utils';
import { Ref, Remote, Repository, UpstreamRef } from '../api/api';
import { GitApiImpl } from '../api/api1';
import Logger from '../common/logger';
import { Protocol } from '../common/protocol';
import { fromReviewUri, Schemes } from '../common/uri';
import { FolderRepositoryManager, NoGitHubReposError, PullRequestDefaults } from '../github/folderRepositoryManager';
import { GithubItemStateEnum, User } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';
import { getEnterpriseUri, getIssueNumberLabelFromParsed, getRepositoryForFile, ISSUE_OR_URL_EXPRESSION, ParsedIssue, parseIssueExpressionOutput } from '../github/utils';
import { ReviewManager } from '../view/reviewManager';
import { CODE_PERMALINK, findCodeLinkLocally } from './issueLinkLookup';
import { StateManager } from './stateManager';

export const USER_EXPRESSION: RegExp = /\@([^\s]+)/;

export const MAX_LINE_LENGTH = 150;
export const PERMALINK_COMPONENT = 'Permalink';

export async function getIssue(
	stateManager: StateManager,
	manager: FolderRepositoryManager,
	issueValue: string,
	parsed: ParsedIssue,
): Promise<IssueModel | undefined> {
	const alreadyResolved = stateManager.resolvedIssues.get(manager.repository.rootUri.path)?.get(issueValue);
	if (alreadyResolved) {
		return alreadyResolved;
	} else {
		let owner: string | undefined = undefined;
		let name: string | undefined = undefined;
		let issueNumber: number | undefined = undefined;
		const remotes = await manager.getGitHubRemotes();
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

			if (owner && name && issueNumber !== undefined) {
				let issue = await manager.resolveIssue(owner, name, issueNumber, !!parsed.commentNumber);
				if (!issue) {
					issue = await manager.resolvePullRequest(owner, name, issueNumber);
				}
				if (issue) {
					let cached: LRUCache<string, IssueModel>;
					if (!stateManager.resolvedIssues.has(manager.repository.rootUri.path)) {
						stateManager.resolvedIssues.set(
							manager.repository.rootUri.path,
							(cached = new LRUCache<string, IssueModel>(50)),
						);
					} else {
						cached = stateManager.resolvedIssues.get(manager.repository.rootUri.path)!;
					}
					cached.set(issueValue, issue);
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

export class UserCompletion extends vscode.CompletionItem {
	login: string;
	uri: vscode.Uri;
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

function makeLabel(color: string, text: string): string {
	const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
	const labelColor = gitHubLabelColor(color, isDarkTheme, true);
	return `<span style="color:${labelColor.textColor};background-color:${labelColor.backgroundColor};">&nbsp;&nbsp;${text}&nbsp;&nbsp;</span>`;
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
	const title = marked
		.parse(issue.title, {
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
	markdown.appendMarkdown('&nbsp;  \n');

	if (issue.item.labels.length > 0) {
		issue.item.labels.forEach(label => {
			markdown.appendMarkdown(
				`[${makeLabel(label.color, label.name)}](https://github.com/${ownerName}/labels/${encodeURIComponent(
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
	return markdown;
}

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
			return `<span style="color:#cb2431;">$(issue-closed)</span>`;
		}
	}
}

export interface NewIssue {
	document: vscode.TextDocument;
	lineNumber: number;
	line: string;
	insertIndex: number;
	range: vscode.Range | vscode.Selection;
}

export interface IssueTemplate {
	name: string | undefined,
	about: string | undefined,
	title: string | undefined,
	body: string | undefined
}

const HEAD = 'HEAD';
const UPSTREAM = 1;
const UPS = 2;
const ORIGIN = 3;
const OTHER = 4;
const REMOTE_CONVENTIONS = new Map([
	['upstream', UPSTREAM],
	['ups', UPS],
	['origin', ORIGIN],
]);

async function getUpstream(repositoriesManager: RepositoriesManager, repository: Repository, commitHash: string): Promise<Remote | undefined> {
	const currentRemoteName: string | undefined =
		repository.state.HEAD?.upstream && !REMOTE_CONVENTIONS.has(repository.state.HEAD.upstream.remote)
			? repository.state.HEAD.upstream.remote
			: undefined;
	let currentRemote: Remote | undefined;
	// getBranches is slow if we don't pass a very specific pattern
	// so we can't just get all branches then filter/sort.
	// Instead, we need to create parameters for getBranches such that there is only ever on possible return value,
	// which makes it much faster.
	// To do this, create very specific remote+branch patterns to look for and sort from "best" to "worst".
	// Then, call getBranches with each pattern until one of them succeeds.
	const remoteNames: { name: string; remote?: Remote }[] = repository.state.remotes
		.map(remote => {
			return { name: remote.name, remote };
		})
		.filter(value => {
			// While we're already here iterating through all values, find the current remote for use later.
			if (value.name === currentRemoteName) {
				currentRemote = value.remote;
			}
			return REMOTE_CONVENTIONS.has(value.name);
		})
		.sort((a, b): number => {
			const aVal = REMOTE_CONVENTIONS.get(a.name) ?? OTHER;
			const bVal = REMOTE_CONVENTIONS.get(b.name) ?? OTHER;
			return aVal - bVal;
		});

	if (currentRemoteName) {
		remoteNames.push({ name: currentRemoteName, remote: currentRemote });
	}

	const branchNames = [HEAD];
	if (repository.state.HEAD?.name && repository.state.HEAD.name !== HEAD) {
		branchNames.unshift(repository.state.HEAD?.name);
	}
	let defaultBranch: PullRequestDefaults | undefined;
	try {
		defaultBranch = await repositoriesManager.getManagerForFile(repository.rootUri)?.getPullRequestDefaults();
	} catch (e) {
		if (!(e instanceof NoGitHubReposError)) {
			throw e;
		}
	}
	if (defaultBranch) {
		branchNames.push(defaultBranch.base);
	}
	let bestRef: Ref | undefined;
	let bestRemote: Remote | undefined;
	for (let branchIndex = 0; branchIndex < branchNames.length && !bestRef; branchIndex++) {
		for (let remoteIndex = 0; remoteIndex < remoteNames.length && !bestRef; remoteIndex++) {
			try {
				const remotes = (
					await repository.getBranches({
						contains: commitHash,
						remote: true,
						pattern: `remotes/${remoteNames[remoteIndex].name}/${branchNames[branchIndex]}`,
						count: 1,
					})
				).filter(value => value.remote && value.name);
				if (remotes && remotes.length > 0) {
					bestRef = remotes[0];
					bestRemote = remoteNames[remoteIndex].remote;
				}
			} catch (e) {
				// continue
			}
		}
	}

	return bestRemote;
}

function extractContext(context: LinkContext): { fileUri: vscode.Uri | undefined, lineNumber: number | undefined } {
	if (context instanceof vscode.Uri) {
		return { fileUri: context, lineNumber: undefined };
	} else if (context !== undefined && 'lineNumber' in context && 'uri' in context) {
		return { fileUri: context.uri, lineNumber: context.lineNumber };
	} else {
		return { fileUri: undefined, lineNumber: undefined };
	}
}

function getFileAndPosition(context: LinkContext, positionInfo?: NewIssue): { uri: vscode.Uri | undefined, range: vscode.Range | vscode.NotebookRange | undefined } {
	Logger.debug(`getting file and position`, PERMALINK_COMPONENT);
	let uri: vscode.Uri;
	let range: vscode.Range | vscode.NotebookRange | undefined;

	const { fileUri, lineNumber } = extractContext(context);

	if (fileUri) {
		uri = fileUri;
		if (vscode.window.activeTextEditor?.document.uri.fsPath === uri.fsPath && !vscode.window.activeNotebookEditor) {
			if (lineNumber !== undefined && (vscode.window.activeTextEditor.selection.isEmpty || !vscode.window.activeTextEditor.selection.contains(new vscode.Position(lineNumber - 1, 0)))) {
				range = new vscode.Range(new vscode.Position(lineNumber - 1, 0), new vscode.Position(lineNumber - 1, 1));
			} else {
				range = vscode.window.activeTextEditor.selection;
			}
		}
	} else if (!positionInfo && vscode.window.activeTextEditor) {
		uri = vscode.window.activeTextEditor.document.uri;
		range = vscode.window.activeTextEditor.selection;
	} else if (!positionInfo && vscode.window.activeNotebookEditor) {
		uri = vscode.window.activeNotebookEditor.notebook.uri;
		range = vscode.window.activeNotebookEditor.selection;
	} else if (!positionInfo && vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom) {
		uri = vscode.window.tabGroups.activeTabGroup.activeTab.input.uri;
	} else if (positionInfo) {
		uri = positionInfo.document.uri;
		range = positionInfo.range;
	} else {
		return { uri: undefined, range: undefined };
	}
	Logger.debug(`got file and position: ${uri.fsPath} ${range?.start ? (range.start instanceof vscode.Position ? `${range.start.line}:${range.start.character}` : range.start) : 'unknown'}`, PERMALINK_COMPONENT);
	return { uri, range };
}

export interface PermalinkInfo {
	permalink: string | undefined;
	error: string | undefined;
	originalFile: vscode.Uri | undefined;
}

export function getSimpleUpstream(repository: Repository) {
	const upstream: UpstreamRef | undefined = repository.state.HEAD?.upstream;
	for (const remote of repository.state.remotes) {
		// If we don't have an upstream, then just use the first remote.
		if (!upstream || (upstream.remote === remote.name)) {
			return remote;
		}
	}
}

export async function getBestPossibleUpstream(repositoriesManager: RepositoriesManager, repository: Repository, commitHash: string | undefined): Promise<Remote | undefined> {
	const fallbackUpstream = new Promise<Remote | undefined>(resolve => {
		resolve(getSimpleUpstream(repository));
	});

	let upstream: Remote | undefined = commitHash ? await Promise.race([
		getUpstream(repositoriesManager, repository, commitHash),
		new Promise<Remote | undefined>(resolve => {
			setTimeout(() => {
				resolve(fallbackUpstream);
			}, 1500);
		}),
	]) : await fallbackUpstream;

	if (!upstream || !upstream.fetchUrl) {
		// Check fallback
		upstream = await fallbackUpstream;
		if (!upstream || !upstream.fetchUrl) {
			return undefined;
		}
	}
	return upstream;
}

export function getOwnerAndRepo(repositoriesManager: RepositoriesManager, repository: Repository, upstream: Remote & { fetchUrl: string }): string {
	const folderManager = repositoriesManager.getManagerForFile(repository.rootUri);
	// Find the GitHub repository that matches the chosen upstream remote
	const githubRepository = folderManager?.gitHubRepositories.find(githubRepository => {
		return githubRepository.remote.remoteName === upstream.name;
	});
	if (githubRepository) {
		return `${githubRepository.remote.owner}/${githubRepository.remote.repositoryName}`;
	} else {
		return new Protocol(upstream.fetchUrl).nameWithOwner;
	}
}

export async function createGithubPermalink(
	repositoriesManager: RepositoriesManager,
	gitAPI: GitApiImpl,
	includeRange: boolean,
	includeFile: boolean,
	positionInfo?: NewIssue,
	context?: LinkContext
): Promise<PermalinkInfo> {
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, async (progress) => {
		progress.report({ message: vscode.l10n.t('Creating permalink...') });
		const { uri, range } = getFileAndPosition(context, positionInfo);
		if (!uri) {
			return { permalink: undefined, error: vscode.l10n.t('No active text editor position to create permalink from.'), originalFile: undefined };
		}

		const repository = getRepositoryForFile(gitAPI, uri);
		if (!repository) {
			return { permalink: undefined, error: vscode.l10n.t('The current file isn\'t part of repository.'), originalFile: uri };
		}

		let commitHash: string | undefined;
		if (uri.scheme === Schemes.Review) {
			commitHash = fromReviewUri(uri.query).commit;
		}

		if (!commitHash) {
			try {
				const log = await repository.log({ maxEntries: 1, path: uri.fsPath });
				if (log.length === 0) {
					return { permalink: undefined, error: vscode.l10n.t('No branch on a remote contains the most recent commit for the file.'), originalFile: uri };
				}
				// Now that we know that the file existed at some point in the repo, use the head commit to construct the URI.
				if (repository.state.HEAD?.commit && (log[0].hash !== repository.state.HEAD?.commit)) {
					commitHash = repository.state.HEAD.commit;
				} else {
					commitHash = log[0].hash;
				}
			} catch (e) {
				commitHash = repository.state.HEAD?.commit;
			}
		}

		Logger.debug(`commit hash: ${commitHash}`, PERMALINK_COMPONENT);

		const rawUpstream = await getBestPossibleUpstream(repositoriesManager, repository, commitHash);
		if (!rawUpstream || !rawUpstream.fetchUrl) {
			return { permalink: undefined, error: vscode.l10n.t('The selection may not exist on any remote.'), originalFile: uri };
		}
		const upstream: Remote & { fetchUrl: string } = rawUpstream as any;

		Logger.debug(`upstream: ${upstream.fetchUrl}`, PERMALINK_COMPONENT);

		const encodedPathSegment = encodeURIComponentExceptSlashes(uri.path.substring(repository.rootUri.path.length));
		const originOfFetchUrl = getUpstreamOrigin(rawUpstream).replace(/\/$/, '');
		const result = {
			permalink: (`${originOfFetchUrl}/${getOwnerAndRepo(repositoriesManager, repository, upstream)}/blob/${commitHash
				}${includeFile ? `${encodedPathSegment}${includeRange ? rangeString(range) : ''}` : ''}`),
			error: undefined,
			originalFile: uri
		};
		Logger.debug(`permalink generated: ${result.permalink}`, PERMALINK_COMPONENT);
		return result;
	});
}

export function getUpstreamOrigin(upstream: Remote, resultHost: string = 'github.com') {
	const enterpriseUri = getEnterpriseUri();
	let fetchUrl = upstream.fetchUrl;
	if (enterpriseUri && fetchUrl) {
		// upstream's origin by https
		if (fetchUrl.startsWith('https://') && !fetchUrl.startsWith('https://github.com/')) {
			const host = new URL(fetchUrl).host;
			if (host.startsWith(enterpriseUri.authority) || !host.includes('github.com')) {
				resultHost = enterpriseUri.authority;
			}
		}
		if (fetchUrl.startsWith('ssh://')) {
			fetchUrl = fetchUrl.substr('ssh://'.length);
		}
		// upstream's origin by ssh
		if (fetchUrl.startsWith('git@') && !fetchUrl.startsWith('git@github.com')) {
			const host = fetchUrl.split('@')[1]?.split(':')[0];
			if (host.startsWith(enterpriseUri.authority) || !host.includes('github.com')) {
				resultHost = enterpriseUri.authority;
			}
		}
	}
	return `https://${resultHost}`;
}

export function encodeURIComponentExceptSlashes(path: string) {
	// There may be special characters like # and whitespace in the path.
	// These characters are not escaped by encodeURI(), so it is not sufficient to
	// feed the full URI to encodeURI().
	// Additonally, if we feed the full path into encodeURIComponent(),
	// this will also encode the path separators, leading to an invalid path.
	// Therefore, split on the path separator and encode each segment individually.
	return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export function rangeString(range: vscode.Range | vscode.NotebookRange | undefined) {
	if (!range || (range instanceof vscode.NotebookRange)) {
		return '';
	}
	let hash = `#L${range.start.line + 1}`;
	if (range.start.line !== range.end.line) {
		hash += `-L${range.end.line + 1}`;
	}
	return hash;
}

interface EditorLineNumberContext {
	uri: vscode.Uri;
	lineNumber: number;
}
export type LinkContext = vscode.Uri | EditorLineNumberContext | undefined;

export async function createGitHubLink(
	managers: RepositoriesManager,
	context: LinkContext,
	includeRange?: boolean
): Promise<PermalinkInfo> {
	const { uri, range } = getFileAndPosition(context);
	if (!uri) {
		return { permalink: undefined, error: vscode.l10n.t('No active text editor position to create permalink from.'), originalFile: undefined };
	}
	const folderManager = managers.getManagerForFile(uri);
	if (!folderManager) {
		return { permalink: undefined, error: vscode.l10n.t('Current file does not belong to an open repository.'), originalFile: undefined };
	}
	let branchName = folderManager.repository.state.HEAD?.name;
	if (!branchName) {
		// Fall back to default branch name if we are not currently on a branch
		const origin = await folderManager.getOrigin();
		const metadata = await origin.getMetadata();
		branchName = metadata.default_branch;
	}
	const upstream = getSimpleUpstream(folderManager.repository);
	if (!upstream?.fetchUrl) {
		return { permalink: undefined, error: vscode.l10n.t('Repository does not have any remotes.'), originalFile: undefined };
	}
	const pathSegment = uri.path.substring(folderManager.repository.rootUri.path.length);
	const originOfFetchUrl = getUpstreamOrigin(upstream).replace(/\/$/, '');
	const encodedBranchAndFilePath = encodeURIComponentExceptSlashes(`${branchName}${pathSegment}`);
	return {
		permalink: (`${originOfFetchUrl}/${new Protocol(upstream.fetchUrl).nameWithOwner}/blob/${encodedBranchAndFilePath
			}${includeRange ? rangeString(range) : ''}`),
		error: undefined,
		originalFile: uri
	};
}

async function commitWithDefault(manager: FolderRepositoryManager, stateManager: StateManager, all: boolean) {
	const message = await stateManager.currentIssue(manager.repository.rootUri)?.getCommitMessage();
	if (message) {
		return manager.repository.commit(message, { all });
	}
}

const commitStaged = vscode.l10n.t('Commit Staged');
const commitAll = vscode.l10n.t('Commit All');
export async function pushAndCreatePR(
	manager: FolderRepositoryManager,
	reviewManager: ReviewManager,
	stateManager: StateManager,
): Promise<boolean> {
	if (manager.repository.state.workingTreeChanges.length > 0 || manager.repository.state.indexChanges.length > 0) {
		const responseOptions: string[] = [];
		if (manager.repository.state.indexChanges) {
			responseOptions.push(commitStaged);
		}
		if (manager.repository.state.workingTreeChanges) {
			responseOptions.push(commitAll);
		}
		const changesResponse = await vscode.window.showInformationMessage(
			vscode.l10n.t('There are uncommitted changes. Do you want to commit them with the default commit message?'),
			{ modal: true },
			...responseOptions,
		);
		switch (changesResponse) {
			case commitStaged: {
				await commitWithDefault(manager, stateManager, false);
				break;
			}
			case commitAll: {
				await commitWithDefault(manager, stateManager, true);
				break;
			}
			default:
				return false;
		}
	}

	if (manager.repository.state.HEAD?.upstream) {
		await manager.repository.push();
		await reviewManager.createPullRequest(undefined);
		return true;
	} else {
		let remote: string | undefined;
		if (manager.repository.state.remotes.length === 1) {
			remote = manager.repository.state.remotes[0].name;
		} else if (manager.repository.state.remotes.length > 1) {
			remote = await vscode.window.showQuickPick(
				manager.repository.state.remotes.map(value => value.name),
				{ placeHolder: vscode.l10n.t('Remote to push to') },
			);
		}
		if (remote) {
			await manager.repository.push(remote, manager.repository.state.HEAD?.name, true);
			await reviewManager.createPullRequest(undefined);
			return true;
		} else {
			vscode.window.showWarningMessage(
				vscode.l10n.t('The current repository has no remotes to push to. Please set up a remote and try again.'),
			);
			return false;
		}
	}
}

export async function isComment(document: vscode.TextDocument, position: vscode.Position): Promise<boolean> {
	if (document.languageId !== 'markdown' && document.languageId !== 'plaintext') {
		const tokenInfo = await vscode.languages.getTokenInformationAtPosition(document, position);
		if (tokenInfo.type !== vscode.StandardTokenType.Comment) {
			return false;
		}
	}
	return true;
}

export async function shouldShowHover(document: vscode.TextDocument, position: vscode.Position): Promise<boolean> {
	if (document.lineAt(position.line).range.end.character > 10000) {
		return false;
	}

	return isComment(document, position);
}

export function getRootUriFromScmInputUri(uri: vscode.Uri): vscode.Uri | undefined {
	const rootUri = new URLSearchParams(uri.query).get('rootUri');
	return rootUri ? vscode.Uri.parse(rootUri) : undefined;
}

export class PlainTextRenderer extends marked.Renderer {
	code(code: string): string {
		return code;
	}
	blockquote(quote: string): string {
		return quote;
	}
	html(_html: string): string {
		return '';
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
		return text.replace(/\</g, '\\\<').replace(/\>/g, '\\\>') + ' ';
	}
	table(header: string, body: string): string {
		return header + ' ' + body;
	}
	tablerow(content: string): string {
		return content;
	}
	tablecell(
		content: string,
		_flags: {
			header: boolean;
			align: 'center' | 'left' | 'right' | null;
		},
	): string {
		return content;
	}
	strong(text: string): string {
		return text;
	}
	em(text: string): string {
		return text;
	}
	codespan(code: string): string {
		return `\\\`${code}\\\``;
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
