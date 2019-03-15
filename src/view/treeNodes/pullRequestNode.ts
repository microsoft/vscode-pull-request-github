/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { parseDiff, getModifiedContentFromDiffHunk, DiffChangeType, DiffHunk } from '../../common/diffHunk';
import { getZeroBased, getAbsolutePosition, getPositionInDiff, mapHeadLineToDiffHunkPosition } from '../../common/diffPositionMapping';
import { SlimFileChange, GitChangeType } from '../../common/file';
import Logger from '../../common/logger';
import { Resource } from '../../common/resources';
import { fromPRUri, toPRUri } from '../../common/uri';
import { groupBy } from '../../common/utils';
import { DescriptionNode } from './descriptionNode';
import { RemoteFileChangeNode, InMemFileChangeNode, GitFileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';
import { getInMemPRContentProvider } from '../inMemPRContentProvider';
import { Comment } from '../../common/comment';
import { PullRequestManager } from '../../github/pullRequestManager';
import { PullRequestModel } from '../../github/pullRequestModel';
import { CommentHandler, convertToVSCodeComment, createVSCodeCommentThread, getReactionGroup, parseGraphQLReaction, updateCommentThreadLabel } from '../../github/utils';
import { getCommentThreadCommands, getEditCommand, getDeleteCommand, getEmptyCommentThreadCommands } from '../../github/commands';

export function provideDocumentComments(
	uri: vscode.Uri,
	isBase: boolean,
	fileChange: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode),
	matchingComments: Comment[]) {

	if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
		return;
	}

	// Partial file change indicates that the file content is only the diff, so the entire
	// document can be commented on.
	const commentingRanges = fileChange.isPartial
		? [new vscode.Range(0, 0, 0, 0)]
		: getCommentingRanges(fileChange.diffHunks, isBase);

	if (!matchingComments || !matchingComments.length) {
		return {
			threads: [],
			commentingRanges
		};
	}

	let sections = groupBy(matchingComments, comment => String(comment.position));
	let threads: vscode.CommentThread[] = [];

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
			resource: uri,
			range,
			comments: comments.map(comment => convertToVSCodeComment(comment, undefined)),
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
		});
	}

	return {
		threads,
		commentingRanges
	};
}

export function getCommentingRanges(diffHunks: DiffHunk[], isBase: boolean): vscode.Range[] {
	const ranges: vscode.Range[] = [];

	for (let i = 0; i < diffHunks.length; i++) {
		let diffHunk = diffHunks[i];
		let startingLine: number;
		let length: number;
		if (isBase) {
			startingLine = getZeroBased(diffHunk.oldLineNumber);
			length = getZeroBased(diffHunk.oldLength);

		} else {
			startingLine = getZeroBased(diffHunk.newLineNumber);
			length = getZeroBased(diffHunk.newLength);
		}

		ranges.push(new vscode.Range(startingLine, 0, startingLine + length, 0));
	}

	return ranges;
}

function commentsEditedInThread(oldComments: vscode.Comment[], newComments: vscode.Comment[]): boolean {
	return oldComments.some(oldComment => {
		const matchingComment = newComments.filter(newComment => newComment.commentId === oldComment.commentId);
		if (matchingComment.length !== 1) {
			return true;
		}

		if (matchingComment[0].body.value !== oldComment.body.value) {
			return true;
		}

		if (!matchingComment[0].commentReactions && !oldComment.commentReactions) {
			// no comment reactions
			return false;
		}

		if (!matchingComment[0].commentReactions || !oldComment.commentReactions) {
			return true;
		}

		if (matchingComment[0].commentReactions!.length !== oldComment.commentReactions!.length) {
			return true;
		}

		for (let i = 0; i < matchingComment[0].commentReactions!.length; i++) {
			if (matchingComment[0].commentReactions![i].label !== oldComment.commentReactions![i].label ||
				matchingComment[0].commentReactions![i].hasReacted !== oldComment.commentReactions![i].hasReacted) {
				return true;
			}
		}

		return false;
	});
}

