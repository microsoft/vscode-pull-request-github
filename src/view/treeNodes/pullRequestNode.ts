/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { parseDiff, getModifiedContentFromDiffHunk, DiffChangeType } from '../../common/diffHunk';
import { getZeroBased, getAbsolutePosition, getPositionInDiff, mapHeadLineToDiffHunkPosition } from '../../common/diffPositionMapping';
import { SlimFileChange, GitChangeType } from '../../common/file';
import Logger from '../../common/logger';
import { Resource } from '../../common/resources';
import { fromPRUri, toPRUri } from '../../common/uri';
import { groupBy, uniqBy } from '../../common/utils';
import { DescriptionNode } from './descriptionNode';
import { RemoteFileChangeNode, InMemFileChangeNode, GitFileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';
import { getInMemPRContentProvider } from '../inMemPRContentProvider';
import { IComment } from '../../common/comment';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../../github/prComment';
import { PullRequestManager } from '../../github/pullRequestManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { createVSCodeCommentThread, parseGraphQLReaction, updateCommentThreadLabel, updateCommentReviewState, updateCommentReactions, CommentReactionHandler } from '../../github/utils';
import { CommentHandler, registerCommentHandler, unregisterCommentHandler } from '../../commentHandlerResolver';
import { ReactionGroup } from '../../github/graphql';
import { getCommentingRanges } from '../../common/commentingRanges';

/**
 * Thread data is raw data. It should be transformed to GHPRCommentThreads
 * before being sent to VSCode.
 */
export interface ThreadData {
	threadId: string;
	uri: vscode.Uri;
	range: vscode.Range;
	comments: IComment[];
	collapsibleState: vscode.CommentThreadCollapsibleState;
}

export function getDocumentThreadDatas(
	uri: vscode.Uri,
	isBase: boolean,
	fileChange: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode),
	matchingComments: IComment[]): ThreadData[] {

	if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
		return [];
	}

	let sections = groupBy(matchingComments, comment => String(comment.position));
	let threads: ThreadData[] = [];

	for (let i in sections) {
		let comments = sections[i];

		const firstComment = comments[0];
		let commentAbsolutePosition = fileChange.isPartial
			? getPositionInDiff(firstComment, fileChange.diffHunks, isBase)
			: getAbsolutePosition(firstComment, fileChange.diffHunks, isBase);

		if (commentAbsolutePosition < 0) {
			continue;
		}

		const pos = new vscode.Position(getZeroBased(commentAbsolutePosition), 0);
		const range = new vscode.Range(pos, pos);

		threads.push({
			threadId: firstComment.id.toString(),
			uri: uri,
			range,
			comments,
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded
		});
	}

	return threads;
}

export class PRNode extends TreeNode implements CommentHandler, vscode.CommentingRangeProvider, CommentReactionHandler {
	static ID = 'PRNode';

	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[] | undefined;
	private _commentController?: vscode.CommentController;
	public get commentController(): vscode.CommentController | undefined {
		return this._commentController;
	}

	private _prCommentController?: vscode.Disposable & { commentThreadCache: { [key: string]: GHPRCommentThread[] } };
	private _disposables: vscode.Disposable[] = [];

	private _inMemPRContentProvider?: vscode.Disposable;

	private _command: vscode.Command;

	private _commentHandlerId: string;

	public get command(): vscode.Command {
		return this._command;
	}

	public set command(newCommand: vscode.Command) {
		this._command = newCommand;
	}

	constructor(
		public parent: TreeNode | vscode.TreeView<TreeNode>,
		private _prManager: PullRequestManager,
		public pullRequestModel: PullRequestModel,
		private _isLocal: boolean
	) {
		super();
		this._commentHandlerId = pullRequestModel.prNumber.toString() + Date.now().toString();
		registerCommentHandler(this._commentHandlerId, this);
	}

