/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { v4 as uuid } from 'uuid';
import * as vscode from 'vscode';
import { CommentHandler, registerCommentHandler, unregisterCommentHandler } from '../../commentHandlerResolver';
import { DiffSide, IComment } from '../../common/comment';
import { getCommentingRanges } from '../../common/commentingRanges';
import { DiffChangeType, getModifiedContentFromDiffHunk, parseDiff } from '../../common/diffHunk';
import { GitChangeType, SlimFileChange } from '../../common/file';
import Logger from '../../common/logger';
import { fromPRUri, toPRUri } from '../../common/uri';
import { groupBy } from '../../common/utils';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../../github/prComment';
import { PullRequestModel, ReviewThreadChangeEvent } from '../../github/pullRequestModel';
import {
	CommentReactionHandler,
	createVSCodeCommentThreadForReviewThread,
	updateCommentReviewState,
	updateCommentThreadLabel,
} from '../../github/utils';
import { getInMemPRContentProvider } from '../inMemPRContentProvider';
import { DescriptionNode } from './descriptionNode';
import { DirectoryTreeNode } from './directoryTreeNode';
import { InMemFileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';

export class PRNode extends TreeNode implements CommentHandler, vscode.CommentingRangeProvider, CommentReactionHandler {
	static ID = 'PRNode';

	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[] | undefined;
	private _commentController?: vscode.CommentController;
	public get commentController(): vscode.CommentController | undefined {
		return this._commentController;
	}

	private _prCommentController?: vscode.Disposable & { commentThreadCache: { [key: string]: GHPRCommentThread[] } };
	private _openPREditors: vscode.TextEditor[] = [];
	private _disposables: vscode.Disposable[] = [];

	private _inMemPRContentProvider?: vscode.Disposable;

	private _command: vscode.Command;

	private _commentHandlerId: string;
	private _hasInitializedThreads: boolean = false;
	private _pendingCommentThreadAdds: GHPRCommentThread[] = [];

	public get command(): vscode.Command {
		return this._command;
	}

	public set command(newCommand: vscode.Command) {
		this._command = newCommand;
	}

	constructor(
		public parent: TreeNode | vscode.TreeView<TreeNode>,
		private _folderReposManager: FolderRepositoryManager,
		public pullRequestModel: PullRequestModel,
		private _isLocal: boolean,
	) {
		super();
		this._commentHandlerId = uuid();
		registerCommentHandler(this._commentHandlerId, this);
	}

	// #region Tree
	async getChildren(): Promise<TreeNode[]> {
		Logger.debug(`Fetch children of PRNode #${this.pullRequestModel.number}`, PRNode.ID);
		try {
			if (this.childrenDisposables && this.childrenDisposables.length) {
				this.childrenDisposables.forEach(dp => dp.dispose());
			}

			const descriptionNode = new DescriptionNode(
				this,
				'Description',
				new vscode.ThemeIcon('git-pull-request'),
				this.pullRequestModel,
			);

			if (!this.pullRequestModel.isResolved()) {
				return [descriptionNode];
			}

			this._fileChanges = await this.resolveFileChanges();
			await this.pullRequestModel.initializeReviewThreadCache();

			if (!this._inMemPRContentProvider) {
				this._inMemPRContentProvider = getInMemPRContentProvider().registerTextDocumentContentProvider(
					this.pullRequestModel.number,
					this.provideDocumentContent.bind(this),
				);
			}

			if (!this._prCommentController || !this._commentController) {
				await this.resolvePRCommentController();
			}

			await this.initializeThreadsInOpenEditors(vscode.window.visibleTextEditors);
			await this.pullRequestModel.validateDraftMode();
			await this.refreshContextKey(vscode.window.activeTextEditor);

			const result: TreeNode[] = [descriptionNode];
			const layout = vscode.workspace.getConfiguration('githubPullRequests').get<string>('fileListLayout');
			if (layout === 'tree') {
				// tree view
				const dirNode = new DirectoryTreeNode(this, '');
				this._fileChanges.forEach(f => dirNode.addFile(f));
				dirNode.finalize();
				if (dirNode.label === '') {
					// nothing on the root changed, pull children to parent
					result.push(...dirNode.children);
				} else {
					result.push(dirNode);
				}
			} else {
				// flat view
				result.push(...this._fileChanges);
			}

			this.childrenDisposables = result;
			return result;
		} catch (e) {
			Logger.appendLine(e);
			return [];
		}
	}

	private async resolvePRCommentController(): Promise<
		vscode.Disposable & { commentThreadCache: { [key: string]: GHPRCommentThread[] } }
	> {
		if (this._prCommentController) {
			return this._prCommentController;
		}

		await this.pullRequestModel.githubRepository.ensureCommentsController();
		this._commentController = this.pullRequestModel.githubRepository.commentsController!;
		this._prCommentController = this.pullRequestModel.githubRepository.commentsHandler!.registerCommentController(
			this.pullRequestModel.number,
			this,
		);

		this.registerListeners();

		return this._prCommentController;
	}

	private registerListeners(): void {
		this._disposables.push(
			this.pullRequestModel.onDidChangePendingReviewState(async newDraftMode => {
				if (!newDraftMode) {
					(await this.getFileChanges()).forEach(fileChange => {
						if (fileChange instanceof InMemFileChangeNode) {
							fileChange.comments.forEach(c => (c.isDraft = newDraftMode));
						}
					});
				}

				const commentThreadCache = (await this.resolvePRCommentController()).commentThreadCache;
				for (const fileName in commentThreadCache) {
					commentThreadCache[fileName].forEach(thread => {
						updateCommentReviewState(thread, newDraftMode);
					});
				}
			}),
		);

		this._disposables.push(
			vscode.window.onDidChangeVisibleTextEditors(async e => {
				this.onDidChangeOpenEditors(e);
			}),
		);

		this._disposables.push(this.pullRequestModel.onDidChangeReviewThreads(e => this.onDidChangeReviewThreads(e)));

		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor(async e => {
				await this.refreshContextKey(e);
			}),
		);
	}

	private async getFileChanges(): Promise<(RemoteFileChangeNode | InMemFileChangeNode)[]> {
		if (!this._fileChanges) {
			this._fileChanges = await this.resolveFileChanges();
		}

		return this._fileChanges;
	}

	private async resolveFileChanges(): Promise<(RemoteFileChangeNode | InMemFileChangeNode)[]> {
		if (!this.pullRequestModel.isResolved()) {
			return [];
		}

		const comments = await this.pullRequestModel.getReviewComments();
		const data = await this.pullRequestModel.getFileChangesInfo();

		// Merge base is set as part of getPullRequestFileChangesInfo
		const mergeBase = this.pullRequestModel.mergeBase;
		if (!mergeBase) {
			return [];
		}

		const rawChanges = await parseDiff(data, this._folderReposManager.repository, mergeBase);

		return rawChanges.map(change => {
			const headCommit = this.pullRequestModel.head!.sha;
			const parentFileName = change.status === GitChangeType.RENAME ? change.previousFileName! : change.fileName;
			if (change instanceof SlimFileChange) {
				return new RemoteFileChangeNode(
					this,
					this.pullRequestModel,
					change.status,
					change.fileName,
					change.previousFileName,
					change.blobUrl,
					toPRUri(
						vscode.Uri.file(
							path.resolve(this._folderReposManager.repository.rootUri.fsPath, change.fileName),
						),
						this.pullRequestModel,
						change.baseCommit,
						headCommit,
						change.fileName,
						false,
						change.status,
					),
					toPRUri(
						vscode.Uri.file(
							path.resolve(this._folderReposManager.repository.rootUri.fsPath, parentFileName),
						),
						this.pullRequestModel,
						change.baseCommit,
						headCommit,
						change.fileName,
						true,
						change.status,
					)
				);
			}

			const changedItem = new InMemFileChangeNode(
				this._folderReposManager,
				this,
				this.pullRequestModel,
				change.status,
				change.fileName,
				change.previousFileName,
				change.blobUrl,
				toPRUri(
					vscode.Uri.file(path.resolve(this._folderReposManager.repository.rootUri.fsPath, change.fileName)),
					this.pullRequestModel,
					change.baseCommit,
					headCommit,
					change.fileName,
					false,
					change.status,
				),
				toPRUri(
					vscode.Uri.file(path.resolve(this._folderReposManager.repository.rootUri.fsPath, parentFileName)),
					this.pullRequestModel,
					change.baseCommit,
					headCommit,
					change.fileName,
					true,
					change.status,
				),
				change.isPartial,
				change.patch,
				change.diffHunks,
				comments.filter(comment => comment.path === change.fileName && comment.position !== null),
			);

			return changedItem;
		});
	}

	private getPREditors(editors: vscode.TextEditor[]): vscode.TextEditor[] {
		return editors.filter(editor => {
			if (editor.document.uri.scheme !== 'pr') {
				return false;
			}

			const params = fromPRUri(editor.document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.number) {
				return false;
			}

			return true;
		});
	}

	private addThreadsForEditors(editors: vscode.TextEditor[], commentThreadCache: {[key: string]: GHPRCommentThread[]}): void {
		const reviewThreads = this.pullRequestModel.reviewThreadsCache;
		const threadsByPath = groupBy(reviewThreads, thread => thread.path);
		editors.forEach(editor => {
			const { fileName, isBase } = fromPRUri(editor.document.uri);
			if (threadsByPath[fileName]) {
				commentThreadCache[fileName] = threadsByPath[fileName]
					.filter(
						thread =>
							(thread.diffSide === DiffSide.LEFT && isBase) ||
							(thread.diffSide === DiffSide.RIGHT && !isBase),
					)
					.map(thread => {
						const range = new vscode.Range(
							new vscode.Position(thread.line - 1, 0),
							new vscode.Position(thread.line - 1, 0),
						);

						return createVSCodeCommentThreadForReviewThread(
							editor.document.uri,
							range,
							thread,
							this._commentController,
						);
					});
			}
		});
	}

	private async initializeThreadsInOpenEditors(editors: vscode.TextEditor[]): Promise<void> {
		if (this._hasInitializedThreads) {
			return;
		}

		const commentThreadCache = (await this.resolvePRCommentController()).commentThreadCache;

		const prEditors = this.getPREditors(editors);
		this._openPREditors = prEditors;
		this.addThreadsForEditors(editors, commentThreadCache);

		this._hasInitializedThreads = true;
	}

	private onDidChangeOpenEditors(editors: vscode.TextEditor[]): void {
		const commentThreadCache = this._prCommentController!.commentThreadCache;
		const prEditors = this.getPREditors(editors);
		const removed = this._openPREditors.filter(x => !prEditors.includes(x));
		const added = prEditors.filter(x => !this._openPREditors.includes(x));
		this._openPREditors = prEditors;

		removed.forEach(editor => {
			const fileName = fromPRUri(editor.document.uri)!.fileName;
			const threads = commentThreadCache[fileName] || [];
			threads.forEach(t => t.dispose());
			delete commentThreadCache[fileName];
		});

		if (added.length) {
			this.addThreadsForEditors(added, commentThreadCache);
		}
	}

	private onDidChangeReviewThreads(e: ReviewThreadChangeEvent): void {
		const commentThreadCache = this._prCommentController.commentThreadCache;
		e.added.forEach(thread => {
			const fileName = path
				.relative(this._folderReposManager.repository.rootUri.path, thread.path)
				.replace(/\\/g, '/');
			const index = this._pendingCommentThreadAdds.findIndex(t => {
				const fileName = this.gitRelativeRootPath(t.uri.path);
				const samePath = fileName === thread.path;
				const sameLine = t.range.start.line + 1 === thread.line;
				return samePath && sameLine;
			});

			let newThread: GHPRCommentThread;
			if (index > -1) {
				newThread = this._pendingCommentThreadAdds[index];
				newThread.threadId = thread.id;
				newThread.comments = thread.comments.map(c => new GHPRComment(c, newThread));
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

					newThread = createVSCodeCommentThreadForReviewThread(
						matchingEditor.document.uri,
						range,
						thread,
						this._commentController,
					);
				}
			}

			if (commentThreadCache[thread.path]) {
				commentThreadCache[thread.path].push(newThread);
			} else {
				commentThreadCache[thread.path] = [newThread];
			}
		});

		e.changed.forEach(thread => {
			// Find thread in comment thread cache - should be
			const index = commentThreadCache[thread.path].findIndex(t => t.threadId === thread.id);
			if (index > -1) {
				const matchingThread = commentThreadCache[thread.path][index];
				matchingThread.isResolved = thread.isResolved;
				matchingThread.comments = thread.comments.map(c => new GHPRComment(c, matchingThread));
			}
		});

		e.removed.forEach(async thread => {
			const index = commentThreadCache[thread.path].findIndex(t => t.threadId === thread.id);
			if (index > -1) {
				const matchingThread = commentThreadCache[thread.path][index];
				commentThreadCache[thread.path].splice(index, 1);
				matchingThread.dispose();
			}
		});
	}

	private async refreshContextKey(editor: vscode.TextEditor | undefined) {
		if (!editor) {
			return;
		}

		const editorUri = editor.document.uri;
		if (editorUri.scheme !== 'pr') {
			return;
		}

		const params = fromPRUri(editorUri);
		if (!params || params.prNumber !== this.pullRequestModel.number) {
			return;
		}

		this.setContextKey(this.pullRequestModel.hasPendingReview);
	}

	private setContextKey(inDraftMode: boolean): void {
		vscode.commands.executeCommand('setContext', 'prInDraft', inDraftMode);
	}

	getTreeItem(): vscode.TreeItem {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this._folderReposManager.activePullRequest);

		const { title, number, author, isDraft, html_url } = this.pullRequestModel;

		const { login } = author;

		const labelPrefix = currentBranchIsForThisPR ? '✓ ' : '';
		const tooltipPrefix = currentBranchIsForThisPR ? 'Current Branch * ' : '';
		const formattedPRNumber = number.toString();
		const label = `${labelPrefix}#${formattedPRNumber}: ${isDraft ? '[DRAFT] ' : ''}${title}`;
		const tooltip = `${tooltipPrefix}${title} by @${login}`;
		const description = `by @${login}`;

		return {
			label,
			id: `${this.parent instanceof TreeNode ? this.parent.label : ''}${html_url}`, // unique id stable across checkout status
			tooltip,
			description,
			collapsibleState: 1,
			contextValue:
				'pullrequest' + (this._isLocal ? ':local' : '') + (currentBranchIsForThisPR ? ':active' : ':nonactive'),
			iconPath: this.pullRequestModel.userAvatarUri
				? this.pullRequestModel.userAvatarUri
				: new vscode.ThemeIcon('github'),
		};
	}

	// #endregion

	// #region Helper
	hasCommentThread(thread: GHPRCommentThread): boolean {
		if (thread.uri.scheme !== 'pr') {
			return false;
		}

		const params = fromPRUri(thread.uri);

		if (!params || params.prNumber !== this.pullRequestModel.number) {
			return false;
		}

		return true;
	}
	private updateCommentThreadComments(thread: GHPRCommentThread, newComments: (GHPRComment | TemporaryComment)[]) {
		thread.comments = newComments;
		updateCommentThreadLabel(thread);
	}

	private async findMatchingFileNode(uri: vscode.Uri): Promise<InMemFileChangeNode> {
		const params = fromPRUri(uri);

		if (!params) {
			throw new Error(`${uri.toString()} is not valid PR document`);
		}

		const fileChange = (await this.getFileChanges()).find(change => change.fileName === params.fileName);

		if (!fileChange) {
			throw new Error('No matching file found');
		}

		if (fileChange instanceof RemoteFileChangeNode) {
			throw new Error('Comments not supported on remote file changes');
		}

		return fileChange;
	}

	// #endregion

	async provideCommentingRanges(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): Promise<vscode.Range[] | undefined> {
		if (document.uri.scheme === 'pr') {
			const params = fromPRUri(document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.number) {
				return undefined;
			}

			const fileChange = (await this.getFileChanges()).find(change => change.fileName === params.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return undefined;
			}

			return getCommentingRanges(fileChange.diffHunks, params.isBase);
		}

		return undefined;
	}

	// #endregion

	// #region Document Content Provider
	private async provideDocumentContent(uri: vscode.Uri): Promise<string> {
		const params = fromPRUri(uri);
		if (!params) {
			return '';
		}

		const fileChange = (await this.getFileChanges()).find(
			contentChange => contentChange.fileName === params.fileName,
		);
		if (!fileChange) {
			Logger.appendLine(`PR> can not find content for document ${uri.toString()}`);
			return '';
		}

		if (
			(params.isBase && fileChange.status === GitChangeType.ADD) ||
			(!params.isBase && fileChange.status === GitChangeType.DELETE)
		) {
			return '';
		}

		if (fileChange instanceof RemoteFileChangeNode || fileChange.isPartial) {
			try {
				if (params.isBase) {
					return this.pullRequestModel.getFile(
						fileChange.previousFileName || fileChange.fileName,
						params.baseCommit,
					);
				} else {
					return this.pullRequestModel.getFile(fileChange.fileName, params.headCommit);
				}
			} catch (e) {
				Logger.appendLine(`PR> Fetching file content failed: ${e}`);
				vscode.window
					.showWarningMessage(
						'Opening this file locally failed. Would you like to view it on GitHub?',
						'Open on GitHub',
					)
					.then(result => {
						if (result === 'Open on GitHub') {
							vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(fileChange.blobUrl));
						}
					});
				return '';
			}
		}

		if (fileChange instanceof InMemFileChangeNode) {
			const readContentFromDiffHunk =
				fileChange.status === GitChangeType.ADD || fileChange.status === GitChangeType.DELETE;

			if (readContentFromDiffHunk) {
				if (params.isBase) {
					// left
					const left = [];
					for (let i = 0; i < fileChange.diffHunks.length; i++) {
						for (let j = 0; j < fileChange.diffHunks[i].diffLines.length; j++) {
							const diffLine = fileChange.diffHunks[i].diffLines[j];
							if (diffLine.type === DiffChangeType.Add) {
								// nothing
							} else if (diffLine.type === DiffChangeType.Delete) {
								left.push(diffLine.text);
							} else if (diffLine.type === DiffChangeType.Control) {
								// nothing
							} else {
								left.push(diffLine.text);
							}
						}
					}

					return left.join('\n');
				} else {
					const right = [];
					for (let i = 0; i < fileChange.diffHunks.length; i++) {
						for (let j = 0; j < fileChange.diffHunks[i].diffLines.length; j++) {
							const diffLine = fileChange.diffHunks[i].diffLines[j];
							if (diffLine.type === DiffChangeType.Add) {
								right.push(diffLine.text);
							} else if (diffLine.type === DiffChangeType.Delete) {
								// nothing
							} else if (diffLine.type === DiffChangeType.Control) {
								// nothing
							} else {
								right.push(diffLine.text);
							}
						}
					}

					return right.join('\n');
				}
			} else {
				const originalFileName =
					fileChange.status === GitChangeType.RENAME ? fileChange.previousFileName : fileChange.fileName;
				const originalFilePath = vscode.Uri.joinPath(
					this._folderReposManager.repository.rootUri,
					originalFileName!,
				);
				const originalContent = await this._folderReposManager.repository.show(
					params.baseCommit,
					originalFilePath.fsPath,
				);

				if (params.isBase) {
					return originalContent;
				} else {
					return getModifiedContentFromDiffHunk(originalContent, fileChange.patch);
				}
			}
		}

		return '';
	}

	// #endregion

	private getCommentSide(thread: GHPRCommentThread): DiffSide {
		const query = fromPRUri(thread.uri);
		return query.isBase ? DiffSide.LEFT : DiffSide.RIGHT;
	}

	// #region comment
	public async createSingleComment(thread: GHPRCommentThread, input: string): Promise<void> {
		const temporaryCommentId = this.optimisticallyAddComment(thread, input, false);
		try {
			const fileName = this.gitRelativeRootPath(thread.uri.path);
			const side = this.getCommentSide(thread);
			this._pendingCommentThreadAdds.push(thread);
			await this.pullRequestModel.createReviewThread(input, fileName, thread.range.start.line + 1, side, true);
			await this.pullRequestModel.submitReview();
		} catch (e) {
			vscode.window.showErrorMessage(`Creating comment failed: ${e}`);

			thread.comments = thread.comments.map(c => {
				if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
					c.mode = vscode.CommentMode.Editing;
				}

				return c;
			});
		}
	}

	public async createOrReplyComment(thread: GHPRCommentThread, input: string, inDraft?: boolean): Promise<void> {
		const hasExistingComments = thread.comments.length;
		const isDraft = inDraft !== undefined ? inDraft : this.pullRequestModel.hasPendingReview;
		const temporaryCommentId = this.optimisticallyAddComment(thread, input, isDraft);

		try {
			if (hasExistingComments) {
				await this.reply(thread, input);
			} else {
				const fileName = this.gitRelativeRootPath(thread.uri.path);
				const side = this.getCommentSide(thread);
				this._pendingCommentThreadAdds.push(thread);
				await this.pullRequestModel.createReviewThread(input, fileName, thread.range.start.line + 1, side);
			}
		} catch (e) {
			vscode.window.showErrorMessage(`Creating comment failed: ${e}`);

			thread.comments = thread.comments.map(c => {
				if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
					c.mode = vscode.CommentMode.Editing;
				}

				return c;
			});
		}
	}

	private optimisticallyAddComment(thread: GHPRCommentThread, input: string, inDraft: boolean): number {
		const currentUser = this._folderReposManager.getCurrentUser(this.pullRequestModel);
		const comment = new TemporaryComment(thread, input, inDraft, currentUser);
		this.updateCommentThreadComments(thread, [...thread.comments, comment]);
		return comment.id;
	}

	private optimisticallyEditComment(thread: GHPRCommentThread, comment: GHPRComment): number {
		const currentUser = this._folderReposManager.getCurrentUser(this.pullRequestModel);
		const temporaryComment = new TemporaryComment(
			thread,
			comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body,
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

	private reply(thread: GHPRCommentThread, input: string): Promise<IComment | undefined> {
		const replyingTo = thread.comments[0];
		if (replyingTo instanceof GHPRComment) {
			return this.pullRequestModel.createCommentReply(input, replyingTo._rawComment.graphNodeId);
		} else {
			// TODO can we do better?
			throw new Error('Cannot respond to temporary comment');
		}
	}

	public async editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			const temporaryCommentId = this.optimisticallyEditComment(thread, comment);
			try {
				await this.pullRequestModel.editReviewComment(
					comment._rawComment,
					comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body,
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
				comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body,
			);
		}
	}

	public async deleteComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			await this.pullRequestModel.deleteReviewComment(comment.commentId);
		} else {
			thread.comments = thread.comments.filter(c => c instanceof TemporaryComment && c.id === comment.id);
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
		const temporaryCommentId = this.optimisticallyAddComment(thread, input, true);

		try {
			const fileName = this.gitRelativeRootPath(thread.uri.path);
			const side = this.getCommentSide(thread);
			this._pendingCommentThreadAdds.push(thread);
			await this.pullRequestModel.createReviewThread(input, fileName, thread.range.start.line + 1, side);

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

	public async finishReview(thread: GHPRCommentThread, input: string): Promise<void> {
		try {
			await this.createOrReplyComment(thread, input, false);
			await this.pullRequestModel.submitReview();
			this.setContextKey(false);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to submit the review: ${e}`);
		}
	}

	public async deleteReview(): Promise<void> {
		await this.pullRequestModel.deleteReview();
		this.setContextKey(false);
	}

	// #endregion

	// #region Reaction
	async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		if (comment.parent!.uri.scheme !== 'pr') {
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

	// #endregion

	dispose(): void {
		super.dispose();

		unregisterCommentHandler(this._commentHandlerId);

		if (this._inMemPRContentProvider) {
			this._inMemPRContentProvider.dispose();
		}

		if (this._prCommentController) {
			this._prCommentController.dispose();
		}

		this._commentController = undefined;

		this._disposables.forEach(d => d.dispose());
	}
}