export class PRNode extends TreeNode implements CommentHandler, vscode.CommentingRangeProvider, vscode.EmptyCommentThreadFactory, vscode.CommentReactionProvider {
	static ID = 'PRNode';
	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[];
	private _commentController?: vscode.CommentController;
	private _prDocumentCommentProvider?: vscode.Disposable & { commentThreadCache: { [key: string]: vscode.CommentThread[] } };

	public get commentController(): vscode.CommentController | undefined {
		return this._commentController;
	}

	private _disposables: vscode.Disposable[] = [];

	private _inMemPRContentProvider?: vscode.Disposable;

	private _command: vscode.Command;

	public get command():vscode.Command {
		return this._command;
	}

	public availableReactions: vscode.CommentReaction[] = getReactionGroup();

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

		this._fileChanges = [];
	}

	// #region Tree
	async getChildren(): Promise<TreeNode[]> {
		Logger.debug(`Fetch children of PRNode #${this.pullRequestModel.prNumber}`, PRNode.ID);
		try {
			if (this.childrenDisposables && this.childrenDisposables.length) {
				this.childrenDisposables.forEach(dp => dp.dispose());
			}

			const comments = await this._prManager.getPullRequestComments(this.pullRequestModel);
			const data = await this._prManager.getPullRequestFileChangesInfo(this.pullRequestModel);
			const mergeBase = this.pullRequestModel.mergeBase;
			if (!mergeBase) {
				return [];
			}

			const rawChanges = await parseDiff(data, this._prManager.repository, mergeBase);
			let fileChanges = rawChanges.map(change => {
				if (change instanceof SlimFileChange) {
					return new RemoteFileChangeNode(
						this,
						this.pullRequestModel,
						change.status,
						change.fileName,
						change.blobUrl
					);
				}

				const headCommit = this.pullRequestModel.head.sha;
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
					change.diffHunks
				);
				changedItem.update(comments.filter(comment => comment.path === change.fileName && comment.position !== null));

				return changedItem;
			});

			if (!this._inMemPRContentProvider) {
				this._inMemPRContentProvider = getInMemPRContentProvider().registerTextDocumentContentProvider(this.pullRequestModel.prNumber, this.provideDocumentContent.bind(this));
			}

			// The review manager will register a document comment's provider, so the node does not need to
			if (!this.pullRequestModel.equals(this._prManager.activePullRequest)) {
				if (!this._prDocumentCommentProvider || !this._commentController) {
					await this.pullRequestModel.githubRepository.ensureCommentsProvider();
					this._commentController = this.pullRequestModel.githubRepository.commentsController!;
					this._prDocumentCommentProvider = this.pullRequestModel.githubRepository.commentsProvider!.registerDocumentCommentProvider(this.pullRequestModel.prNumber, this);

					this._disposables.push(this.pullRequestModel.onDidChangeDraftMode(newDraftMode => {
						for (let fileName in this._prDocumentCommentProvider!.commentThreadCache) {
							this._prDocumentCommentProvider!.commentThreadCache[fileName].forEach(thread => {
								let commands = getCommentThreadCommands(thread, newDraftMode, this, this.pullRequestModel.githubRepository.supportsGraphQl);
								thread.acceptInputCommand = commands.acceptInputCommand;
								thread.additionalCommands = commands.additionalCommands;
							});
						}
					}));
				}

				await this.updateComments(fileChanges, comments);
				this._fileChanges = fileChanges;
			} else {
				await this.pullRequestModel.githubRepository.ensureCommentsProvider();
				this.pullRequestModel.githubRepository.commentsProvider!.clearCommentThreadCache(this.pullRequestModel.prNumber);
				this._fileChanges = fileChanges;
			}

			let result = [new DescriptionNode(this, 'Description', {
				light: Resource.icons.light.Description,
				dark: Resource.icons.dark.Description
			}, this.pullRequestModel), ...this._fileChanges];

			this.childrenDisposables = result;
			return result;
		} catch (e) {
			Logger.appendLine(e);
			return [];
		}
	}

	async revealComment(comment: Comment) {
		let fileChange = this._fileChanges.find(fc => {
			if (fc.fileName !== comment.path) {
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
		} = this.pullRequestModel;

		const {
			login,
		} = author;

		const labelPrefix = (currentBranchIsForThisPR ? '✓ ' : '');
		const tooltipPrefix = (currentBranchIsForThisPR ? 'Current Branch * ' : '');
		const formattedPRNumber = prNumber.toString();
		const label = `${labelPrefix}${title}`;
		const tooltip = `${tooltipPrefix}${title} (#${formattedPRNumber}) by @${login}`;
		const description = `#${formattedPRNumber} by @${login}`;

		return {
			label,
			tooltip,
			description,
			collapsibleState: 1,
			contextValue: 'pullrequest' + (this._isLocal ? ':local' : '') + (currentBranchIsForThisPR ? ':active' : ':nonactive'),
			iconPath: this.pullRequestModel.userAvatarUri
		};
	}

	// #endregion

	// #region New Comment Thread
	async createEmptyCommentThread(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
		if (await this._prManager.authenticate()) {
			const inDraftMode = await this._prManager.inDraftMode(this.pullRequestModel);
			let thread = this._commentController!.createCommentThread('', document.uri, range, []);
			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
			let commands = getEmptyCommentThreadCommands(thread, inDraftMode, this, this.pullRequestModel.githubRepository.supportsGraphQl);

			thread.acceptInputCommand = commands.acceptInputCommand;
			thread.additionalCommands = commands.additionalCommands;
			updateCommentThreadLabel(thread);
		}
	}

	private async updateCommentThreadRoot(thread: vscode.CommentThread, text: string): Promise<void> {
		try {
			let uri = thread.resource;
			let params = fromPRUri(uri);

			if (params && params.prNumber !== this.pullRequestModel.prNumber) {
				return;
			}

			const fileChange = this._fileChanges.find(change => change.fileName === params!.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return;
			}

			let isBase = !!(params && params.isBase);
			let position = mapHeadLineToDiffHunkPosition(fileChange.diffHunks, '', thread.range.start.line + 1, isBase);

			if (position < 0) {
				throw new Error('Comment position cannot be negative');
			}

			// there is no thread Id, which means it's a new thread
			const rawComment = await this._prManager.createComment(this.pullRequestModel, text, params!.fileName, position);
			const comment = convertToVSCodeComment(rawComment!, undefined);
			thread.comments = [comment];
			updateCommentThreadLabel(thread);

			const inDraftMode = await this._prManager.inDraftMode(this.pullRequestModel);
			const commands = getCommentThreadCommands(thread, inDraftMode, this, this.pullRequestModel.githubRepository.supportsGraphQl);

			thread.acceptInputCommand = commands.acceptInputCommand;
			thread.additionalCommands = commands.additionalCommands;
		} catch (e) {
			Logger.appendLine(e);
		}
	}

	async provideCommentingRanges(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.Range[] | undefined> {
		if (document.uri.scheme === 'pr') {
			const params = fromPRUri(document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.prNumber) {
				return;
			}

			const fileChange = this._fileChanges.find(change => change.fileName === params.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return;
			}

			const commentingRanges = fileChange.isPartial ? [new vscode.Range(0, 0, 0, 0)] : getCommentingRanges(fileChange.diffHunks, params.isBase);

			return commentingRanges;
		}
	}

	// #endregion

	// #region Helper
	createCommentThread(fileName: string, commentThreads: vscode.CommentThread[], inDraftMode: boolean) {
		let threads: vscode.CommentThread[] = [];
		commentThreads.forEach(thread => {
			threads.push(createVSCodeCommentThread(thread, this._commentController! , this.pullRequestModel, inDraftMode, this));
		});

		this._prDocumentCommentProvider!.commentThreadCache[fileName] = threads;
	}

	// #endregion

	// #region Incremental updates
	private async updateComments(fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[], comments: Comment[]): Promise<void> {
		const inDraftMode = await this._prManager.inDraftMode(this.pullRequestModel);

		for (let i = 0; i < this._fileChanges.length; i++) {
			let oldFileChange = this._fileChanges[i];
			if (oldFileChange instanceof RemoteFileChangeNode) {
				continue;
			}
			let newFileChange: InMemFileChangeNode;
			let newFileChanges = fileChanges.filter(fileChange => fileChange instanceof InMemFileChangeNode).filter(fileChange => fileChange.fileName === oldFileChange.fileName);
			if (newFileChanges && newFileChanges.length) {
				newFileChange = newFileChanges[0] as InMemFileChangeNode;
			} else {
				continue;
			}

			let newComments = comments.filter(comment => comment.path === newFileChange.fileName && comment.position !== null);

			let oldLeftSideCommentThreads = this._prDocumentCommentProvider!.commentThreadCache[oldFileChange.fileName].filter(thread => thread.resource.toString() === (oldFileChange as InMemFileChangeNode).parentFilePath.toString());
			let newLeftSideCommentThreads = provideDocumentComments(newFileChange.parentFilePath, true, newFileChange, newComments);

			this.updateFileChangeCommentThreads(oldLeftSideCommentThreads, newLeftSideCommentThreads ? newLeftSideCommentThreads.threads : [], newFileChange, inDraftMode);

			let oldRightSideCommentThreads = this._prDocumentCommentProvider!.commentThreadCache[oldFileChange.fileName].filter(thread => thread.resource.toString() === (oldFileChange as InMemFileChangeNode).filePath.toString());
			let newRightSideCommentThreads = provideDocumentComments(newFileChange.filePath, false, newFileChange, newComments);

			this.updateFileChangeCommentThreads(oldRightSideCommentThreads, newRightSideCommentThreads ? newRightSideCommentThreads.threads : [], newFileChange, inDraftMode);
		}

		for (let i = 0; i < fileChanges.length; i++) {
			let newFileChange = fileChanges[i];
			if (newFileChange instanceof RemoteFileChangeNode) {
				continue;
			}

			let oldFileChanges = this._fileChanges.filter(fileChange => fileChange instanceof InMemFileChangeNode).filter(fileChange => fileChange.fileName === newFileChange.fileName);

			if (oldFileChanges.length) {
				continue;
			}

			let leftComments = provideDocumentComments(newFileChange.parentFilePath, true, newFileChange, comments.filter(comment => comment.path === newFileChange.fileName && comment.position !== null));
			let rightComments = provideDocumentComments(newFileChange.filePath, false, newFileChange, comments.filter(comment => comment.path === newFileChange.fileName && comment.position !== null));

			if (this._prDocumentCommentProvider!.commentThreadCache[newFileChange.fileName]) {
				this.updateFileChangeCommentThreads(this._prDocumentCommentProvider!.commentThreadCache[newFileChange.fileName], [...(leftComments ? leftComments.threads : []), ...(rightComments ? rightComments.threads : [])], newFileChange, inDraftMode);
			} else {
				this.createCommentThread(
					newFileChange.fileName,
					[...(leftComments ? leftComments.threads : []), ...(rightComments ? rightComments.threads : [])],
					inDraftMode
				);
			}
		}

		return;
	}

	private updateFileChangeCommentThreads(oldCommentThreads: vscode.CommentThread[], newCommentThreads: vscode.CommentThread[], newFileChange: InMemFileChangeNode, inDraftMode: boolean) {
		// remove
		oldCommentThreads.forEach(thread => {
			// No current threads match old thread, it has been removed
			const matchingThreads = newCommentThreads && newCommentThreads.filter(newThread => newThread.threadId === thread.threadId);
			if (!matchingThreads.length) {
				thread.dispose!();
			}
		});

		if (newCommentThreads && newCommentThreads.length) {
			let added: vscode.CommentThread[] = [];
			newCommentThreads.forEach(thread => {
				const matchingCommentThread = oldCommentThreads.filter(oldComment => oldComment.threadId === thread.threadId);

				if (matchingCommentThread.length === 0) {
					added.push(thread);
					if (thread.resource.scheme === 'file') {
						thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
					}
				}

				matchingCommentThread.forEach(match => {
					if (match.comments.length !== thread.comments.length || commentsEditedInThread(matchingCommentThread[0].comments, thread.comments)) {
						match.comments = thread.comments;
						updateCommentThreadLabel(match);
					}
				});
			});

			if (added.length) {
				this.createCommentThread(newFileChange.fileName, added, inDraftMode);
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

		let fileChanges = this._fileChanges.filter(contentChange => (contentChange instanceof InMemFileChangeNode) && contentChange.fileName === params!.fileName);
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
	public async createOrReplyComment(thread: vscode.CommentThread) {
		if (await this._prManager.authenticate() && this.commentController!.inputBox !== undefined) {
			if (thread.comments.length) {
				let comment = thread.comments[0] as (vscode.Comment & { _rawComment: Comment });
				const rawComment = await this._prManager.createCommentReply(this.pullRequestModel, this.commentController!.inputBox!.value, comment._rawComment);

				thread.comments = [...thread.comments, convertToVSCodeComment(rawComment!, undefined)];
				updateCommentThreadLabel(thread);
				this.commentController!.inputBox!.value = '';
			} else {
				// create new comment thread
				let input = this.commentController!.inputBox!.value;
				await this.updateCommentThreadRoot(thread, input);
				this.commentController!.inputBox!.value = '';
			}
		}
	}

	public async editComment(thread: vscode.CommentThread, comment: vscode.Comment): Promise<void> {
		if (await this._prManager.authenticate() && this._commentController!.inputBox) {
			const existingComment = (comment as (vscode.Comment & { _rawComment: Comment }))._rawComment;
			if (!existingComment) {
				throw new Error('Unable to find comment');
			}

			const rawComment = await this._prManager.editReviewComment(this.pullRequestModel, existingComment, this._commentController!.inputBox!.value);
			const vscodeComment = convertToVSCodeComment(rawComment, undefined);

			let newComments = thread.comments.map(cmt => {
				if (cmt.commentId === vscodeComment.commentId) {
					vscodeComment.editCommand = getEditCommand(thread, vscodeComment, this);
					vscodeComment.deleteCommand = getDeleteCommand(thread, vscodeComment, this);
					return vscodeComment;
				}

				return cmt;
			});
			thread.comments = newComments;
			updateCommentThreadLabel(thread);
		}
	}

	public async deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): Promise<void> {
		await this._prManager.deleteReviewComment(this.pullRequestModel, comment.commentId);
		const index = thread.comments.findIndex(c => c.commentId === comment.commentId);
		if (index > -1) {
			thread.comments.splice(index, 1);
			thread.comments = thread.comments;
			updateCommentThreadLabel(thread);
		}

		let inDraftMode = await this._prManager.inDraftMode(this.pullRequestModel);
		if (inDraftMode !== this.pullRequestModel.inDraftMode) {
			this.pullRequestModel.inDraftMode = inDraftMode;
		}
	}
	// #endregion

	// #region Review
	public async startReview(thread: vscode.CommentThread): Promise<void> {
		await this._prManager.startReview(this.pullRequestModel);

		if (thread.comments.length) {
			let comment = thread.comments[0] as (vscode.Comment & { _rawComment: Comment });
			const rawComment = await this._prManager.createCommentReply(this.pullRequestModel, this.commentController!.inputBox ? this.commentController!.inputBox!.value : '', comment._rawComment);

			thread.comments = [...thread.comments, convertToVSCodeComment(rawComment!, undefined)];
			updateCommentThreadLabel(thread);
		} else {
			// create new comment thread

			if (this.commentController!.inputBox && this.commentController!.inputBox!.value) {
				await this.updateCommentThreadRoot(thread, this.commentController!.inputBox!.value);
			}
		}

		if (this.commentController!.inputBox) {
			this.commentController!.inputBox!.value = '';
		}
	}

	public async finishReview(thread: vscode.CommentThread): Promise<void> {
		try {
			if (this.commentController && this.commentController!.inputBox) {
				let comment = thread.comments[0] as (vscode.Comment & { _rawComment: Comment });
				const rawComment = await this._prManager.createCommentReply(this.pullRequestModel, this.commentController!.inputBox!.value, comment._rawComment);

				thread.comments = [...thread.comments, convertToVSCodeComment(rawComment!, undefined)];
				updateCommentThreadLabel(thread);
				this.commentController!.inputBox!.value = '';
			}

			await this._prManager.submitReview(this.pullRequestModel);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to submit the review: ${e}`);
		}
	}

	public async deleteReview(): Promise<void> {
		const { deletedReviewComments } = await this._prManager.deleteReview(this.pullRequestModel);

		// Group comments by file and then position to create threads.
		const commentsByPath = groupBy(deletedReviewComments, comment => comment.path || '');

		for (let filePath in commentsByPath) {
			const matchingFileChange = this._fileChanges.find(fileChange => fileChange.fileName === filePath);

			if (matchingFileChange && matchingFileChange instanceof InMemFileChangeNode) {
				if (this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName]) {
					let threads: vscode.CommentThread[] = [];

					this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName].forEach(thread => {
						thread.comments = thread.comments.filter(comment => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId));
						updateCommentThreadLabel(thread);
						if (!thread.comments.length) {
							thread.dispose!();
						} else {
							threads.push(thread);
						}
					});

					if (threads.length) {
						this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName] = threads;
					} else {
						delete this._prDocumentCommentProvider!.commentThreadCache[matchingFileChange.fileName];
					}
				}
			}
		}
	}

	// #endregion

	// #region Reaction
	async toggleReaction(document: vscode.TextDocument, comment: vscode.Comment, reaction: vscode.CommentReaction): Promise<void> {
		if (document.uri.scheme !== 'pr') {
			return;
		}

		const params = fromPRUri(document.uri);

		if (!params) {
			return;
		}

		if (comment.commentReactions && !comment.commentReactions.find(ret => ret.label === reaction.label)) {
			// add reaction
			const matchedRawComment = (comment as (vscode.Comment & { _rawComment: Comment }))._rawComment;
			let result = await this._prManager.addCommentReaction(this.pullRequestModel, matchedRawComment.graphNodeId, reaction);
			let reactionGroups = result.addReaction.subject.reactionGroups;
			comment.commentReactions = parseGraphQLReaction(reactionGroups).map(ret => {
				return { label: ret.label, hasReacted: ret.viewerHasReacted, count: ret.count, iconPath: ret.icon };
			});
		} else {
			const matchedRawComment = (comment as (vscode.Comment & { _rawComment: Comment }))._rawComment;
			let result = await this._prManager.deleteCommentReaction(this.pullRequestModel, matchedRawComment.graphNodeId, reaction);
			let reactionGroups = result.removeReaction.subject.reactionGroups;
			comment.commentReactions = parseGraphQLReaction(reactionGroups).map(ret => {
				return { label: ret.label, hasReacted: ret.viewerHasReacted, count: ret.count, iconPath: ret.icon };
			});
		}

		if (this._prDocumentCommentProvider!.commentThreadCache[params.fileName]) {
			this._prDocumentCommentProvider!.commentThreadCache[params.fileName].forEach(thread => {
				if (!thread.comments) {
					return;
				}

				if (thread.comments.find(cmt => cmt.commentId === comment.commentId)) {
					thread.comments = thread.comments.map(cmt => {
						if (cmt.commentId === comment.commentId) {
							cmt.commentReactions = comment.commentReactions;
						}

						return cmt;
					});
					updateCommentThreadLabel(thread);
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

		if (this._prDocumentCommentProvider) {
			this._prDocumentCommentProvider.dispose();
		}

		this._commentController = undefined;

		this._disposables.forEach(d => d.dispose());
	}
}
