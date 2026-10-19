/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { MarkdownPreviewCommentInfo } from './reviewCommentController';
import { ReviewManager } from './reviewManager';
import { ReviewsManager } from './reviewsManager';
import { DiffSide, SubjectType } from '../common/comment';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { fromPRUri, fromReviewUri, Schemes, UriHandlerPaths } from '../common/uri';
import { isDescendant } from '../common/utils';
import { EXTENSION_ID } from '../constants';
import { PullRequestModel } from '../github/pullRequestModel';
import { RepositoriesManager } from '../github/repositoriesManager';

/**
 * Must match the id used by the markdown preview script in webviews/markdownPreviewComments.
 */
const PREVIEW_DATA_ELEMENT_ID = 'github-pr-markdown-preview-comments';
const END_LINE_ATTRIBUTE = 'data-pr-end-line';
const UPDATE_DELAY_MS = 300;

let instance: MarkdownPreviewComments | undefined;

/**
 * The subset of the markdown-it API that is used to extend the markdown preview.
 */
interface MarkdownItToken {
	type: string;
	nesting: number;
	map: [number, number] | null;
	attrSet(name: string, value: string): void;
}

interface MarkdownIt {
	core: { ruler: { push(name: string, rule: (state: { tokens: MarkdownItToken[] }) => void): void } };
	renderer: { render(tokens: MarkdownItToken[], options: unknown, env: { currentDocument?: vscode.Uri } | undefined): string };
}

/**
 * Exported from the extension's `activate` so that the built-in markdown extension can
 * extend the markdown-it instance used to render the markdown preview.
 */
export function extendMarkdownIt<T extends MarkdownIt>(md: T): T {
	// Record the last line of each block so that the preview script knows which lines a block spans.
	md.core.ruler.push('github_pr_end_line', state => {
		for (const token of state.tokens) {
			if (token.map && token.nesting !== -1 && token.type !== 'inline') {
				token.attrSet(END_LINE_ATTRIBUTE, String(Math.max(token.map[0], token.map[1] - 1)));
			}
		}
	});

	// Tokens are cached by the markdown extension, so comment information is added at render time instead.
	const render = md.renderer.render;
	md.renderer.render = function (tokens, options, env) {
		const html = render.call(this, tokens, options, env);
		return instance ? html + instance.renderPreviewData(env?.currentDocument) : html;
	};
	return md;
}

/**
 * Connects the markdown preview, including the rendered diff, to the comment controllers of pull requests,
 * so that comments can be added from the preview.
 */
export class MarkdownPreviewComments extends Disposable {
	private static readonly ID = 'MarkdownPreviewComments';
	/**
	 * Comment information for every markdown document that has been rendered, keyed by document URI.
	 * The value is undefined for documents that aren't part of a checked out pull request.
	 */
	private readonly _info = new Map<string, MarkdownPreviewCommentInfo | undefined>();
	private readonly _updateTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/**
	 * Comment links from the preview identify their document by an id instead of its URI,
	 * so that only documents that have been rendered in a preview can be targeted.
	 */
	private readonly _documentIds = new Map<string, string>();
	private readonly _documentsById = new Map<string, vscode.Uri>();
	/**
	 * Pull requests that aren't checked out, whose review threads are being listened to.
	 */
	private readonly _listenedPullRequests = new WeakSet<PullRequestModel>();

	constructor(private readonly _reviewsManager: ReviewsManager, private readonly _reposManager: RepositoriesManager) {
		super();
		instance = this;
		this._register({
			dispose: () => {
				instance = undefined;
				this._updateTimers.forEach(timer => clearTimeout(timer));
			}
		});
		this._register(this._reviewsManager.onDidChangeCommentThreads(() => this.updateAll()));
	}

	private updateAll(): void {
		for (const document of this._info.keys()) {
			this.scheduleUpdate(vscode.Uri.parse(document));
		}
	}

