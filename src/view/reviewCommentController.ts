/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import { v4 as uuid } from 'uuid';
import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { CommentHandler, registerCommentHandler, unregisterCommentHandler } from '../commentHandlerResolver';
import { DiffSide, IReviewThread } from '../common/comment';
import { getCommentingRanges } from '../common/commentingRanges';
import { mapNewPositionToOld, mapOldPositionToNew } from '../common/diffPositionMapping';
import { GitChangeType } from '../common/file';
import Logger from '../common/logger';
import { fromReviewUri, ReviewUriParams, Schemes, toReviewUri } from '../common/uri';
import { formatError, groupBy, uniqBy } from '../common/utils';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../github/prComment';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import {
	CommentReactionHandler,
	createVSCodeCommentThreadForReviewThread,
	isFileInRepo,
	threadRange,
	updateCommentReviewState,
	updateCommentThreadLabel,
	updateThread,
	updateThreadWithRange,
} from '../github/utils';
import { RemoteFileChangeModel } from './fileChangeModel';
import { ReviewManager } from './reviewManager';
import { ReviewModel } from './reviewModel';
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';

export class ReviewCommentController
	implements vscode.Disposable, CommentHandler, vscode.CommentingRangeProvider, CommentReactionHandler {
	private static readonly ID = 'ReviewCommentController';
	private _localToDispose: vscode.Disposable[] = [];
	private _commentHandlerId: string;

	private _commentController: vscode.CommentController;

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
		private _reviewManager: ReviewManager,
		private _reposManager: FolderRepositoryManager,
		private _repository: Repository,
		private _reviewModel: ReviewModel,
	) {
		this._commentController = vscode.comments.createCommentController(
			`github-review-${_reposManager.activePullRequest!.number}`,
			_reposManager.activePullRequest!.title,
		);
		this._commentController.commentingRangeProvider = this;
		this._commentController.reactionHandler = this.toggleReaction.bind(this);
		this._localToDispose.push(this._commentController);
		this._commentHandlerId = uuid();
		registerCommentHandler(this._commentHandlerId, this);
	}

	// #region initialize
	async initialize(): Promise<void> {
		this._visibleNormalTextEditors = vscode.window.visibleTextEditors.filter(
			ed => ed.document.uri.scheme !== 'comment',
		);
		await this._reposManager.activePullRequest!.validateDraftMode();
		await this.initializeCommentThreads();
		await this.registerListeners();
	}

	/**
	 * Creates a comment thread for a thread that is not on the latest changes.
	 * @param path The path to the file the comment thread is on.
	 * @param thread The comment thread information from GitHub.
	 * @returns A GHPRCommentThread that has been created on an editor.
	 */
	private createOutdatedCommentThread(path: string, thread: IReviewThread): GHPRCommentThread {
		const commit = thread.comments[0].originalCommitId!;
		const uri = vscode.Uri.file(nodePath.join(`commit~${commit.substr(0, 8)}`, path));
		const reviewUri = toReviewUri(
			uri,
			path,
			undefined,
			commit,
			true,
			{ base: thread.diffSide === DiffSide.LEFT },
			this._repository.rootUri,
		);

		const range = threadRange(thread.originalStartLine - 1, thread.originalEndLine - 1);
		return createVSCodeCommentThreadForReviewThread(reviewUri, range, thread, this._commentController, this._reposManager.getCurrentUser().login);
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
		let startLine = thread.startLine;
		let endLine = thread.endLine;
		const localDiff = await this._repository.diffWithHEAD(path);
		if (localDiff) {
			startLine = mapOldPositionToNew(localDiff, startLine);
			endLine = mapOldPositionToNew(localDiff, endLine);
		}

		const range = threadRange(startLine - 1, endLine - 1);
		return createVSCodeCommentThreadForReviewThread(uri, range, thread, this._commentController, this._reposManager.getCurrentUser().login);
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
		if (!this._reposManager.activePullRequest?.mergeBase) {
			throw new Error('Cannot create review comment thread without an active pull request base.');
		}
		const reviewUri = toReviewUri(
			uri,
			path,
			undefined,
			this._reposManager.activePullRequest.mergeBase,
			false,
			{ base: true },
			this._repository.rootUri,
		);

		const range = threadRange(thread.startLine - 1, thread.endLine - 1);
		return createVSCodeCommentThreadForReviewThread(reviewUri, range, thread, this._commentController, this._reposManager.getCurrentUser().login);
	}

	private async doInitializeCommentThreads(reviewThreads: IReviewThread[]): Promise<void> {
		const threadsByPath = groupBy(reviewThreads, thread => thread.path);

		Object.keys(threadsByPath).forEach(path => {
			const threads = threadsByPath[path];
			const firstThread = threads[0];
			if (firstThread) {
				const fullPath = nodePath.join(this._repository.rootUri.path, firstThread.path).replace(/\\/g, '/');
				const uri = this._repository.rootUri.with({ path: fullPath });

				let rightSideCommentThreads: GHPRCommentThread[] = [];
				let leftSideThreads: GHPRCommentThread[] = [];
				let outdatedCommentThreads: GHPRCommentThread[] = [];

				const threadPromises = threads.map(async thread => {
					if (thread.isOutdated) {
						outdatedCommentThreads.push(this.createOutdatedCommentThread(path, thread));
					} else {
						if (thread.diffSide === DiffSide.RIGHT) {
							rightSideCommentThreads.push(await this.createWorkspaceCommentThread(uri, path, thread));
						} else {
							leftSideThreads.push(this.createReviewCommentThread(uri, path, thread));
						}
					}
				});

				Promise.all(threadPromises);

				this._workspaceFileChangeCommentThreads[path] = rightSideCommentThreads;
				this._reviewSchemeFileChangeCommentThreads[path] = leftSideThreads;
				this._obsoleteFileChangeCommentThreads[path] = outdatedCommentThreads;
			}
		});
	}

	private async initializeCommentThreads(): Promise<void> {
		const activePullRequest = this._reposManager.activePullRequest;
		if (!activePullRequest || !activePullRequest.isResolved()) {
			return;
		}
		return this.doInitializeCommentThreads(activePullRequest.reviewThreadsCache);
	}

	private async registerListeners(): Promise<void> {
		this._localToDispose.push(
			this._reposManager.activePullRequest!.onDidChangePendingReviewState(newDraftMode => {
				[
					this._workspaceFileChangeCommentThreads,
					this._obsoleteFileChangeCommentThreads,
					this._reviewSchemeFileChangeCommentThreads,
				].forEach(commentThreadMap => {
					for (const fileName in commentThreadMap) {
						commentThreadMap[fileName].forEach(thread => {
							updateCommentReviewState(thread, newDraftMode);
							updateCommentThreadLabel(thread);
						});
					}
				});
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
						const line = mapNewPositionToOld(diff, t.range.end.line);
						const sameLine = line + 1 === thread.endLine;
						return sameLine;
					});

					let newThread: GHPRCommentThread;
					if (index > -1) {
						newThread = this._pendingCommentThreadAdds[index];
						newThread.gitHubThreadId = thread.id;
						newThread.comments = thread.comments.map(c => new GHPRComment(c, newThread));
						updateThreadWithRange(newThread, thread);
						this._pendingCommentThreadAdds.splice(index, 1);
					} else {
						const fullPath = nodePath.join(this._repository.rootUri.path, path).replace(/\\/g, '/');
						const uri = this._repository.rootUri.with({ path: fullPath });
						if (thread.isOutdated) {
							newThread = this.createOutdatedCommentThread(path, thread);
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

					const index = threadMap[thread.path].findIndex(t => t.gitHubThreadId === thread.id);
					if (index > -1) {
						const matchingThread = threadMap[thread.path][index];
						updateThread(matchingThread, thread);
					}
				});

				e.removed.forEach(thread => {
					const threadMap = thread.isOutdated
						? this._obsoleteFileChangeCommentThreads
						: thread.diffSide === DiffSide.RIGHT
							? this._workspaceFileChangeCommentThreads
							: this._reviewSchemeFileChangeCommentThreads;

					const index = threadMap[thread.path].findIndex(t => t.gitHubThreadId === thread.id);
					if (index > -1) {
						const matchingThread = threadMap[thread.path][index];
						threadMap[thread.path].splice(index, 1);
						matchingThread.dispose();
					}
				});
			}),
		);
	}

	public updateCommentExpandState(expand: boolean) {
		if (!this._reposManager.activePullRequest) {
			return undefined;
		}

		function updateThreads(threads: { [key: string]: GHPRCommentThread[] }, reviewThreads: Map<string, Map<string, IReviewThread>>) {
			if (reviewThreads.size === 0) {
				return;
			}
			for (const path of reviewThreads.keys()) {
				const reviewThreadsForPath = reviewThreads.get(path)!;
				const commentThreads = threads[path];
				for (const commentThread of commentThreads) {
					const reviewThread = reviewThreadsForPath.get(commentThread.gitHubThreadId)!;
					updateThread(commentThread, reviewThread, expand);
				}
			}
		}

		const obsoleteReviewThreads: Map<string, Map<string, IReviewThread>> = new Map();
		const reviewSchemeReviewThreads: Map<string, Map<string, IReviewThread>> = new Map();
		const workspaceFileReviewThreads: Map<string, Map<string, IReviewThread>> = new Map();
		for (const reviewThread of this._reposManager.activePullRequest.reviewThreadsCache) {
			let mapToUse: Map<string, Map<string, IReviewThread>>;
			if (reviewThread.isOutdated) {
				mapToUse = obsoleteReviewThreads;
			} else {
				if (reviewThread.diffSide === DiffSide.RIGHT) {
					mapToUse = workspaceFileReviewThreads;
				} else {
					mapToUse = reviewSchemeReviewThreads;
				}
			}
			if (!mapToUse.has(reviewThread.path)) {
				mapToUse.set(reviewThread.path, new Map());
			}
			mapToUse.get(reviewThread.path)!.set(reviewThread.id, reviewThread);
		}
		updateThreads(this._obsoleteFileChangeCommentThreads, obsoleteReviewThreads);
		updateThreads(this._reviewSchemeFileChangeCommentThreads, reviewSchemeReviewThreads);
		updateThreads(this._workspaceFileChangeCommentThreads, workspaceFileReviewThreads);
	}

	private visibleEditorsEqual(a: vscode.TextEditor[], b: vscode.TextEditor[]): boolean {
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
		if (thread.uri.scheme === Schemes.Review) {
			return true;
		}


		if (!isFileInRepo(this._repository, thread.uri)) {
			return false;
		}

		if (thread.uri.scheme === this._repository.rootUri.scheme) {
			return true;
		}

		return false;
	}

	async provideCommentingRanges(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): Promise<vscode.Range[] | undefined> {
		let query: ReviewUriParams | undefined =
			(document.uri.query && document.uri.query !== '') ? fromReviewUri(document.uri.query) : undefined;

		if (query) {
			const matchedFile = this.findMatchedFileChangeForReviewDiffView(this._reviewModel.localFileChanges, document.uri);

			if (matchedFile) {
				Logger.debug('Found matched file for commenting ranges.', ReviewCommentController.ID);
				return getCommentingRanges(await matchedFile.changeModel.diffHunks(), query.base, ReviewCommentController.ID);
			}
		}

		if (!isFileInRepo(this._repository, document.uri)) {
			if (document.uri.scheme !== 'output') {
				Logger.debug('No commenting ranges: File is not in the current repository.', ReviewCommentController.ID);
			}
			return;
		}

		if (document.uri.scheme === this._repository.rootUri.scheme) {
			if (!this._reposManager.activePullRequest!.isResolved()) {
				Logger.debug('No commenting ranges: Active PR has not been resolved.', ReviewCommentController.ID);
				return;
			}

			const fileName = this.gitRelativeRootPath(document.uri.path);
			const matchedFile = gitFileChangeNodeFilter(this._reviewModel.localFileChanges).find(
				fileChange => fileChange.fileName === fileName,
			);
			const ranges: vscode.Range[] = [];

			if (matchedFile) {
				const diffHunks = await matchedFile.changeModel.diffHunks();
				if ((matchedFile.status === GitChangeType.RENAME) && (diffHunks.length === 0)) {
					Logger.debug('No commenting ranges: File was renamed with no diffs.', ReviewCommentController.ID);
					return [];
				}

				const contentDiff = await this.getContentDiff(document.uri, matchedFile.fileName);

				for (let i = 0; i < diffHunks.length; i++) {
					const diffHunk = diffHunks[i];
					const start = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber);
					const end = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber + diffHunk.newLength - 1);
					if (start > 0 && end > 0) {
						ranges.push(new vscode.Range(start - 1, 0, end - 1, 0));
					}
				}

				if (ranges.length === 0) {
					Logger.debug('No commenting ranges: File has diffs, but they could not be mapped to current lines.', ReviewCommentController.ID);
				}
			} else {
				Logger.debug('No commenting ranges: File does not match any of the files in the review.', ReviewCommentController.ID);
			}

			Logger.debug(`Providing ${ranges.length} commenting ranges for ${nodePath.basename(document.uri.fsPath)}.`, ReviewCommentController.ID);
			return ranges;
		} else {
			Logger.debug('No commenting ranges: File scheme differs from repository scheme.', ReviewCommentController.ID);
		}

		return;
	}

	// #endregion

	private async getContentDiff(uri: vscode.Uri, fileName: string): Promise<string> {
		const matchedEditor = vscode.window.visibleTextEditors.find(
			editor => editor.document.uri.toString() === uri.toString(),
		);
		if (!this._reposManager.activePullRequest?.head) {
			Logger.appendLine('Failed to get content diff. Cannot get content diff without an active pull request head.');
			throw new Error('Cannot get content diff without an active pull request head.');
		}

		try {
			if (matchedEditor && matchedEditor.document.isDirty) {
				const documentText = matchedEditor.document.getText();
				const details = await this._repository.getObjectDetails(
					this._reposManager.activePullRequest.head.sha,
					fileName,
				);
				const idAtLastCommit = details.object;
				const idOfCurrentText = await this._repository.hashObject(documentText);

				// git diff <blobid> <blobid>
				return await this._repository.diffBlobs(idAtLastCommit, idOfCurrentText);
			} else {
				return await this._repository.diffWith(this._reposManager.activePullRequest.head.sha, fileName);
			}
		} catch (e) {
			Logger.appendLine(`Failed to get content diff. ${formatError(e)}`);
			throw e;
		}
	}

	private findMatchedFileChangeForReviewDiffView(
		fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
		uri: vscode.Uri,
	): GitFileChangeNode | undefined {
		const query = fromReviewUri(uri.query);
		const matchedFiles = fileChanges.filter(fileChangeNode => {
			const fileChange = fileChangeNode.changeModel;
			if (fileChange instanceof RemoteFileChangeModel) {
				return false;
			}

			if (fileChange.fileName !== query.path) {
				return false;
			}

			if (fileChange.filePath.scheme !== 'review') {
				// local file

				if (fileChange.sha === query.commit) {
					return true;
				}
			}

			const q = fileChange.filePath.query ? JSON.parse(fileChange.filePath.query) : undefined;

			if (q && (q.commit === query.commit)) {
				return true;
			}

			const parentQ = fileChange.parentFilePath.query ? JSON.parse(fileChange.parentFilePath.query) : undefined;

			if (parentQ && (parentQ.commit === query.commit)) {
				return true;
			}

			return false;
		});

		if (matchedFiles && matchedFiles.length) {
			return matchedFiles[0] as GitFileChangeNode;
		}
		return undefined;
	}

	private gitRelativeRootPath(path: string) {
		// get path relative to git root directory. Handles windows path by converting it to unix path.
		return nodePath.relative(this._repository.rootUri.path, path).replace(/\\/g, '/');
	}

	// #endregion

	// #region Review
	private getCommentSide(thread: GHPRCommentThread): DiffSide {
		if (thread.uri.scheme === Schemes.Review) {
			const query = fromReviewUri(thread.uri.query);
			return query.base ? DiffSide.LEFT : DiffSide.RIGHT;
		}

		return DiffSide.RIGHT;
	}

	public async startReview(thread: GHPRCommentThread, input: string): Promise<void> {
		const hasExistingComments = thread.comments.length;
		const temporaryCommentId = this.optimisticallyAddComment(thread, input, true);

		try {
			if (!hasExistingComments) {
				const fileName = this.gitRelativeRootPath(thread.uri.path);
				const side = this.getCommentSide(thread);
				this._pendingCommentThreadAdds.push(thread);

				// If the thread is on the workspace file, make sure the position
				// is properly adjusted to account for any local changes.
				let startLine: number;
				let endLine: number;
				if (side === DiffSide.RIGHT) {
					const diff = await this.getContentDiff(thread.uri, fileName);
					startLine = mapNewPositionToOld(diff, thread.range.start.line);
					endLine = mapNewPositionToOld(diff, thread.range.end.line);
				} else {
					startLine = thread.range.start.line;
					endLine = thread.range.end.line;
				}

				await this._reposManager.activePullRequest!.createReviewThread(input, fileName, startLine + 1, endLine + 1, side);
			} else {
				const comment = thread.comments[0];
				if (comment instanceof GHPRComment) {
					await this._reposManager.activePullRequest!.createCommentReply(
						input,
						comment._rawComment.graphNodeId,
						false,
					);
				} else {
					throw new Error('Cannot reply to temporary comment');
				}
			}
		} catch (e) {
			vscode.window.showErrorMessage(`Starting review failed: ${e}`);

			thread.comments = thread.comments.map(c => {
				if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
					c.mode = vscode.CommentMode.Editing;
				}

				return c;
			});
		}
	}

	public async openReview(): Promise<void> {
		await this._reviewManager.openDescription();
		PullRequestOverviewPanel.scrollToReview();
	}

	// #endregion
	private optimisticallyAddComment(thread: GHPRCommentThread, input: string, inDraft: boolean): number {
		const currentUser = this._reposManager.getCurrentUser();
		const comment = new TemporaryComment(thread, input, inDraft, currentUser);
		this.updateCommentThreadComments(thread, [...thread.comments, comment]);
		return comment.id;
	}

	private updateCommentThreadComments(thread: GHPRCommentThread, newComments: (GHPRComment | TemporaryComment)[]) {
		thread.comments = newComments;
		updateCommentThreadLabel(thread);
	}

	private optimisticallyEditComment(thread: GHPRCommentThread, comment: GHPRComment): number {
		const currentUser = this._reposManager.getCurrentUser();
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

	// #region Comment
	async createOrReplyComment(
		thread: GHPRCommentThread,
		input: string,
		isSingleComment: boolean,
		inDraft?: boolean,
	): Promise<void> {
		if (!this._reposManager.activePullRequest) {
			throw new Error('Cannot create comment without an active pull request.');
		}

		const hasExistingComments = thread.comments.length;
		const isDraft = isSingleComment
			? false
			: inDraft !== undefined
				? inDraft
				: this._reposManager.activePullRequest.hasPendingReview;
		const temporaryCommentId = this.optimisticallyAddComment(thread, input, isDraft);

		try {
			if (!hasExistingComments) {
				const fileName = this.gitRelativeRootPath(thread.uri.path);
				this._pendingCommentThreadAdds.push(thread);
				const side = this.getCommentSide(thread);

				// If the thread is on the workspace file, make sure the position
				// is properly adjusted to account for any local changes.
				let startLine: number;
				let endLine: number;
				if (side === DiffSide.RIGHT) {
					const diff = await this.getContentDiff(thread.uri, fileName);
					startLine = mapNewPositionToOld(diff, thread.range.start.line);
					endLine = mapNewPositionToOld(diff, thread.range.end.line);
				} else {
					startLine = thread.range.start.line;
					endLine = thread.range.end.line;
				}
				await this._reposManager.activePullRequest.createReviewThread(
					input,
					fileName,
					startLine + 1,
					endLine + 1,
					side,
					isSingleComment,
				);
			} else {
				const comment = thread.comments[0];
				if (comment instanceof GHPRComment) {
					await this._reposManager.activePullRequest.createCommentReply(
						input,
						comment._rawComment.graphNodeId,
						isSingleComment,
					);
				} else {
					throw new Error('Cannot reply to temporary comment');
				}
			}

			if (isSingleComment) {
				await this._reposManager.activePullRequest.submitReview();
			}
		} catch (e) {
			if (e.graphQLErrors?.length && e.graphQLErrors[0].type === 'NOT_FOUND') {
				vscode.window.showWarningMessage('The comment that you\'re replying to was deleted. Refresh to update.', 'Refresh').then(result => {
					if (result === 'Refresh') {
						this._reviewManager.updateComments();
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

	private async createCommentOnResolve(thread: GHPRCommentThread, input: string): Promise<void> {
		if (!this._reposManager.activePullRequest) {
			throw new Error('Cannot create comment on resolve without an active pull request.');
		}
		const pendingReviewId = await this._reposManager.activePullRequest.getPendingReviewId();
		await this.createOrReplyComment(thread, input, !pendingReviewId);
	}

	async resolveReviewThread(thread: GHPRCommentThread, input?: string): Promise<void> {
		try {
			if (input) {
				await this.createCommentOnResolve(thread, input);
			}

			await this._reposManager.activePullRequest!.resolveReviewThread(thread.gitHubThreadId);
		} catch (e) {
			vscode.window.showErrorMessage(`Resolving conversation failed: ${e}`);
		}
	}

	async unresolveReviewThread(thread: GHPRCommentThread, input?: string): Promise<void> {
		try {
			if (input) {
				await this.createCommentOnResolve(thread, input);
			}

			await this._reposManager.activePullRequest!.unresolveReviewThread(thread.gitHubThreadId);
		} catch (e) {
			vscode.window.showErrorMessage(`Unresolving conversation failed: ${e}`);
		}
	}

	async editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			const temporaryCommentId = this.optimisticallyEditComment(thread, comment);
			try {
				if (!this._reposManager.activePullRequest) {
					throw new Error('Unable to find active pull request');
				}

				await this._reposManager.activePullRequest.editReviewComment(
					comment._rawComment,
					comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.rawBody,
				);
			} catch (e) {
				vscode.window.showErrorMessage(formatError(e));

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

	async deleteComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		try {
			if (!this._reposManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			if (comment instanceof GHPRComment) {
				await this._reposManager.activePullRequest.deleteReviewComment(comment.commentId);
			} else {
				thread.comments = thread.comments.filter(c => !(c instanceof TemporaryComment && c.id === comment.id));
			}

			if (thread.comments.length === 0) {
				thread.dispose();
			} else {
				updateCommentThreadLabel(thread);
			}

			const inDraftMode = await this._reposManager.activePullRequest.validateDraftMode();
			if (inDraftMode !== this._reposManager.activePullRequest.hasPendingReview) {
				this._reposManager.activePullRequest.hasPendingReview = inDraftMode;
			}

			this.update();
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	// #endregion

	// #region Incremental update comments
	public async update(): Promise<void> {
		await this._reposManager.activePullRequest!.validateDraftMode();
	}
	// #endregion

	// #region Reactions
	async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		try {
			if (!this._reposManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			if (
				comment.reactions &&
				!comment.reactions.find(ret => ret.label === reaction.label && !!ret.authorHasReacted)
			) {
				await this._reposManager.activePullRequest.addCommentReaction(
					comment._rawComment.graphNodeId,
					reaction,
				);
			} else {
				await this._reposManager.activePullRequest.deleteCommentReaction(
					comment._rawComment.graphNodeId,
					reaction,
				);
			}
		} catch (e) {
			throw new Error(formatError(e));
		}
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