	// #region Tree
	async getChildren(): Promise<TreeNode[]> {
		Logger.debug(`Fetch children of PRNode #${this.pullRequestModel.prNumber}`, PRNode.ID);
		try {
			if (this.childrenDisposables && this.childrenDisposables.length) {
				this.childrenDisposables.forEach(dp => dp.dispose());
			}

			const descriptionNode = new DescriptionNode(this, 'Description', {
				light: Resource.icons.light.Description,
				dark: Resource.icons.dark.Description
			}, this.pullRequestModel);

			if (!this.pullRequestModel.isResolved()) {
				return [descriptionNode];
			}

			this._fileChanges = await this.resolveFileChanges();

			if (!this._inMemPRContentProvider) {
				this._inMemPRContentProvider = getInMemPRContentProvider().registerTextDocumentContentProvider(this.pullRequestModel.prNumber, this.provideDocumentContent.bind(this));
			}

			// The review manager will register a document comment's controller, so the node does not need to
			if (!this.pullRequestModel.equals(this._prManager.activePullRequest)) {
				if (!this._prCommentController || !this._commentController) {
					await this.pullRequestModel.githubRepository.ensureCommentsController();
					this._commentController = this.pullRequestModel.githubRepository.commentsController!;
					this._prCommentController = this.pullRequestModel.githubRepository.commentsHandler!.registerCommentController(this.pullRequestModel.prNumber, this);

					this._disposables.push(this.pullRequestModel.onDidChangeDraftMode(async newDraftMode => {
						if (!newDraftMode) {
							(await this.getFileChanges()).forEach(fileChange => {
								if (fileChange instanceof InMemFileChangeNode) {
									fileChange.comments.forEach(c => c.isDraft = newDraftMode);
								}
							});
						}

						for (let fileName in this._prCommentController!.commentThreadCache) {
							this._prCommentController!.commentThreadCache[fileName].forEach(thread => {
								updateCommentReviewState(thread, newDraftMode);
							});
						}
					}));
				}

				await this.refreshExistingPREditors(vscode.window.visibleTextEditors, true);

				this._disposables.push(vscode.window.onDidChangeVisibleTextEditors(async e => {
					// Create Comment Threads when the editor is visible
					// Dispose when the editor is invisible and remove them from the cache map
					// Comment Threads in cache map is updated only when users trigger refresh
					await this.refreshExistingPREditors(e, false);
				}));

				await this._prManager.validateDraftMode(this.pullRequestModel);
				await this.refreshContextKey(vscode.window.activeTextEditor);
				this._disposables.push(vscode.window.onDidChangeActiveTextEditor(async e => {
					await this.refreshContextKey(e);
				}));
			} else {
				await this.pullRequestModel.githubRepository.ensureCommentsController();
				this.pullRequestModel.githubRepository.commentsHandler!.clearCommentThreadCache(this.pullRequestModel.prNumber);
			}

			let result = [descriptionNode, ...this._fileChanges];

			this.childrenDisposables = result;
			return result;
		} catch (e) {
			Logger.appendLine(e);
			return [];
		}
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

		const comments = await this._prManager.getPullRequestComments(this.pullRequestModel);
		const data = await this._prManager.getPullRequestFileChangesInfo(this.pullRequestModel);

		// Merge base is set as part of getPullRequestFileChangesInfo
		const mergeBase = this.pullRequestModel.mergeBase;
		if (!mergeBase) {
			return [];
		}

		const rawChanges = await parseDiff(data, this._prManager.repository, mergeBase);

		return rawChanges.map(change => {
			if (change instanceof SlimFileChange) {
				return new RemoteFileChangeNode(
					this,
					this.pullRequestModel,
					change.status,
					change.fileName,
					change.blobUrl
				);
			}

			const headCommit = this.pullRequestModel.head!.sha;
			let changedItem = new InMemFileChangeNode(
				this,
				this.pullRequestModel,
				change.status,
				change.fileName,
				change.previousFileName,
				change.blobUrl,
				toPRUri(vscode.Uri.file(path.resolve(this._prManager.repository.rootUri.fsPath, change.fileName)), this.pullRequestModel, change.baseCommit, headCommit, change.fileName, false, change.status),
				toPRUri(vscode.Uri.file(path.resolve(this._prManager.repository.rootUri.fsPath, change.fileName)), this.pullRequestModel, change.baseCommit, headCommit, change.fileName, true, change.status),
				change.isPartial,
				change.patch,
				change.diffHunks,
				comments.filter(comment => comment.path === change.fileName && comment.position !== null),
			);

			return changedItem;
		});
	}