	/**
	 * Renders the comment information of the document into the preview, keyed by document URI.
	 * When the rendered diff highlights changes within lines, it renders a copy of the text and
	 * the document isn't known. In that case, the information of every open markdown document is
	 * rendered, and the preview script picks the information of its own document.
	 */
	public renderPreviewData(document: vscode.Uri | undefined): string {
		const documents = document
			? [document]
			: vscode.workspace.textDocuments.filter(textDocument => textDocument.languageId === 'markdown').map(textDocument => textDocument.uri);
		const data: { [uri: string]: MarkdownPreviewCommentInfo & { commentUri: string } } = {};
		for (const uri of documents) {
			const key = uri.toString();
			if (!this._info.has(key)) {
				this._info.set(key, undefined);
			}
			this.scheduleUpdate(uri);
			const info = this._info.get(key);
			if (info) {
				data[key] = { ...info, commentUri: this.getCommentUri(uri) };
			}
		}
		if (Object.keys(data).length === 0) {
			return '';
		}
		return `<div id="${PREVIEW_DATA_ELEMENT_ID}" hidden data-state="${escapeAttribute(JSON.stringify(data))}"></div>`;
	}

	private getCommentUri(document: vscode.Uri): string {
		const key = document.toString();
		let id = this._documentIds.get(key);
		if (!id) {
			id = String(this._documentIds.size + 1);
			this._documentIds.set(key, id);
			this._documentsById.set(id, document);
		}
		return vscode.Uri.from({
			scheme: vscode.env.uriScheme,
			authority: EXTENSION_ID,
			path: UriHandlerPaths.CommentOnMarkdownPreview,
			query: `document=${id}`,
		}).toString(true);
	}

