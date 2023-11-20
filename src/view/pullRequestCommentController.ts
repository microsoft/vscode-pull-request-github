/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { v4 as uuid } from 'uuid';
import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../azdo/folderRepositoryManager';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../azdo/prComment';
import { PullRequestModel, ReviewThreadChangeEvent } from '../azdo/pullRequestModel';
import { CommentReactionHandler, createVSCodeCommentThread, updateCommentReviewState, updateThread } from '../azdo/utils';
import { CommentHandler, registerCommentHandler, unregisterCommentHandler } from '../commentHandlerResolver';
import { DiffSide } from '../common/comment';
import { CommonCommentHandler } from '../common/commonCommentHandler';
import { fromPRUri } from '../common/uri';
import { groupBy } from '../common/utils';
import { URI_SCHEME_PR } from '../constants';
import { GitFileChangeNode, InMemFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';

export class PullRequestCommentController implements CommentHandler, CommentReactionHandler {
	static ID = 'PullRequestCommentController';
	private _pendingCommentThreadAdds: GHPRCommentThread[] = [];

	private _commonCommentHandler: CommonCommentHandler;
	public get commentController(): vscode.CommentController | undefined {
		return this._commentController;
	}

	private _commentHandlerId: string;
	private _commentThreadCache: { [key: string]: GHPRCommentThread[] } = {};
	private _openPREditors: vscode.TextEditor[] = [];
	private _disposables: vscode.Disposable[] = [];

	constructor(
		private pullRequestModel: PullRequestModel,
		private _folderReposManager: FolderRepositoryManager,
		private _commentController: vscode.CommentController,
		private getFileChanges: () => Promise<(RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode)[]>,
	) {
		this._commentHandlerId = uuid();
		this._commonCommentHandler = new CommonCommentHandler(pullRequestModel, _folderReposManager);

		registerCommentHandler(this._commentHandlerId, this);

		this.initializeThreadsInOpenEditors();
		this.registerListeners();
	}

	private registerListeners(): void {
		this._disposables.push(this.pullRequestModel.onDidChangeReviewThreads(e => this.onDidChangeReviewThreads(e)));

		this._disposables.push(
			vscode.window.onDidChangeVisibleTextEditors(async e => {
				this.onDidChangeOpenEditors(e);
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
		if (editorUri.scheme !== URI_SCHEME_PR) {
			return;
		}

		const params = fromPRUri(editorUri);
		if (!params || params.prNumber !== this.pullRequestModel.getPullRequestId()) {
			return;
		}

		this.setContextKey(this.pullRequestModel.hasPendingReview);
	}

	private getPREditors(editors: readonly vscode.TextEditor[]): vscode.TextEditor[] {
		return editors.filter(editor => {
			if (editor.document.uri.scheme !== URI_SCHEME_PR) {
				return false;
			}

			const params = fromPRUri(editor.document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.getPullRequestId()) {
				return false;
			}

			return true;
		});
	}

	private getCommentThreadCacheKey(fileName: string, isBase: boolean): string {
		return `${fileName}-${isBase ? 'original' : 'modified'}`;
	}

	private addThreadsForEditors(editors: vscode.TextEditor[]): void {
		const reviewThreads = this.pullRequestModel.reviewThreadsCache;
		const threadsByPath = groupBy(reviewThreads, thread => thread.path);
		editors.forEach(editor => {
			const { fileName, isBase } = fromPRUri(editor.document.uri);
			if (threadsByPath[fileName]) {
				const fileCache = this._commentThreadCache[this.getCommentThreadCacheKey(fileName, isBase)] ?? [];
				const newThreads = threadsByPath[fileName]
					.filter(
						thread =>
							(thread.diffSide === DiffSide.LEFT && isBase) || (thread.diffSide === DiffSide.RIGHT && !isBase),
					)
					.filter(thread => !fileCache?.some(t => t.threadId === thread.id))
					.map(thread => {
						const range = new vscode.Range(
							new vscode.Position(thread.line - 1, 0),
							new vscode.Position(thread.line - 1, 0),
						);

						return createVSCodeCommentThread(
							{
								threadId: thread.id!,
								uri: editor.document.uri,
								range,
								comments:
									thread.thread.comments?.map(c => {
										return {
											comment: c,
											commentPermissions: this.pullRequestModel.getCommentPermission(c),
										};
									}) ?? [],
								collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
								rawThread: thread.thread,
							},
							this._commentController,
						);
					});
				this._commentThreadCache[this.getCommentThreadCacheKey(fileName, isBase)] = [...fileCache, ...newThreads];
			}
		});
	}

	private initializeThreadsInOpenEditors(): void {
		const prEditors = this.getPREditors(vscode.window.visibleTextEditors);
		this._openPREditors = prEditors;
		this.addThreadsForEditors(prEditors);
	}

	private onDidChangeOpenEditors(editors: readonly vscode.TextEditor[]): void {
		const prEditors = this.getPREditors(editors);
		const removed = this._openPREditors.filter(x => !prEditors.includes(x));
		const added = prEditors.filter(x => !this._openPREditors.includes(x));
		this._openPREditors = prEditors;

		removed.forEach(editor => {
			const { fileName, isBase } = fromPRUri(editor.document.uri);
			const key = this.getCommentThreadCacheKey(fileName, isBase);
			const threads = this._commentThreadCache[key] || [];
			threads.forEach(t => t.dispose());
			delete this._commentThreadCache[key];
		});

		if (added.length) {
			this.addThreadsForEditors(added);
		}
	}

	private onDidChangeReviewThreads(e: ReviewThreadChangeEvent): void {
		e.added.forEach(thread => {
			const fileName = thread.path;
			const index = this._pendingCommentThreadAdds.findIndex(t => {
				// threadId is not yet present in _pendingCommentThreadAdds
				const samePath = this.gitRelativeRootPath(t.uri.path) === thread.path.replace(/^\/|\/$/g, '');
				const sameLine = t.range.start.line + 1 === thread.line;
				return samePath && sameLine;
			});

			let newThread: GHPRCommentThread;
			if (index > -1) {
				newThread = this._pendingCommentThreadAdds[index];
				newThread.threadId = thread.id;
				newThread.comments = thread.thread.comments.map(
					c => new GHPRComment(c, this.pullRequestModel.getCommentPermission(c), newThread),
				);
				this._pendingCommentThreadAdds.splice(index, 1);
			} else {
				const openPREditors = this.getPREditors(vscode.window.visibleTextEditors);
				const matchingEditor = openPREditors.find(editor => {
					const query = fromPRUri(editor.document.uri);
					const sameSide =
						(thread.diffSide === DiffSide.RIGHT && !query.isBase) ||
						(thread.diffSide === DiffSide.LEFT && query.isBase);
					return query.fileName === fileName && sameSide;
				});

				if (matchingEditor) {
					const range = new vscode.Range(
						new vscode.Position(thread.line - 1, 0),
						new vscode.Position(thread.line - 1, 0),
					);

					newThread = createVSCodeCommentThread(
						{
							threadId: thread.id!,
							uri: matchingEditor.document.uri,
							range,
							comments:
								thread.thread.comments?.map(c => {
									return {
										comment: c,
										commentPermissions: this.pullRequestModel.getCommentPermission(c),
									};
								}) ?? [],
							collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
							rawThread: thread.thread,
						},
						this._commentController,
					);
				}
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
			const index = this._commentThreadCache[key].findIndex(t => t.threadId === thread.id);
			if (index > -1) {
				const matchingThread = this._commentThreadCache[key][index];
				updateThread(
					matchingThread,
					thread.thread.comments
						.filter(c => !c.isDeleted)
						.map(c => new GHPRComment(c, this.pullRequestModel.getCommentPermission(c), matchingThread)),
				);
			}
		});

		e.removed.forEach(async thread => {
			const key = this.getCommentThreadCacheKey(thread.path, thread.diffSide === DiffSide.LEFT);
			const index = this._commentThreadCache[key].findIndex(t => t.threadId === thread.id);
			if (index > -1) {
				const matchingThread = this._commentThreadCache[key][index];
				this._commentThreadCache[key].splice(index, 1);
				matchingThread.dispose();
			}
		});
	}

	hasCommentThread(thread: GHPRCommentThread): boolean {
		if (thread.uri.scheme !== URI_SCHEME_PR) {
			return false;
		}

		const params = fromPRUri(thread.uri);

		if (!params || params.prNumber !== this.pullRequestModel.getPullRequestId()) {
			return false;
		}

		return true;
	}

	public async createOrReplyComment(thread: GHPRCommentThread, input: string, inDraft?: boolean): Promise<void> {
		this._pendingCommentThreadAdds.push(thread);
		await this._commonCommentHandler.createOrReplyComment(
			thread,
			input,
			inDraft ?? false,
			async _ => await this.getFileChanges(),
			async (rawThread, fileName) => await this.updateCommentThreadCache(rawThread, fileName),
		);
	}

	public async changeThreadStatus(thread: GHPRCommentThread): Promise<void> {
		await this._commonCommentHandler.changeThreadStatus(thread);
	}

	private getCommentSide(thread: GHPRCommentThread): DiffSide {
		const query = fromPRUri(thread.uri);
		return query.isBase ? DiffSide.LEFT : DiffSide.RIGHT;
	}

	private async updateCommentThreadCache(thread: GHPRCommentThread, fileName: string): Promise<void> {
		const commentThreadCache = this._commentThreadCache;
		const key = this.getCommentThreadCacheKey(fileName, this.getCommentSide(thread) === DiffSide.LEFT);
		const existingThreads = commentThreadCache[key];
		if (existingThreads) {
			commentThreadCache[key] = [...existingThreads, thread];
		} else {
			commentThreadCache[key] = [thread];
		}
	}

	public async editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			await this._commonCommentHandler.editComment(thread, comment, async _ => await this.getFileChanges());
		} else {
			this.createOrReplyComment(
				thread,
				comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body,
			);
		}
	}

	// #endregion

	private gitRelativeRootPath(comparePath: string) {
		// get path relative to git root directory. Handles windows path by converting it to unix path.
		return path.relative(this._folderReposManager.repository.rootUri.path, comparePath).replace(/\\/g, '/');
	}

	public async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		// if (comment.parent!.uri.scheme !== 'pr') {
		// 	return;
		// }
		// if (comment.reactions && !comment.reactions.find(ret => ret.label === reaction.label && !!ret.authorHasReacted)) {
		// 	// add reaction
		// 	await this.pullRequestModel.addCommentReaction(comment._rawComment.graphNodeId, reaction);
		// } else {
		// 	await this.pullRequestModel.deleteCommentReaction(comment._rawComment.graphNodeId, reaction);
		// }
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
