/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { v4 as uuid } from 'uuid';
import * as vscode from 'vscode';
import { CommentHandler, registerCommentHandler, unregisterCommentHandler } from '../commentHandlerResolver';
import { DiffSide, IComment } from '../common/comment';
import { fromPRUri, Schemes } from '../common/uri';
import { groupBy } from '../common/utils';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../github/prComment';
import { PullRequestModel, ReviewThreadChangeEvent } from '../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import {
	CommentReactionHandler,
	createVSCodeCommentThreadForReviewThread,
	threadRange,
	updateCommentReviewState,
	updateCommentThreadLabel,
	updateThread,
	updateThreadWithRange,
} from '../github/utils';

export class PullRequestCommentController implements CommentHandler, CommentReactionHandler {
	private _pendingCommentThreadAdds: GHPRCommentThread[] = [];
	private _commentHandlerId: string;
	private _commentThreadCache: { [key: string]: GHPRCommentThread[] } = {};
	private _openPREditors: vscode.TextEditor[] = [];
	/**
	 * Cached threads belong to editors that are closed, but that we keep cached because they were recently used.
	 * This prevents comment replies that haven't been submitted from getting deleted too easily.
	 */
	private _closedEditorCachedThreads: Set<string> = new Set();
	private _disposables: vscode.Disposable[] = [];

	constructor(
		private pullRequestModel: PullRequestModel,
		private _folderReposManager: FolderRepositoryManager,
		private _commentController: vscode.CommentController,
	) {
		this._commentHandlerId = uuid();
		registerCommentHandler(this._commentHandlerId, this);

		if (this.pullRequestModel.reviewThreadsCacheReady) {
			this.initializeThreadsInOpenEditors().then(() => {
				this.registerListeners();
			});
		} else {
			const reviewThreadsDisposable = this.pullRequestModel.onDidChangeReviewThreads(async () => {
				reviewThreadsDisposable.dispose();
				await this.initializeThreadsInOpenEditors();
				this.registerListeners();
			});
		}
	}