	async refreshExistingPREditors(editors: vscode.TextEditor[], incremental: boolean): Promise<void> {
		let currentPRDocuments = editors.filter(editor => {
			if (editor.document.uri.scheme !== 'pr') {
				return false;
			}

			const params = fromPRUri(editor.document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.prNumber) {
				return false;
			}

			return true;
		}).map(editor => {
			return {
				fileName: fromPRUri(editor.document.uri)!.fileName,
				document: editor.document
			};
		});

		for (let fileName in this._prCommentController!.commentThreadCache) {
			let commentThreads = this._prCommentController!.commentThreadCache[fileName];

			let matchedEditor = currentPRDocuments.find(editor => editor.fileName === fileName);

			if (!matchedEditor) {
				commentThreads.forEach(thread => thread.dispose!());
				delete this._prCommentController!.commentThreadCache[fileName];
			}
		}

		if (!incremental) {
			// it's tiggerred by file opening, so we only take care newly opened documents.
			currentPRDocuments = currentPRDocuments.filter(editor => this._prCommentController!.commentThreadCache[editor.fileName] === undefined);
		}

		currentPRDocuments = uniqBy(currentPRDocuments, editor => editor.fileName);

		if (currentPRDocuments.length) {
			// initialize before await
			currentPRDocuments.forEach(editor => {
				if (!this._prCommentController!.commentThreadCache[editor.fileName]) {
					this._prCommentController!.commentThreadCache[editor.fileName] = [];
				}
			});

			const inDraftMode = await this._prManager.validateDraftMode(this.pullRequestModel);
			currentPRDocuments.forEach(async editor => {
				let fileChange = (await this.getFileChanges()).find(fc => fc.fileName === editor.fileName);

				if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
					return;
				}

				const parentFilePath = fileChange.parentFilePath;
				const filePath = fileChange.filePath;

				let newLeftCommentThreads = getDocumentThreadDatas(parentFilePath, true, fileChange, fileChange.comments);
				let newRightSideCommentThreads = getDocumentThreadDatas(filePath, false, fileChange, fileChange.comments);

				let oldCommentThreads: GHPRCommentThread[] = [];

				if (incremental) {
					let oldLeftSideCommentThreads = this._prCommentController!.commentThreadCache[editor.fileName].filter(thread => thread.uri.toString() === parentFilePath.toString());
					let oldRightSideCommentThreads = this._prCommentController!.commentThreadCache[editor.fileName].filter(thread => thread.uri.toString() === filePath.toString());

					oldCommentThreads = [...oldLeftSideCommentThreads, ...oldRightSideCommentThreads];
				}

				this.updateFileChangeCommentThreads(oldCommentThreads, [...newLeftCommentThreads, ...newRightSideCommentThreads], fileChange, inDraftMode);
			});

		}
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
		if (!params || params.prNumber !== this.pullRequestModel.prNumber) {
			return;
		}