	/**
	 * Opens the commenting UI in the text editor for the given zero-based, inclusive lines.
	 * @param documentId The id of the document, from the link in the markdown preview.
	 */
	public async commentOnLines(documentId: string, start: number, end: number): Promise<void> {
		const resource = this._documentsById.get(documentId);
		if (!resource) {
			Logger.error(`Unknown markdown preview document: ${documentId}`, MarkdownPreviewComments.ID);
			return;
		}
		const document = await vscode.workspace.openTextDocument(resource);
		const info = await this.getInfo(document);
		// A comment must be within a single diff hunk, so clamp the block to the hunk it overlaps.
		const commentingRange = info?.commentingRanges.find(range => range.start <= end && range.end >= start);
		if (!commentingRange) {
			vscode.window.showWarningMessage(vscode.l10n.t('These lines are not part of the pull request\'s changes and cannot be commented on.'));
			return;
		}
		start = Math.max(start, commentingRange.start);
		end = Math.min(end, commentingRange.end, document.lineCount - 1);

		const visibleEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === resource.toString());
		const editor = await vscode.window.showTextDocument(document, {
			viewColumn: visibleEditor?.viewColumn ?? vscode.ViewColumn.Beside,
			selection: new vscode.Range(start, 0, start, 0),
		});
		editor.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		await vscode.commands.executeCommand('workbench.action.addComment', {
			range: {
				startLineNumber: start + 1,
				startColumn: 1,
				endLineNumber: end + 1,
				endColumn: document.lineAt(end).range.end.character + 1,
			},
		});
	}

	/**
	 * Gets the comment information of a file of the checked out pull request (`file` or `review` scheme),
	 * or of a pull request that isn't checked out (`pr` scheme).
	 */
	private async getInfo(document: vscode.TextDocument): Promise<MarkdownPreviewCommentInfo | undefined> {
		if (document.uri.scheme === Schemes.Pr) {
			return this.getPullRequestInfo(document);
		}
		const reviewManager = this.getReviewManager(document.uri);
		if (!reviewManager?.reviewCommentController) {
			Logger.debug(`No checked out pull request for ${document.uri.toString()}: review manager ${!!reviewManager}`, MarkdownPreviewComments.ID);
		}
		return reviewManager?.reviewCommentController?.getMarkdownPreviewCommentInfo(document);
	}

	private getReviewManager(resource: vscode.Uri): ReviewManager | undefined {
		if (resource.scheme === Schemes.Review) {
			const { rootPath } = fromReviewUri(resource.query);
			return this._reviewsManager.reviewManagers.find(reviewManager => reviewManager.repository.rootUri.path === rootPath);
		}
		return this._reviewsManager.reviewManagers.find(reviewManager =>
			reviewManager.repository.rootUri.scheme === resource.scheme
			&& isDescendant(reviewManager.repository.rootUri.fsPath, resource.fsPath));
	}

	private async getPullRequestInfo(document: vscode.TextDocument): Promise<MarkdownPreviewCommentInfo | undefined> {
		const params = fromPRUri(document.uri);
		if (!params) {
			return undefined;
		}
		const githubRepository = this._reposManager.folderManagers
			.flatMap(folderManager => folderManager.gitHubRepositories)
			.find(repository => repository.remote.remoteName === params.remoteName && repository.getExistingPullRequestModel(params.prNumber));
		const pullRequest = githubRepository?.getExistingPullRequestModel(params.prNumber);
		if (!githubRepository?.commentsHandler || !pullRequest) {
			Logger.debug(`No pull request for ${document.uri.toString()}: repository ${!!githubRepository}, comments handler ${!!githubRepository?.commentsHandler}, model ${!!pullRequest}`, MarkdownPreviewComments.ID);
			return undefined;
		}
		if (!this._listenedPullRequests.has(pullRequest)) {
			this._listenedPullRequests.add(pullRequest);
			this._register(pullRequest.onDidChangeReviewThreads(() => this.updateAll()));
		}

		// The registered providers are `CommentingRangeProvider2`s, which can also return an object with the ranges.
		const commentingRanges = await githubRepository.commentsHandler.provideCommentingRanges(document, new vscode.CancellationTokenSource().token) as vscode.Range[] | { ranges?: vscode.Range[] } | undefined;
		const ranges = Array.isArray(commentingRanges) ? commentingRanges : (commentingRanges?.ranges ?? []);
		const side = params.isBase ? DiffSide.LEFT : DiffSide.RIGHT;
		const threads = pullRequest.reviewThreadsCache.filter(thread =>
			thread.path === params.fileName && thread.diffSide === side && thread.subjectType !== SubjectType.FILE && thread.endLine !== null);
		return {
			commentingRanges: ranges.map(range => ({ start: range.start.line, end: range.end.line })),
			threads: threads.map(thread => ({
				start: thread.startLine - 1,
				end: thread.endLine - 1,
				commentCount: thread.comments.length,
				resolved: thread.isResolved,
			})),
		};
	}

	private scheduleUpdate(document: vscode.Uri): void {
		const key = document.toString();
		if (this._updateTimers.has(key)) {
			return;
		}
		this._updateTimers.set(key, setTimeout(async () => {
			this._updateTimers.delete(key);
			try {
				await this.update(document);
			} catch (e) {
				Logger.error(`Failed to update markdown preview comments for ${key}: ${e}`, MarkdownPreviewComments.ID);
			}
		}, UPDATE_DELAY_MS));
	}

	private async update(document: vscode.Uri): Promise<void> {
		const key = document.toString();
		const info = await this.getInfo(await vscode.workspace.openTextDocument(document));
		Logger.debug(`Comment info for ${key}: ${info ? `${info.commentingRanges.length} commenting ranges, ${info.threads.length} threads` : 'none'}`, MarkdownPreviewComments.ID);
		if (JSON.stringify(info) === JSON.stringify(this._info.get(key))) {
			return;
		}
		this._info.set(key, info);
		await vscode.commands.executeCommand('markdown.preview.refresh');
	}
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
