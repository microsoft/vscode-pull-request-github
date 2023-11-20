/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import { Comment, GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { v4 as uuid } from 'uuid';
import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { FolderRepositoryManager } from '../azdo/folderRepositoryManager';
import { CommentPermissions } from '../azdo/interface';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../azdo/prComment';
import {
	CommentReactionHandler,
	createVSCodeCommentThread,
	removeLeadingSlash,
	updateCommentReviewState,
	updateCommentThreadLabel,
} from '../azdo/utils';
import { CommentHandler, registerCommentHandler, unregisterCommentHandler } from '../commentHandlerResolver';
import { DiffSide, IReviewThread } from '../common/comment';
import { getCommentingRanges } from '../common/commentingRanges';
import { CommonCommentHandler } from '../common/commonCommentHandler';
import { getZeroBased, mapNewPositionToOld, mapOldPositionToNew } from '../common/diffPositionMapping';
import { fromReviewUri, ReviewUriParams, toReviewUri } from '../common/uri';
import { groupBy, uniqBy } from '../common/utils';
import { URI_SCHEME_REVIEW } from '../constants';
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { ThreadData } from './treeNodes/pullRequestNode';

export class ReviewCommentController
	implements vscode.Disposable, CommentHandler, vscode.CommentingRangeProvider, CommentReactionHandler {
	private _localToDispose: vscode.Disposable[] = [];
	private _onDidChangeComments = new vscode.EventEmitter<GitPullRequestCommentThread[]>();
	public onDidChangeComments = this._onDidChangeComments.event;

	private _commentHandlerId: string;

	private _commentController?: vscode.CommentController;
	protected _commonCommentHandler: CommonCommentHandler;

	public get commentController(): vscode.CommentController | undefined {
		return this._commentController;
	}

	// Note: marked as protected so that tests can verify caches have been updated correctly without breaking type safety
	protected _workspaceFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};
	protected _reviewSchemeFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};
	protected _obsoleteFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};

	protected _visibleNormalTextEditors: vscode.TextEditor[] = [];

	private _pendingCommentThreadAdds: GHPRCommentThread[] = [];

	constructor(
		private _reposManager: FolderRepositoryManager,
		private _repository: Repository,
		private _localFileChanges: GitFileChangeNode[],
		private _getCommentPermissions: (comment: Comment) => CommentPermissions,
	) {
		this._commentController = vscode.comments.createCommentController(
			`azdopr-review-${_reposManager.activePullRequest!.getPullRequestId()}`,
			_reposManager.activePullRequest!.item.title ?? '',
		);
		this._commentController.commentingRangeProvider = this;
		this._commentController.reactionHandler = this.toggleReaction.bind(this);
		this._localToDispose.push(this._commentController);
		this._commentHandlerId = uuid();
		this._commonCommentHandler = new CommonCommentHandler(_reposManager.activePullRequest!, _reposManager);
		registerCommentHandler(this._commentHandlerId, this);
	}
	async changeThreadStatus(thread: GHPRCommentThread): Promise<void> {
		await this._commonCommentHandler.changeThreadStatus(thread);
	}

	// #region initialize
	async initialize(): Promise<void> {
		this._visibleNormalTextEditors = vscode.window.visibleTextEditors.filter(ed => ed.document.uri.scheme !== 'comment');

		await this.initializeCommentThreads();
		await this.registerListeners();
	}

	/**
	 * Creates a comment thread for a thread that appears on the right-hand side, which is a
	 * document that has a scheme matching the workspace uri scheme, typically 'file'.
	 * @param uri The uri to the file the comment thread is on.
	 * @param path The path to the file the comment thread is on.
	 * @param thread The comment thread information from GitHub.
	 * @returns A GHPRCommentThread that has been created on an editor.
	 */
	private async createWorkspaceCommentThread(
		uri: vscode.Uri,
		path: string,
		thread: IReviewThread,
	): Promise<GHPRCommentThread> {
		let line = thread.line;
		const localDiff = await this._repository.diffWithHEAD(path);
		if (localDiff) {
			line = mapOldPositionToNew(localDiff, thread.line);
		}

		const range = new vscode.Range(new vscode.Position(line - 1, 0), new vscode.Position(line - 1, 0));

		const threadData = this.createThreadData(thread.thread, uri, range, vscode.CommentThreadCollapsibleState.Collapsed);

		return createVSCodeCommentThread(threadData, this._commentController);
	}

	/**
	 * Creates a comment thread for a thread that appears on the left-hand side, which is a
	 * document that has a 'review' scheme whose content is created by the extension.
	 * @param uri The uri to the file the comment thread is on.
	 * @param path The path to the file the comment thread is on.
	 * @param thread The comment thread information from GitHub.
	 * @returns A GHPRCommentThread that has been created on an editor.
	 */
	private createReviewCommentThread(uri: vscode.Uri, path: string, thread: IReviewThread): GHPRCommentThread {
		const reviewUri = toReviewUri(
			uri,
			path,
			undefined,
			this._reposManager.activePullRequest.mergeBase,
			false,
			{ base: true },
			this._repository.rootUri,
		);

		const range = new vscode.Range(new vscode.Position(thread.line - 1, 0), new vscode.Position(thread.line - 1, 0));
		const threadData = this.createThreadData(
			thread.thread,
			reviewUri,
			range,
			vscode.CommentThreadCollapsibleState.Collapsed,
		);

		return createVSCodeCommentThread(threadData, this._commentController);
	}

	async initializeCommentThreads(): Promise<void> {
		if (!this._reposManager.activePullRequest || !this._reposManager.activePullRequest.isResolved()) {
			return;
		}

		const reviewThreads = this._reposManager.activePullRequest!.reviewThreadsCache;
		const threadsByPath = groupBy(reviewThreads, thread => thread.path);

		for (const path in threadsByPath) {
			const threads = threadsByPath[path];
			const firstThread = threads[0];
			if (firstThread && !!firstThread.path) {
				const fullPath = nodePath
					.join(this._repository.rootUri.path, removeLeadingSlash(firstThread.path))
					.replace(/\\/g, '/');
				const uri = this._repository.rootUri.with({ path: fullPath });

				let rightSideCommentThreads: GHPRCommentThread[] = [];
				let leftSideThreads: GHPRCommentThread[] = [];
				let outdatedCommentThreads: GHPRCommentThread[] = [];

				const threadPromises = threads.map(async thread => {
					if (thread.isOutdated) {
						// outdatedCommentThreads.push(this.createOutdatedCommentThread(path, thread));
					} else {
						if (thread.diffSide === DiffSide.RIGHT) {
							const workspaceThread = await this.createWorkspaceCommentThread(
								uri,
								removeLeadingSlash(path),
								thread,
							);
							rightSideCommentThreads.push(workspaceThread);
						} else {
							leftSideThreads.push(this.createReviewCommentThread(uri, path, thread));
						}
					}
				});

				await Promise.all(threadPromises);

				this._workspaceFileChangeCommentThreads[path] = rightSideCommentThreads;
				this._reviewSchemeFileChangeCommentThreads[path] = leftSideThreads;
				this._obsoleteFileChangeCommentThreads[path] = outdatedCommentThreads;
			}
		}
	}

	private createThreadData(
		thread: GitPullRequestCommentThread,
		uri: vscode.Uri,
		range: vscode.Range,
		collapsibleState: vscode.CommentThreadCollapsibleState,
	): ThreadData {
		return {
			threadId: thread.id!,
			uri: uri,
			range,
			comments:
				thread.comments?.map(c => {
					return { comment: c, commentPermissions: this._getCommentPermissions(c) };
				}) ?? [],
			collapsibleState,
			rawThread: thread,
		};
	}

	async registerListeners(): Promise<void> {
		this._localToDispose.push(
			vscode.window.onDidChangeVisibleTextEditors(async visibleTextEditors => {
				if (this.visibleEditorsEqual(this._visibleNormalTextEditors, visibleTextEditors)) {
					return;
				}

				this._visibleNormalTextEditors = visibleTextEditors.filter(ed => ed.document.uri.scheme !== 'comment');
				// remove comment threads in `pr/review` documents if there are no longer visible

				const workspaceDocuments = visibleTextEditors.filter(
					editor => editor.document.uri.scheme === this._repository.rootUri.scheme,
				);
				workspaceDocuments.forEach(editor => {
					const fileName = this.gitRelativeRootPath(editor.document.uri.path);
					const threadsForEditor = this._workspaceFileChangeCommentThreads[fileName] || [];
					// If the editor has no view column, assume it is part of a diff editor and expand the comments. Otherwise, collapse them.
					const isEmbedded = !editor.viewColumn;
					this._workspaceFileChangeCommentThreads[fileName] = threadsForEditor.map(thread => {
						thread.collapsibleState = isEmbedded
							? vscode.CommentThreadCollapsibleState.Expanded
							: vscode.CommentThreadCollapsibleState.Collapsed;

						return thread;
					});
				});
			}),
		);

		this._localToDispose.push(
			this._reposManager.activePullRequest!.onDidChangePendingReviewState(newDraftMode => {
				[this._workspaceFileChangeCommentThreads, this._reviewSchemeFileChangeCommentThreads].forEach(
					commentThreadMap => {
						for (const fileName in commentThreadMap) {
							commentThreadMap[fileName].forEach(thread => {
								updateCommentReviewState(thread, newDraftMode);
								updateCommentThreadLabel(thread);
							});
						}
					},
				);
			}),
		);

		this._localToDispose.push(
			this._reposManager.activePullRequest!.onDidChangeReviewThreads(e => {
				e.added.forEach(async thread => {
					const { path } = thread;
					const index = this._pendingCommentThreadAdds.findIndex(async t => {
						const fileName = this.gitRelativeRootPath(t.uri.path);
						if (fileName !== thread.path) {
							return false;
						}

						const diff = await this.getContentDiff(t.uri, fileName);
						const line = mapNewPositionToOld(diff, t.range.start.line);
						const sameLine = line + 1 === thread.line;
						return sameLine;
					});

					let newThread: GHPRCommentThread;
					if (index > -1) {
						newThread = this._pendingCommentThreadAdds[index];
						newThread.threadId = thread.id;
						newThread.comments = thread.thread.comments.map(
							c => new GHPRComment(c, this._getCommentPermissions(c), newThread),
						);
						this._pendingCommentThreadAdds.splice(index, 1);
					} else {
						const fullPath = nodePath
							.join(this._repository.rootUri.path, removeLeadingSlash(path))
							.replace(/\\/g, '/');
						const uri = this._repository.rootUri.with({ path: fullPath });
						if (thread.isOutdated) {
							// newThread = this.createOutdatedCommentThread(path, thread);
						} else {
							if (thread.diffSide === DiffSide.RIGHT) {
								newThread = await this.createWorkspaceCommentThread(uri, path, thread);
							} else {
								newThread = this.createReviewCommentThread(uri, path, thread);
							}
						}
					}

					const threadMap = thread.isOutdated
						? this._obsoleteFileChangeCommentThreads
						: thread.diffSide === DiffSide.RIGHT
						? this._workspaceFileChangeCommentThreads
						: this._reviewSchemeFileChangeCommentThreads;

					if (threadMap[path]) {
						threadMap[path].push(newThread);
					} else {
						threadMap[path] = [newThread];
					}
				});

				e.changed.forEach(thread => {
					const threadMap = thread.isOutdated
						? this._obsoleteFileChangeCommentThreads
						: thread.diffSide === DiffSide.RIGHT
						? this._workspaceFileChangeCommentThreads
						: this._reviewSchemeFileChangeCommentThreads;

					const index = threadMap[thread.path].findIndex(t => t.threadId === thread.id);
					if (index > -1) {
						const matchingThread = threadMap[thread.path][index];
						matchingThread.comments = thread.thread.comments
							.filter(c => !c.isDeleted)
							.map(c => new GHPRComment(c, this._getCommentPermissions(c), matchingThread));
					}
				});

				e.removed.forEach(thread => {
					const threadMap = thread.isOutdated
						? this._obsoleteFileChangeCommentThreads
						: thread.diffSide === DiffSide.RIGHT
						? this._workspaceFileChangeCommentThreads
						: this._reviewSchemeFileChangeCommentThreads;

					const index = threadMap[thread.path].findIndex(t => t.threadId === thread.id);
					if (index > -1) {
						const matchingThread = threadMap[thread.path][index];
						threadMap[thread.path].splice(index, 1);
						matchingThread.dispose();
					}
				});
			}),
		);
	}

	private visibleEditorsEqual(a: vscode.TextEditor[], b: readonly vscode.TextEditor[]): boolean {
		a = a.filter(ed => ed.document.uri.scheme !== 'comment');
		b = b.filter(ed => ed.document.uri.scheme !== 'comment');

		a = uniqBy(a, editor => editor.document.uri.toString());
		b = uniqBy(b, editor => editor.document.uri.toString());

		if (a.length !== b.length) {
			return false;
		}

		for (let i = 0; i < a.length; i++) {
			const findRet = b.find(editor => editor.document.uri.toString() === a[i].document.uri.toString());

			if (!findRet) {
				return false;
			}
		}

		return true;
	}

	// #endregion

	hasCommentThread(thread: vscode.CommentThread): boolean {
		if (thread.uri.scheme === URI_SCHEME_REVIEW) {
			return true;
		}

		const currentWorkspace = vscode.workspace.getWorkspaceFolder(thread.uri);
		if (!currentWorkspace) {
			return false;
		}

		if (
			thread.uri.scheme === currentWorkspace.uri.scheme &&
			thread.uri.fsPath.startsWith(this._repository.rootUri.fsPath)
		) {
			return true;
		}

		return false;
	}

	async provideCommentingRanges(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<vscode.Range[] | undefined> {
		let query: ReviewUriParams | undefined;

		try {
			query = fromReviewUri(document.uri);
		} catch (e) {}

		if (query) {
			const matchedFile = this.findMatchedFileChangeForReviewDiffView(this._localFileChanges, document.uri);

			if (matchedFile) {
				return getCommentingRanges(matchedFile.diffHunks, query.base);
			}
		}

		const currentWorkspace = vscode.workspace.getWorkspaceFolder(document.uri);
		if (!currentWorkspace) {
			return;
		}

		if (document.uri.scheme === currentWorkspace.uri.scheme) {
			if (!this._reposManager.activePullRequest!.isResolved()) {
				return;
			}

			const fileName = this.gitRelativeRootPath(document.uri.path);
			const matchedFile = gitFileChangeNodeFilter(this._localFileChanges).find(
				fileChange => removeLeadingSlash(fileChange.fileName) === fileName,
			);
			const ranges = [];

			if (matchedFile) {
				// TODO Why was this here?
				// if (matchedFile.status === GitChangeType.RENAME) {
				// 	return [];
				// }

				const contentDiff = await this.getContentDiff(document.uri, removeLeadingSlash(matchedFile.fileName));
				const diffHunks = matchedFile.diffHunks;

				for (let i = 0; i < diffHunks.length; i++) {
					const diffHunk = diffHunks[i];
					const start = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber);
					const end = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber + diffHunk.newLength - 1);
					if (start > 0 && end > 0) {
						ranges.push(new vscode.Range(start - 1, 0, end - 1, 0));
					}
				}
			}

			return ranges;
		}

		return;
	}

	// #endregion

	// #region Helper

	private async getContentDiff(uri: vscode.Uri, fileName: string): Promise<string> {
		const matchedEditor = vscode.window.visibleTextEditors.find(
			editor => editor.document.uri.toString() === uri.toString(),
		);
		let contentDiff: string;

		if (matchedEditor && matchedEditor.document.isDirty) {
			const headCommitSha = this._repository.state.HEAD!.commit!;
			const documentText = matchedEditor.document.getText();
			const details = await this._repository.getObjectDetails(headCommitSha, fileName);
			const idAtLastCommit = details.object;
			const idOfCurrentText = await this._repository.hashObject(documentText);

			// git diff <blobid> <blobid>
			contentDiff = await this._repository.diffBlobs(idAtLastCommit, idOfCurrentText);
		} else {
			// git diff sha -- fileName
			contentDiff = await this._repository.diffWithHEAD(fileName);
		}

		return contentDiff;
	}

	private findMatchedFileChangeForReviewDiffView(
		fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
		uri: vscode.Uri,
	): GitFileChangeNode | undefined {
		const query = fromReviewUri(uri);
		const matchedFiles = fileChanges.filter(fileChange => {
			if (fileChange instanceof RemoteFileChangeNode) {
				return false;
			}

			if (fileChange.fileName !== query.path) {
				return false;
			}

			if (fileChange.filePath.scheme !== URI_SCHEME_REVIEW) {
				// local file

				if (fileChange.commitId === query.commit) {
					return true;
				}
			}

			try {
				const q = JSON.parse(fileChange.filePath.query);

				if (q.commit === query.commit) {
					return true;
				}
			} catch (e) {}

			try {
				const q = JSON.parse(fileChange.parentFilePath.query);

				if (q.commit === query.commit) {
					return true;
				}
			} catch (e) {}

			return false;
		});

		if (matchedFiles && matchedFiles.length) {
			return matchedFiles[0] as GitFileChangeNode;
		}
	}

	private gitRelativeRootPath(path: string) {
		// get path relative to git root directory. Handles windows path by converting it to unix path.
		return nodePath.relative(this._repository.rootUri.path, path).replace(/\\/g, '/');
	}

	// #endregion

	private getCommentSide(thread: GHPRCommentThread): DiffSide {
		if (thread.uri.scheme === URI_SCHEME_REVIEW) {
			const query = fromReviewUri(thread.uri);
			return query.base ? DiffSide.LEFT : DiffSide.RIGHT;
		}

		return DiffSide.RIGHT;
	}

	// #region Comment
	async createOrReplyComment(thread: GHPRCommentThread, input: string, inDraft?: boolean): Promise<void> {
		const hasExistingComments = thread.comments.length;
		if (!hasExistingComments) {
			this._pendingCommentThreadAdds.push(thread);
			const fileName = this.gitRelativeRootPath(thread.uri.path);
			const side = this.getCommentSide(thread);
			// If the thread is on the workspace file, make sure the position
			// is properly adjusted to account for any local changes.
			let line: number;

			if (side === DiffSide.RIGHT) {
				const diff = await this.getContentDiff(thread.uri, fileName);
				line = mapNewPositionToOld(diff, thread.range.start.line);
			} else {
				line = thread.range.start.line;
			}
			thread.range = new vscode.Range(
				new vscode.Position(getZeroBased(line), 0),
				new vscode.Position(getZeroBased(line), 0),
			);
		}

		await this._commonCommentHandler.createOrReplyComment(
			thread,
			input,
			inDraft ?? false,
			async _ => this._localFileChanges,
			async (_, __) => undefined,
		);
	}

	async editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			await this._commonCommentHandler.editComment(thread, comment, async _ => this._localFileChanges);
		} else {
			this.createOrReplyComment(
				thread,
				comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body,
			);
		}
	}

	// async deleteComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
	// 	try {
	// 		if (!this._reposManager.activePullRequest) {
	// 			throw new Error('Unable to find active pull request');
	// 		}

	// 		const matchedFile = this.findMatchedFileByUri(thread.uri);
	// 		if (!matchedFile) {
	// 			throw new Error('Unable to find matching file');
	// 		}

	// 		if (comment instanceof GHPRComment) {
	// 			await this._reposManager.activePullRequest.deleteReviewComment(comment.commentId);
	// 			const matchingCommentIndex = matchedFile.comments.findIndex(c => c.id.toString() === comment.commentId);
	// 			if (matchingCommentIndex > -1) {
	// 				matchedFile.comments.splice(matchingCommentIndex, 1);
	// 				matchedFile.update(matchedFile.comments);
	// 			}

	// 			const indexInAllComments = this._comments.findIndex(c => c.id.toString() === comment.commentId);
	// 			if (indexInAllComments > -1) {
	// 				this._comments.splice(indexInAllComments, 1);
	// 			}

	// 			thread.comments = thread.comments.filter(c => c instanceof GHPRComment && c.commentId !== comment.commentId);
	// 		} else {
	// 			thread.comments = thread.comments.filter(c => c instanceof TemporaryComment && c.id === comment.id);
	// 		}

	// 		if (thread.comments.length === 0) {
	// 			thread.dispose();
	// 		} else {
	// 			updateCommentThreadLabel(thread);
	// 		}

	// 		const inDraftMode = await this._reposManager.activePullRequest.validateDraftMode();
	// 		if (inDraftMode !== this._reposManager.activePullRequest.hasPendingReview) {
	// 			this._reposManager.activePullRequest.hasPendingReview = inDraftMode;
	// 		}

	// 		this.update(this._localFileChanges, this._obsoleteFileChanges);

	// 	} catch (e) {
	// 		throw new Error(formatError(e));
	// 	}
	// }

	// #endregion

	// #region Incremental update comments
	public async update(
		localFileChanges: GitFileChangeNode[],
		obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
	): Promise<void> {
		this._localFileChanges = localFileChanges;
	}
	// #endregion

	// #region Reactions
	async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		// try {
		// 	if (!this._reposManager.activePullRequest) {
		// 		throw new Error('Unable to find active pull request');
		// 	}
		// 	const matchedFile = this.findMatchedFileByUri(comment.parent!.uri);
		// 	if (!matchedFile) {
		// 		throw new Error('Unable to find matching file');
		// 	}
		// 	let reactionGroups: ReactionGroup[] = [];
		// 	if (comment.reactions && !comment.reactions.find(ret => ret.label === reaction.label && !!ret.authorHasReacted)) {
		// 		const result = await this._reposManager.activePullRequest.addCommentReaction(comment._rawComment.graphNodeId, reaction);
		// 		reactionGroups = result.addReaction.subject.reactionGroups;
		// 	} else {
		// 		const result = await this._reposManager.activePullRequest.deleteCommentReaction(comment._rawComment.graphNodeId, reaction);
		// 		reactionGroups = result.removeReaction.subject.reactionGroups;
		// 	}
		// 	// Update the cached comments of the file
		// 	const matchingCommentIndex = matchedFile.comments.findIndex(c => c.id.toString() === comment.commentId);
		// 	if (matchingCommentIndex > -1) {
		// 		const editedComment = matchedFile.comments[matchingCommentIndex];
		// 		editedComment.reactions = parseGraphQLReaction(reactionGroups);
		// 		const vscodeCommentReactions = generateCommentReactions(editedComment.reactions);
		// 		const fileName = matchedFile.fileName;
		// 		const modifiedThreads = [
		// 			...(this._prDocumentCommentThreads.getAllThreadsForDocument(fileName) || []),
		// 			...(this._reviewDocumentCommentThreads.getAllThreadsForDocument(fileName) || []),
		// 			...(this._workspaceFileChangeCommentThreads[fileName] || []),
		// 			...(this._obsoleteFileChangeCommentThreads[fileName] || [])
		// 		].filter(td => !!td.comments.find((cmt: GHPRComment) => cmt.commentId === comment.commentId));
		// 		modifiedThreads.forEach(thread => {
		// 			thread.comments = thread.comments.map((cmt: GHPRComment) => {
		// 				if (cmt.commentId === comment.commentId) {
		// 					cmt.reactions = vscodeCommentReactions;
		// 				}
		// 				return cmt;
		// 			});
		// 		});
		// 	}
		// } catch (e) {
		// 	throw new Error(formatError(e));
		// }
	}

	// #endregion
	public dispose() {
		if (this._commentController) {
			this._commentController.dispose();
		}

		unregisterCommentHandler(this._commentHandlerId);

		this._localToDispose.forEach(d => d.dispose());
	}
}