		this.setContextKey(this.pullRequestModel.inDraftMode);
	}

	private setContextKey(inDraftMode: boolean): void {
		vscode.commands.executeCommand('setContext', 'prInDraft', inDraftMode);
	}

	async revealComment(comment: IComment) {
		let fileChange = (await this.getFileChanges()).find(fc => {
			if (fc.fileName !== comment.path) {
				return false;
			}

			if (!fc.pullRequest.isResolved()) {
				return false;
			}

			if (fc.pullRequest.head.sha !== comment.commitId) {
				return false;
			}

			return true;
		});

		if (fileChange) {
			await this.reveal(fileChange, { focus: true });
			if (!fileChange.command.arguments) {
				return;
			}
			if (fileChange instanceof InMemFileChangeNode) {
				let lineNumber = fileChange.getCommentPosition(comment);
				const opts = fileChange.opts;
				opts.selection = new vscode.Range(lineNumber, 0, lineNumber, 0);
				fileChange.opts = opts;
				await vscode.commands.executeCommand(fileChange.command.command, fileChange);
			} else {
				await vscode.commands.executeCommand(fileChange.command.command, ...fileChange.command.arguments!);
			}
		}
	}

	getTreeItem(): vscode.TreeItem {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this._prManager.activePullRequest);

		const {
			title,
			prNumber,
			author,
			isDraft,
		} = this.pullRequestModel;

		const {
			login,
		} = author;

		const labelPrefix = (currentBranchIsForThisPR ? '✓ ' : '');
		const tooltipPrefix = (currentBranchIsForThisPR ? 'Current Branch * ' : '');
		const formattedPRNumber = prNumber.toString();
		const label = `${labelPrefix}${title}`;
		const tooltip = `${tooltipPrefix}${title} (#${formattedPRNumber}) by @${login}`;
		const description = `#${formattedPRNumber}${isDraft ? '(draft)' : ''} by @${login}`;

		return {
			label,
			tooltip,
			description,
			collapsibleState: 1,
			contextValue: 'pullrequest' + (this._isLocal ? ':local' : '') + (currentBranchIsForThisPR ? ':active' : ':nonactive'),
			iconPath: this.pullRequestModel.userAvatarUri
				? this.pullRequestModel.userAvatarUri
				: { light: Resource.icons.light.Avatar, dark: Resource.icons.dark.Avatar }
		};
	}

	// #endregion

	// #region Helper
	hasCommentThread(thread: GHPRCommentThread): boolean {
		if (thread.uri.scheme !== 'pr') {
			return false;
		}

		if (this._prManager.activePullRequest && this._prManager.activePullRequest.prNumber === this.pullRequestModel.prNumber) {
			return false;
		}

		let params = fromPRUri(thread.uri);

		if (!params || params.prNumber !== this.pullRequestModel.prNumber) {
			return false;
		}

		return true;
	}

	private createCommentThreads(fileName: string, commentThreads: ThreadData[]) {
		const threads = commentThreads.map(thread => createVSCodeCommentThread(thread, this._commentController!));
		this._prCommentController!.commentThreadCache[fileName] = threads;
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

	private calculateCommentPosition(fileChange: InMemFileChangeNode, thread: GHPRCommentThread): number {
		const uri = thread.uri;
		const params = fromPRUri(uri);

		const isBase = !!(params && params.isBase);
		const position = mapHeadLineToDiffHunkPosition(fileChange.diffHunks, '', thread.range.start.line + 1, isBase);

		if (position < 0) {
			throw new Error('Comment position cannot be negative');
		}

		return position;
	}

	// #endregion

	async provideCommentingRanges(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.Range[] | undefined> {
		if (document.uri.scheme === 'pr') {
			const params = fromPRUri(document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.prNumber) {
				return;
			}

			const fileChange = (await this.getFileChanges()).find(change => change.fileName === params.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return;
			}

			return getCommentingRanges(fileChange.diffHunks, document.lineCount, fileChange.isPartial, params.isBase);
		}
	}

	// #endregion

	// #region Incremental updates
	private updateFileChangeCommentThreads(oldCommentThreads: GHPRCommentThread[], newCommentThreads: ThreadData[], newFileChange: InMemFileChangeNode, inDraftMode: boolean) {
		// remove
		oldCommentThreads.forEach(thread => {
			// No current threads match old thread, it has been removed
			const matchingThreads = newCommentThreads && newCommentThreads.filter(newThread => newThread.threadId === thread.threadId);
			if (!matchingThreads.length) {
				thread.dispose!();
			}
		});

		if (newCommentThreads && newCommentThreads.length) {
			let added: ThreadData[] = [];
			newCommentThreads.forEach(thread => {
				const matchingCommentThreads = oldCommentThreads.filter(oldComment => oldComment.threadId === thread.threadId);

				if (matchingCommentThreads.length === 0) {
					added.push(thread);
					if (thread.uri.scheme === 'file') {
						thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
					}
				}

				matchingCommentThreads.forEach(existingThread => {
					existingThread.comments = existingThread.comments.map(cmt => {
						if (cmt instanceof TemporaryComment) {
							// If the body of the temporary comment already matches the comment, then replace it.
							// Otherwise, retain the temporary comment.
							const matchingComment = thread.comments.find(c => c.body === cmt.body);
							if (matchingComment) {
								return new GHPRComment(matchingComment, existingThread);
							}

							return cmt;
						}

						// Update existing comments
						const matchedComment = thread.comments.find(c => c.id.toString() === cmt.commentId);
						if (matchedComment) {
							return new GHPRComment(matchedComment, existingThread);
						}

						// Remove comments that are no longer present
						return undefined;
					}).filter((c: TemporaryComment | GHPRComment | undefined): c is GHPRComment | TemporaryComment => !!c);

					const addedComments = thread.comments.filter(cmt => !existingThread.comments.some(existingComment => existingComment instanceof GHPRComment && existingComment.commentId === cmt.id.toString()));
					existingThread.comments = [...existingThread.comments, ...addedComments.map(comment => new GHPRComment(comment, existingThread))];
				});
			});

			if (added.length) {
				this.createCommentThreads(newFileChange.fileName, added);
			}
		}
	}

	// #endregion

	// #region Document Content Provider
	private async provideDocumentContent(uri: vscode.Uri): Promise<string> {
		let params = fromPRUri(uri);
		if (!params) {
			return '';
		}

		let fileChanges = (await this.getFileChanges()).filter(contentChange => (contentChange instanceof InMemFileChangeNode) && contentChange.fileName === params!.fileName);
		if (fileChanges.length) {
			let fileChange = fileChanges[0] as InMemFileChangeNode;
			let readContentFromDiffHunk = fileChange.isPartial || fileChange.status === GitChangeType.ADD || fileChange.status === GitChangeType.DELETE;

			if (readContentFromDiffHunk) {
				if (params.isBase) {
					// left
					let left = [];
					for (let i = 0; i < fileChange.diffHunks.length; i++) {
						for (let j = 0; j < fileChange.diffHunks[i].diffLines.length; j++) {
							let diffLine = fileChange.diffHunks[i].diffLines[j];
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
					let right = [];
					for (let i = 0; i < fileChange.diffHunks.length; i++) {
						for (let j = 0; j < fileChange.diffHunks[i].diffLines.length; j++) {
							let diffLine = fileChange.diffHunks[i].diffLines[j];
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
				const originalFileName = fileChange.status === GitChangeType.RENAME ? fileChange.previousFileName : fileChange.fileName;
				const originalFilePath = path.join(this._prManager.repository.rootUri.fsPath, originalFileName!);
				const originalContent = await this._prManager.repository.show(params.baseCommit, originalFilePath);

				if (params.isBase) {
					return originalContent;
				} else {
					return getModifiedContentFromDiffHunk(originalContent, fileChange.patch);
				}
			}
		}
		Logger.appendLine(`PR> can not find content for document ${uri.toString()}`);
		return '';
	}

	// #endregion

	// #region comment
	public async createOrReplyComment(thread: GHPRCommentThread, input: string, inDraft?: boolean) {
		const hasExistingComments = thread.comments.length;
		const isDraft = inDraft !== undefined ? inDraft : this.pullRequestModel.inDraftMode;
		const temporaryCommentId = this.optimisticallyAddComment(thread, input, isDraft);

		try {
			const fileChange = await this.findMatchingFileNode(thread.uri);
			const rawComment = hasExistingComments
				? await this.reply(thread, input)
				: await this.createFirstCommentInThread(thread, input, fileChange);

			fileChange.comments.push(rawComment!);

			this.replaceTemporaryComment(thread, rawComment!, temporaryCommentId);
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
		const currentUser = this._prManager.getCurrentUser(this.pullRequestModel);
		const comment = new TemporaryComment(thread, input, inDraft, currentUser);
		this.updateCommentThreadComments(thread, [...thread.comments, comment]);
		return comment.id;
	}

	private optimisticallyEditComment(thread: GHPRCommentThread, comment: GHPRComment): number {
		const currentUser = this._prManager.getCurrentUser(this.pullRequestModel);
		const temporaryComment = new TemporaryComment(thread, comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body, !!comment.label, currentUser, comment);
		thread.comments = thread.comments.map(c => {
			if (c instanceof GHPRComment && c.commentId === comment.commentId) {
				return temporaryComment;
			}

			return c;
		});

		return temporaryComment.id;
	}

	private replaceTemporaryComment(thread: GHPRCommentThread, realComment: IComment, temporaryCommentId: number): void {
		thread.comments = thread.comments.map(c => {
			if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
				return new GHPRComment(realComment, thread);
			}

			return c;
		});
	}

	private reply(thread: GHPRCommentThread, input: string): Promise<IComment | undefined> {
		const replyingTo = thread.comments[0];
		if (replyingTo instanceof GHPRComment) {
			return this._prManager.createCommentReply(this.pullRequestModel, input, replyingTo._rawComment);
		} else {
			// TODO can we do better?
			throw new Error('Cannot respond to temporary comment');
		}
	}

	private async createFirstCommentInThread(thread:GHPRCommentThread, input: string, fileChange: InMemFileChangeNode): Promise<IComment | undefined> {
		const position = this.calculateCommentPosition(fileChange, thread);
		const rawComment = await this._prManager.createComment(this.pullRequestModel, input, fileChange.fileName, position);

		// Add new thread to cache
		const existingThreads = this._prCommentController!.commentThreadCache[fileChange.fileName];
		if (existingThreads) {
			this._prCommentController!.commentThreadCache[fileChange.fileName] = [...existingThreads, thread];
		} else {
			this._prCommentController!.commentThreadCache[fileChange.fileName] = [thread];
		}

		return rawComment;
	}

	public async editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		const fileChange = await this.findMatchingFileNode(thread.uri);

			if (comment instanceof GHPRComment) {
				const temporaryCommentId = this.optimisticallyEditComment(thread, comment);
				try {
					const rawComment = await this._prManager.editReviewComment(this.pullRequestModel, comment._rawComment, comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body);

					const index = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
					if (index > -1) {
						fileChange.comments.splice(index, 1, rawComment);
					}

					this.replaceTemporaryComment(thread, rawComment!, temporaryCommentId);
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
				this.createOrReplyComment(thread, comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body);
			}
	}

	public async deleteComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			await this._prManager.deleteReviewComment(this.pullRequestModel, comment.commentId);
			const fileChange = await this.findMatchingFileNode(thread.uri);
			let index = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
			if (index > -1) {
				fileChange.comments.splice(index, 1);
			}

			thread.comments = thread.comments.filter(c => c instanceof GHPRComment && c.commentId !== comment.commentId);

			if (thread.comments.length === 0) {
				let rawComment = comment._rawComment;

				if (rawComment.path) {
					let threadIndex = this._prCommentController!.commentThreadCache[rawComment.path].findIndex(cachedThread => cachedThread.threadId === thread.threadId);
					this._prCommentController!.commentThreadCache[rawComment.path].splice(threadIndex, 1);
				}

				thread.dispose!();
			}
		} else {
			thread.comments = thread.comments.filter(c => c instanceof TemporaryComment && c.id === comment.id);
		}

		await this._prManager.validateDraftMode(this.pullRequestModel);
	}
	// #endregion

	// #region Review
	public async startReview(thread: GHPRCommentThread, input: string): Promise<void> {
		await this._prManager.startReview(this.pullRequestModel);
		await this.createOrReplyComment(thread, input);
		this.setContextKey(true);
	}

	public async finishReview(thread: GHPRCommentThread, input: string): Promise<void> {
		try {
			await this.createOrReplyComment(thread, input, false);
			await this._prManager.submitReview(this.pullRequestModel);
			this.setContextKey(false);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to submit the review: ${e}`);
		}
	}

	public async deleteReview(): Promise<void> {
		const { deletedReviewId, deletedReviewComments } = await this._prManager.deleteReview(this.pullRequestModel);

		// Group comments by file and then position to create threads.
		const commentsByPath = groupBy(deletedReviewComments, comment => comment.path || '');

		for (let filePath in commentsByPath) {
			const matchingFileChange = (await this.getFileChanges()).find(fileChange => fileChange.fileName === filePath);

			if (matchingFileChange && matchingFileChange instanceof InMemFileChangeNode) {
				matchingFileChange.comments = matchingFileChange.comments.filter(comment => comment.pullRequestReviewId !== deletedReviewId);
				if (this._prCommentController!.commentThreadCache[matchingFileChange.fileName]) {
					let threads: GHPRCommentThread[] = [];

					this._prCommentController!.commentThreadCache[matchingFileChange.fileName].forEach(thread => {
						this.updateCommentThreadComments(thread, thread.comments.filter((comment: GHPRComment) => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId)));
						if (!thread.comments.length) {
							thread.dispose!();
						} else {
							threads.push(thread);
						}
					});

					if (threads.length) {
						this._prCommentController!.commentThreadCache[matchingFileChange.fileName] = threads;
					} else {
						delete this._prCommentController!.commentThreadCache[matchingFileChange.fileName];
					}
				}
			}
		}

		this.setContextKey(false);
	}

	// #endregion

	// #region Reaction
	async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		if (comment.parent!.uri.scheme !== 'pr') {
			return;
		}

		const params = fromPRUri(comment.parent!.uri);

		if (!params) {
			return;
		}

		const fileChange = await this.findMatchingFileNode(comment.parent!.uri);
		const commentIndex = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);

		if (commentIndex < 0) {
			return;
		}

		let reactionGroups: ReactionGroup[];
		if (comment.reactions && !comment.reactions.find(ret => ret.label === reaction.label && !!ret.authorHasReacted)) {
			// add reaction
			const result = await this._prManager.addCommentReaction(this.pullRequestModel, comment._rawComment.graphNodeId, reaction);
			reactionGroups = result.addReaction.subject.reactionGroups;
		} else {
			const result = await this._prManager.deleteCommentReaction(this.pullRequestModel, comment._rawComment.graphNodeId, reaction);
			reactionGroups = result.removeReaction.subject.reactionGroups;
		}

		fileChange.comments[commentIndex].reactions = parseGraphQLReaction(reactionGroups);
		updateCommentReactions(comment, fileChange.comments[commentIndex].reactions!);

		if (this._prCommentController!.commentThreadCache[params.fileName]) {
			this._prCommentController!.commentThreadCache[params.fileName].forEach(thread => {
				if (!thread.comments) {
					return;
				}

				if (thread.comments.find((cmt: GHPRComment) => cmt.commentId === comment.commentId)) {
					thread.comments = thread.comments;
				}
			});
		}
	}

	// #endregion

	dispose(): void {
		super.dispose();

		if (this._inMemPRContentProvider) {
			this._inMemPRContentProvider.dispose();
		}

		if (this._prCommentController) {
			this._prCommentController.dispose();
		}

		this._commentController = undefined;

		this._disposables.forEach(d => d.dispose());

		unregisterCommentHandler(this._commentHandlerId);
	}
}