	private registerListeners(): void {
		this._disposables.push(this.pullRequestModel.onDidChangeReviewThreads(e => this.onDidChangeReviewThreads(e)));

		this._disposables.push(
			vscode.window.onDidChangeVisibleTextEditors(async e => {
				return this.onDidChangeOpenEditors(e);
			}),
		);

		this._disposables.push(
			this.pullRequestModel.onDidChangePendingReviewState(newDraftMode => {
				for (const key in this._commentThreadCache) {
					this._commentThreadCache[key].forEach(thread => {
						updateCommentReviewState(thread, newDraftMode);
					});
				}
			}),
		);

		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor(e => {
				this.refreshContextKey(e);
			}),
		);
	}

	private refreshContextKey(editor: vscode.TextEditor | undefined): void {
		if (!editor) {
			return;
		}

		const editorUri = editor.document.uri;
		if (editorUri.scheme !== Schemes.Pr) {
			return;
		}

		const params = fromPRUri(editorUri);
		if (!params || params.prNumber !== this.pullRequestModel.number) {
			return;
		}

		this.setContextKey(this.pullRequestModel.hasPendingReview);
	}

	private getPREditors(editors: readonly vscode.TextEditor[]): vscode.TextEditor[] {
		return editors.filter(editor => {
			if (editor.document.uri.scheme !== Schemes.Pr) {
				return false;
			}

			const params = fromPRUri(editor.document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.number) {
				return false;
			}

			return true;
		});
	}

	private getCommentThreadCacheKey(fileName: string, isBase: boolean): string {
		return `${fileName}-${isBase ? 'original' : 'modified'}`;
	}

	private tryUsedCachedEditor(editors: vscode.TextEditor[]): vscode.TextEditor[] {
		const uncachedEditors: vscode.TextEditor[] = [];
		editors.forEach(editor => {
			const { fileName, isBase } = fromPRUri(editor.document.uri)!;
			const key = this.getCommentThreadCacheKey(fileName, isBase);
			if (this._closedEditorCachedThreads.has(key)) {
				// Update position in cache
				this._closedEditorCachedThreads.delete(key);
				this._closedEditorCachedThreads.add(key);
			} else {
				uncachedEditors.push(editor);
			}
		});
		return uncachedEditors;
	}

	private async addThreadsForEditors(newEditors: vscode.TextEditor[]): Promise<void> {
		const editors = this.tryUsedCachedEditor(newEditors);
		const reviewThreads = this.pullRequestModel.reviewThreadsCache;
		const threadsByPath = groupBy(reviewThreads, thread => thread.path);
		const currentUser = await this._folderReposManager.getCurrentUser();
		editors.forEach(editor => {
			const { fileName, isBase } = fromPRUri(editor.document.uri)!;
			if (threadsByPath[fileName]) {
				this._commentThreadCache[this.getCommentThreadCacheKey(fileName, isBase)] = threadsByPath[fileName]
					.filter(
						thread =>
							((thread.diffSide === DiffSide.LEFT && isBase) ||
								(thread.diffSide === DiffSide.RIGHT && !isBase))
							&& (thread.endLine !== null),
					)
					.map(thread => {
						const endLine = thread.endLine - 1;
						const range = threadRange(thread.startLine - 1, endLine, editor.document.lineAt(endLine).range.end.character);

						return createVSCodeCommentThreadForReviewThread(
							editor.document.uri,
							range,
							thread,
							this._commentController,
							currentUser.login
						);
					});
			}
		});
	}

	private async initializeThreadsInOpenEditors(): Promise<void> {
		const prEditors = this.getPREditors(vscode.window.visibleTextEditors);
		this._openPREditors = prEditors;
		return this.addThreadsForEditors(prEditors);
	}

	private cleanCachedEditors() {
		// Keep the most recent 8 editors (4 diffs) around and clean up the rest.
		if (this._closedEditorCachedThreads.size > 8) {
			const keys = Array.from(this._closedEditorCachedThreads.keys());
			for (let i = 0; i < this._closedEditorCachedThreads.size - 4; i++) {
				const key = keys[i];
				this.cleanCachedEditor(key);
				this._closedEditorCachedThreads.delete(key);
			}
		}
	}

	private cleanCachedEditor(key: string) {
		const threads = this._commentThreadCache[key] || [];
		threads.forEach(t => t.dispose());
		delete this._commentThreadCache[key];
	}

	private addCachedEditors(editors: vscode.TextEditor[]) {
		editors.forEach(editor => {
			const { fileName, isBase } = fromPRUri(editor.document.uri)!;
			const key = this.getCommentThreadCacheKey(fileName, isBase);
			if (this._closedEditorCachedThreads.has(key)) {
				// Delete to update position in the cache
				this._closedEditorCachedThreads.delete(key);
			}
			this._closedEditorCachedThreads.add(key);
		});
	}

	private async onDidChangeOpenEditors(editors: readonly vscode.TextEditor[]): Promise<void> {
		const prEditors = this.getPREditors(editors);
		const removed = this._openPREditors.filter(x => !prEditors.includes(x));
		this.addCachedEditors(removed);
		this.cleanCachedEditors();

		const added = prEditors.filter(x => !this._openPREditors.includes(x));
		this._openPREditors = prEditors;
		if (added.length) {
			await this.addThreadsForEditors(added);
		}
	}

	private onDidChangeReviewThreads(e: ReviewThreadChangeEvent): void {
		e.added.forEach(async (thread) => {
			const fileName = thread.path;
			const index = this._pendingCommentThreadAdds.findIndex(t => {
				const samePath = this.gitRelativeRootPath(t.uri.path) === thread.path;
				const sameLine = t.range.end.line + 1 === thread.endLine;
				return samePath && sameLine;
			});

			let newThread: GHPRCommentThread | undefined = undefined;
			if (index > -1) {
				newThread = this._pendingCommentThreadAdds[index];
				newThread.gitHubThreadId = thread.id;
				newThread.comments = thread.comments.map(c => new GHPRComment(c, newThread!));
				updateThreadWithRange(newThread, thread);
				this._pendingCommentThreadAdds.splice(index, 1);
			} else {
				const openPREditors = this.getPREditors(vscode.window.visibleTextEditors);
				const matchingEditor = openPREditors.find(editor => {
					const query = fromPRUri(editor.document.uri);
					const sameSide =
						(thread.diffSide === DiffSide.RIGHT && !query?.isBase) ||
						(thread.diffSide === DiffSide.LEFT && query?.isBase);
					return query?.fileName === fileName && sameSide;
				});

				if (matchingEditor) {
					const endLine = thread.endLine - 1;
					const range = threadRange(thread.startLine - 1, endLine, matchingEditor.document.lineAt(endLine).range.end.character);

					newThread = createVSCodeCommentThreadForReviewThread(
						matchingEditor.document.uri,
						range,
						thread,
						this._commentController,
						(await this._folderReposManager.getCurrentUser()).login
					);
				}
			}

			if (!newThread) {
				return;
			}
			const key = this.getCommentThreadCacheKey(thread.path, thread.diffSide === DiffSide.LEFT);
			if (this._commentThreadCache[key]) {
				this._commentThreadCache[key].push(newThread);
			} else {
				this._commentThreadCache[key] = [newThread];
			}
		});

		e.changed.forEach(thread => {
			const key = this.getCommentThreadCacheKey(thread.path, thread.diffSide === DiffSide.LEFT);
			const index = this._commentThreadCache[key] ? this._commentThreadCache[key].findIndex(t => t.gitHubThreadId === thread.id) : -1;
			if (index > -1) {
				const matchingThread = this._commentThreadCache[key][index];
				updateThread(matchingThread, thread);
			}
		});

		e.removed.forEach(async thread => {
			const key = this.getCommentThreadCacheKey(thread.path, thread.diffSide === DiffSide.LEFT);
			const index = this._commentThreadCache[key].findIndex(t => t.gitHubThreadId === thread.id);
			if (index > -1) {
				const matchingThread = this._commentThreadCache[key][index];
				this._commentThreadCache[key].splice(index, 1);
				matchingThread.dispose();
			}
		});
	}

	hasCommentThread(thread: GHPRCommentThread): boolean {
		if (thread.uri.scheme !== Schemes.Pr) {
			return false;
		}

		const params = fromPRUri(thread.uri);

		if (!params || params.prNumber !== this.pullRequestModel.number) {
			return false;
		}

		return true;
	}

	private getCommentSide(thread: GHPRCommentThread): DiffSide {
		const query = fromPRUri(thread.uri);
		return query?.isBase ? DiffSide.LEFT : DiffSide.RIGHT;
	}

	public async createOrReplyComment(
		thread: GHPRCommentThread,
		input: string,
		isSingleComment: boolean,
		inDraft?: boolean,
	): Promise<void> {
		const hasExistingComments = thread.comments.length;
		const isDraft = isSingleComment
			? false
			: inDraft !== undefined
				? inDraft
				: this.pullRequestModel.hasPendingReview;
		const temporaryCommentId = await this.optimisticallyAddComment(thread, input, isDraft);

		try {
			if (hasExistingComments) {
				await this.reply(thread, input, isSingleComment);
			} else {
				const fileName = this.gitRelativeRootPath(thread.uri.path);
				const side = this.getCommentSide(thread);
				this._pendingCommentThreadAdds.push(thread);
				await this.pullRequestModel.createReviewThread(
					input,
					fileName,
					thread.range.start.line + 1,
					thread.range.end.line + 1,
					side,
					isSingleComment,
				);
			}

			if (isSingleComment) {
				await this.pullRequestModel.submitReview();
			}
		} catch (e) {
			if (e.graphQLErrors?.length && e.graphQLErrors[0].type === 'NOT_FOUND') {
				vscode.window.showWarningMessage('The comment that you\'re replying to was deleted. Refresh to update.', 'Refresh').then(result => {
					if (result === 'Refresh') {
						this.pullRequestModel.invalidate();
					}
				});
			} else {
				vscode.window.showErrorMessage(`Creating comment failed: ${e}`);
			}
			thread.comments = thread.comments.map(c => {
				if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
					c.mode = vscode.CommentMode.Editing;
				}

				return c;
			});
		}
	}

	private reply(thread: GHPRCommentThread, input: string, isSingleComment: boolean): Promise<IComment | undefined> {
		const replyingTo = thread.comments[0];
		if (replyingTo instanceof GHPRComment) {
			return this.pullRequestModel.createCommentReply(input, replyingTo._rawComment.graphNodeId, isSingleComment);
		} else {
			// TODO can we do better?
			throw new Error('Cannot respond to temporary comment');
		}
	}

	private async optimisticallyEditComment(thread: GHPRCommentThread, comment: GHPRComment): Promise<number> {
		const currentUser = await this._folderReposManager.getCurrentUser(this.pullRequestModel.githubRepository);
		const temporaryComment = new TemporaryComment(
			thread,
			comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.rawBody,
			!!comment.label,
			currentUser,
			comment,
		);
		thread.comments = thread.comments.map(c => {
			if (c instanceof GHPRComment && c.commentId === comment.commentId) {
				return temporaryComment;
			}

			return c;
		});

		return temporaryComment.id;
	}

	public async editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			const temporaryCommentId = await this.optimisticallyEditComment(thread, comment);
			try {
				await this.pullRequestModel.editReviewComment(
					comment._rawComment,
					comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.rawBody,
				);
			} catch (e) {
				vscode.window.showErrorMessage(`Editing comment failed ${e}`);

				thread.comments = thread.comments.map(c => {
					if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
						return new GHPRComment(comment._rawComment, thread);
					}

					return c;
				});
			}
		} else {
			this.createOrReplyComment(
				thread,
				comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.rawBody,
				false,
			);
		}
	}

	public async deleteComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			await this.pullRequestModel.deleteReviewComment(comment.commentId);
		} else {
			thread.comments = thread.comments.filter(c => !(c instanceof TemporaryComment && c.id === comment.id));
		}

		await this.pullRequestModel.validateDraftMode();
	}
	// #endregion

	private gitRelativeRootPath(comparePath: string) {
		// get path relative to git root directory. Handles windows path by converting it to unix path.
		return path.relative(this._folderReposManager.repository.rootUri.path, comparePath).replace(/\\/g, '/');
	}

	// #region Review
	public async startReview(thread: GHPRCommentThread, input: string): Promise<void> {
		const hasExistingComments = thread.comments.length;
		const temporaryCommentId = await this.optimisticallyAddComment(thread, input, true);

		try {
			if (!hasExistingComments) {
				const fileName = this.gitRelativeRootPath(thread.uri.path);
				const side = this.getCommentSide(thread);
				this._pendingCommentThreadAdds.push(thread);
				await this.pullRequestModel.createReviewThread(input, fileName, thread.range.start.line + 1, thread.range.end.line + 1, side);
			} else {
				await this.reply(thread, input, false);
			}

			this.setContextKey(true);
		} catch (e) {
			vscode.window.showErrorMessage(`Starting a review failed: ${e}`);

			thread.comments = thread.comments.map(c => {
				if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
					c.mode = vscode.CommentMode.Editing;
				}

				return c;
			});
		}
	}


	public async openReview(): Promise<void> {
		await PullRequestOverviewPanel.createOrShow(this._folderReposManager.context.extensionUri, this._folderReposManager, this.pullRequestModel);
		PullRequestOverviewPanel.scrollToReview();

		/* __GDPR__
			"pr.openDescription" : {}
		*/
		this._folderReposManager.telemetry.sendTelemetryEvent('pr.openDescription');
	}

	private async optimisticallyAddComment(thread: GHPRCommentThread, input: string, inDraft: boolean): Promise<number> {
		const currentUser = await this._folderReposManager.getCurrentUser(this.pullRequestModel.githubRepository);
		const comment = new TemporaryComment(thread, input, inDraft, currentUser);
		this.updateCommentThreadComments(thread, [...thread.comments, comment]);
		return comment.id;
	}

	private updateCommentThreadComments(thread: GHPRCommentThread, newComments: (GHPRComment | TemporaryComment)[]) {
		thread.comments = newComments;
		updateCommentThreadLabel(thread);
	}

	private async createCommentOnResolve(thread: GHPRCommentThread, input: string): Promise<void> {
		const pendingReviewId = await this.pullRequestModel.getPendingReviewId();
		await this.createOrReplyComment(thread, input, !pendingReviewId);
	}

	public async resolveReviewThread(thread: GHPRCommentThread, input?: string): Promise<void> {
		try {
			if (input) {
				await this.createCommentOnResolve(thread, input);
			}

			await this.pullRequestModel.resolveReviewThread(thread.gitHubThreadId);
		} catch (e) {
			vscode.window.showErrorMessage(`Resolving conversation failed: ${e}`);
		}
	}

	public async unresolveReviewThread(thread: GHPRCommentThread, input?: string): Promise<void> {
		try {
			if (input) {
				await this.createCommentOnResolve(thread, input);
			}

			await this.pullRequestModel.unresolveReviewThread(thread.gitHubThreadId);
		} catch (e) {
			vscode.window.showErrorMessage(`Unresolving conversation failed: ${e}`);
		}
	}

	public async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		if (comment.parent!.uri.scheme !== Schemes.Pr) {
			return;
		}

		if (
			comment.reactions &&
			!comment.reactions.find(ret => ret.label === reaction.label && !!ret.authorHasReacted)
		) {
			// add reaction
			await this.pullRequestModel.addCommentReaction(comment._rawComment.graphNodeId, reaction);
		} else {
			await this.pullRequestModel.deleteCommentReaction(comment._rawComment.graphNodeId, reaction);
		}
	}

	private setContextKey(inDraftMode: boolean): void {
		vscode.commands.executeCommand('setContext', 'prInDraft', inDraftMode);
	}

	dispose() {
		Object.keys(this._commentThreadCache).forEach(key => {
			this._commentThreadCache[key].forEach(thread => thread.dispose());
		});

		unregisterCommentHandler(this._commentHandlerId);

		this._disposables.forEach(d => d.dispose());
	}
}
