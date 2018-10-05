/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { parseDiff, getModifiedContentFromDiffHunk, DiffChangeType } from '../../common/diffHunk';
import { mapHeadLineToDiffHunkPosition, getZeroBased, getAbsolutePosition, getPositionInDiff } from '../../common/diffPositionMapping';
import { SlimFileChange, GitChangeType } from '../../common/file';
import Logger from '../../common/logger';
import { Resource } from '../../common/resources';
import { fromPRUri, toPRUri } from '../../common/uri';
import { groupBy, formatError } from '../../common/utils';
import { IPullRequestManager, IPullRequestModel } from '../../github/interface';
import { DescriptionNode } from './descriptionNode';
import { RemoteFileChangeNode, InMemFileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';
import { getInMemPRContentProvider } from '../inMemPRContentProvider';
import { Comment } from '../../common/comment';
import { getPRDocumentCommentProvider } from '../prDocumentCommentProvider';

export function providePRDocumentComments(
	document: vscode.TextDocument,
	prNumber: number,
	fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[]) {
	const params = fromPRUri(document.uri);

	if (params.prNumber !== prNumber) {
		return null;
	}

	const isBase = params.base;
	const fileChange = fileChanges.find(change => change.fileName === params.fileName);
	if (!fileChange) {
		return null;
	}

	if (fileChange instanceof RemoteFileChangeNode) {
		return null;
	}

	let commentingRanges: vscode.Range[] = [];
	// Partial file change indicates that the file content is only the diff, so the entire
	// document can be commented on.
	if (fileChange.isPartial) {
		commentingRanges.push(new vscode.Range(0, 0, document.lineCount, 0));
	} else {
		const diffHunks = fileChange.diffHunks;

		for (let i = 0; i < diffHunks.length; i++) {
			const diffHunk = diffHunks[i];
			let startingLine: number;
			let length: number;
			if (isBase) {
				startingLine = getZeroBased(diffHunk.oldLineNumber);
				length = getZeroBased(diffHunk.oldLength);
			} else {
				startingLine = getZeroBased(diffHunk.newLineNumber);
				length = getZeroBased(diffHunk.newLength);
			}

			commentingRanges.push(new vscode.Range(startingLine, 0, startingLine + length, 0));
		}
	}

	const matchingComments = fileChange.comments;
	if (!matchingComments || !matchingComments.length) {
		return {
			threads: [],
			commentingRanges,
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
			threadId: firstComment.id,
			resource: document.uri,
			range,
			comments: comments.map(comment => {
				return {
					commentId: comment.id,
					body: new vscode.MarkdownString(comment.body),
					userName: comment.user.login,
					gravatar: comment.user.avatar_url
				};
			}),
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
		});
	}

	return {
		threads,
		commentingRanges,
	};
}

function commentsToCommentThreads(fileChange: InMemFileChangeNode, comments: Comment[], isBase: boolean) {
	let sections = groupBy(comments, comment => String(comment.position));
	let threads: vscode.CommentThread[] = [];

	for (let i in sections) {
		let commentGroup = sections[i];

		const firstComment = commentGroup[0];
		let commentAbsolutePosition = fileChange.isPartial
			? getPositionInDiff(firstComment, fileChange.diffHunks, isBase)
			: getAbsolutePosition(firstComment, fileChange.diffHunks, isBase);

		if (commentAbsolutePosition < 0) {
			continue;
		}

		const pos = new vscode.Position(getZeroBased(commentAbsolutePosition), 0);
		const range = new vscode.Range(pos, pos);

		threads.push({
			threadId: firstComment.id,
			resource: isBase ? fileChange.parentFilePath : fileChange.filePath,
			range,
			comments: commentGroup.map(comment => {
				return {
					commentId: comment.id,
					body: new vscode.MarkdownString(comment.body),
					userName: comment.user.login,
					gravatar: comment.user.avatar_url
				};
			}),
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
		});
	}

	return threads;
}

function getRemovedCommentThreads(oldCommentThreads: vscode.CommentThread[], newCommentThreads: vscode.CommentThread[]) {
	let removed: vscode.CommentThread[] = [];
	oldCommentThreads.forEach(thread => {
		// No current threads match old thread, it has been removed
		const matchingThreads = newCommentThreads.filter(newThread => newThread.threadId === thread.threadId);
		if (matchingThreads.length === 0) {
			removed.push(thread);
		}
	});

	return removed;
}

function getAddedOrUpdatedCommentThreads(oldCommentThreads: vscode.CommentThread[], newCommentThreads: vscode.CommentThread[]) {
	let added: vscode.CommentThread[] = [];
	let changed: vscode.CommentThread[] = [];

	function commentsEditedInThread(oldComments: vscode.Comment[], newComments: vscode.Comment[]): boolean {
		return oldComments.some(oldComment => {
			const matchingComment = newComments.filter(newComment => newComment.commentId === oldComment.commentId);
			if (matchingComment.length !== 1) {
				return true;
			}

			if (matchingComment[0].body.value !== oldComment.body.value) {
				return true;
			}

			return false;
		});
	}

	newCommentThreads.forEach(thread => {
		const matchingCommentThread = oldCommentThreads.filter(oldComment => oldComment.threadId === thread.threadId);

		// No old threads match this thread, it is new
		if (matchingCommentThread.length === 0) {
			added.push(thread);
			if (thread.resource.scheme === 'file') {
				thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
			}
		}

		// Check if comment has been updated
		matchingCommentThread.forEach(match => {
			if (match.comments.length !== thread.comments.length || commentsEditedInThread(matchingCommentThread[0].comments, thread.comments)) {
				changed.push(thread);
			}
		});
	});

	return [added, changed];
}

export class PRNode extends TreeNode {
	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[];
	private _documentCommentsProvider: vscode.Disposable;
	private _onDidChangeCommentThreads: vscode.EventEmitter<vscode.CommentThreadChangedEvent>;

	private _inMemPRContentProvider: vscode.Disposable;

	constructor(
		private _prManager: IPullRequestManager,
		public pullRequestModel: IPullRequestModel,
		private _isLocal: boolean
	) {
		super();
		this._documentCommentsProvider = null;
		this._inMemPRContentProvider = null;
		this._onDidChangeCommentThreads = null;
	}

	async getChildren(): Promise<TreeNode[]> {
		try {
			if (this.childrenDisposables && this.childrenDisposables.length) {
				this.childrenDisposables.forEach(dp => dp.dispose());
			}

			const comments = await this._prManager.getPullRequestComments(this.pullRequestModel);
			const data = await this._prManager.getPullRequestChangedFiles(this.pullRequestModel);
			await this._prManager.fullfillPullRequestMissingInfo(this.pullRequestModel);
			let mergeBase = this.pullRequestModel.mergeBase;
			const rawChanges = await parseDiff(data, this._prManager.repository, mergeBase);
			let fileChanges = rawChanges.map(change => {
				if (change instanceof SlimFileChange) {
					return new RemoteFileChangeNode(
						this.pullRequestModel,
						change.status,
						change.fileName,
						change.blobUrl
					);
				}

				let changedItem = new InMemFileChangeNode(
					this.pullRequestModel,
					change.status,
					change.fileName,
					change.previousFileName,
					change.blobUrl,
					toPRUri(vscode.Uri.file(change.fileName), this.pullRequestModel, change.baseCommit, change.fileName, false),
					toPRUri(vscode.Uri.file(change.fileName), this.pullRequestModel, change.baseCommit, change.fileName, true),
					change.isPartial,
					change.patch,
					change.diffHunks,
					comments.filter(comment => comment.path === change.fileName && comment.position !== null),
				);

				return changedItem;
			});

			if (!this._inMemPRContentProvider) {
				this._inMemPRContentProvider = getInMemPRContentProvider().registerTextDocumentContentProvider(this.pullRequestModel.prNumber, this.provideDocumentContent.bind(this));
			}

			// The review manager will register a document comment's provider, so the node does not need to
			if (!this.pullRequestModel.equals(this._prManager.activePullRequest)) {
				if (this._documentCommentsProvider) {
					// diff comments
					await this.updateComments(comments, fileChanges);
					this._fileChanges = fileChanges;
				} else {
					this._fileChanges = fileChanges;
					this._onDidChangeCommentThreads = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();
					this._documentCommentsProvider = getPRDocumentCommentProvider().registerDocumentCommentProvider(this.pullRequestModel, {
						onDidChangeCommentThreads: this._onDidChangeCommentThreads.event,
						provideDocumentComments: this.provideDocumentComments.bind(this),
						createNewCommentThread: this.createNewCommentThread.bind(this),
						replyToCommentThread: this.replyToCommentThread.bind(this)
					});
				}
			} else {
				this._fileChanges = fileChanges;
			}

			let result = [new DescriptionNode('Description', {
				light: Resource.icons.light.Description,
				dark: Resource.icons.dark.Description
			}, this.pullRequestModel), ...this._fileChanges];

			this.childrenDisposables = result;
			return result;
		} catch (e) {
			Logger.appendLine(e);
		}
	}

	getTreeItem(): vscode.TreeItem {
		let currentBranchIsForThisPR = this.pullRequestModel.equals(this._prManager.activePullRequest);
		return {
			label: (currentBranchIsForThisPR ? '✓ ' : '') + this.pullRequestModel.title + ' (#' + this.pullRequestModel.prNumber.toString() + ')',
			tooltip: (currentBranchIsForThisPR ? 'Current Branch * ' : '') + this.pullRequestModel.title + ' (#' + this.pullRequestModel.prNumber.toString() + ')',
			collapsibleState: 1,
			contextValue: 'pullrequest' + (this._isLocal ? ':local' : '') + (currentBranchIsForThisPR ? ':active' : ':nonactive'),
			iconPath: this.pullRequestModel.userAvatarUri
		};
	}

	private async updateComments(comments: Comment[], fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[]): Promise<void> {
		let added: vscode.CommentThread[] = [];
		let removed: vscode.CommentThread[] = [];
		let changed: vscode.CommentThread[] = [];

		for (let i = 0; i < this._fileChanges.length; i++) {
			let oldFileChange = this._fileChanges[i];
			if (oldFileChange instanceof RemoteFileChangeNode) {
				continue;
			}
			let newFileChange;
			let newFileChanges = fileChanges.filter(fileChange => fileChange instanceof InMemFileChangeNode).filter(fileChange => fileChange.fileName === oldFileChange.fileName);
			if (newFileChanges && newFileChanges.length) {
				newFileChange = newFileChanges[0];
			} else {
				continue;
			}

			let oldLeftSideCommentThreads = commentsToCommentThreads(oldFileChange, oldFileChange.comments, true);
			let newLeftSideCommentThreads = commentsToCommentThreads(newFileChange, newFileChange.comments, true);

			removed.push(...getRemovedCommentThreads(oldLeftSideCommentThreads, newLeftSideCommentThreads));
			let leftSideAddedOrUpdated = getAddedOrUpdatedCommentThreads(oldLeftSideCommentThreads, newLeftSideCommentThreads);
			added.push(...leftSideAddedOrUpdated[0]);
			changed.push(...leftSideAddedOrUpdated[1]);

			let oldRightSideCommentThreads = commentsToCommentThreads(oldFileChange, oldFileChange.comments, false);
			let newRightSideCommentThreads = commentsToCommentThreads(newFileChange, newFileChange.comments, false);

			removed.push(...getRemovedCommentThreads(oldRightSideCommentThreads, newRightSideCommentThreads));
			let rightSideAddedOrUpdated = getAddedOrUpdatedCommentThreads(oldRightSideCommentThreads, newRightSideCommentThreads);
			added.push(...rightSideAddedOrUpdated[0]);
			changed.push(...rightSideAddedOrUpdated[1]);
		}

		if (added.length || removed.length || changed.length) {
			this._onDidChangeCommentThreads.fire({
				added: added,
				removed: removed,
				changed: changed
			});
			// this._onDidChangeDecorations.fire();
		}

		return Promise.resolve(null);
	}

	private async provideDocumentContent(uri: vscode.Uri): Promise<string> {
		let params = fromPRUri(uri);
		let fileChanges = this._fileChanges.filter(contentChange => (contentChange instanceof InMemFileChangeNode) && contentChange.fileName === params.fileName);
		if (fileChanges.length) {
			let fileChange = fileChanges[0] as InMemFileChangeNode;
			let readContentFromDiffHunk = fileChange.isPartial || fileChange.status === GitChangeType.ADD || fileChange.status === GitChangeType.DELETE;

			if (readContentFromDiffHunk) {
				if (params.base) {
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
				const originalFilePath = path.join(this._prManager.repository.rootUri.fsPath, originalFileName);
				const originalContent = await this._prManager.repository.show(params.commit, originalFilePath);

				if (params.base) {
					return originalContent;
				} else {
					return getModifiedContentFromDiffHunk(originalContent, fileChange.patch);
				}
			}
		}
		Logger.appendLine(`PR> can not find content for document ${uri.toString()}`);
		return '';
	}

	private async createNewCommentThread(document: vscode.TextDocument, range: vscode.Range, text: string) {
		try {
			let uri = document.uri;
			let params = fromPRUri(uri);

			if (params.prNumber !== this.pullRequestModel.prNumber) {
				return null;
			}

			let fileChange = this._fileChanges.find(change => change.fileName === params.fileName);

			if (!fileChange) {
				throw new Error('No matching file found');
			}

			if (fileChange instanceof RemoteFileChangeNode) {
				throw new Error('Cannot add comment to this file');
			}

			let isBase = params && params.base;
			let position = mapHeadLineToDiffHunkPosition(fileChange.diffHunks, '', range.start.line + 1, isBase);

			if (position < 0) {
				throw new Error('Comment position cannot be negative');
			}

			// there is no thread Id, which means it's a new thread
			let rawComment = await this._prManager.createComment(this.pullRequestModel, text, params.fileName, position);
			let comment: vscode.Comment = {
				commentId: rawComment.id,
				body: new vscode.MarkdownString(rawComment.body),
				userName: rawComment.user.login,
				gravatar: rawComment.user.avatar_url
			};

			fileChange.comments.push(rawComment);

			let commentThread: vscode.CommentThread = {
				threadId: comment.commentId,
				resource: uri,
				range: range,
				comments: [comment]
			};

			return commentThread;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	private async replyToCommentThread(document: vscode.TextDocument, _range: vscode.Range, thread: vscode.CommentThread, text: string) {
		try {
			const uri = document.uri;
			const params = JSON.parse(uri.query);
			const fileChange = this._fileChanges.find(change => change.fileName === params.fileName);

			if (!fileChange) {
				throw new Error('No matching file found');
			}

			if (fileChange instanceof RemoteFileChangeNode) {
				throw new Error('Cannot add comment to this file');
			}

			const rawComment = await this._prManager.createCommentReply(this.pullRequestModel, text, thread.threadId);
			thread.comments.push({
				commentId: rawComment.id,
				body: new vscode.MarkdownString(rawComment.body),
				userName: rawComment.user.login,
				gravatar: rawComment.user.avatar_url
			});

			fileChange.comments.push(rawComment);

			return thread;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	private async provideDocumentComments(document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<vscode.CommentInfo> {
		if (document.uri.scheme === 'pr') {
			return providePRDocumentComments(document, this.pullRequestModel.prNumber, this._fileChanges);
		}

		return null;
	}

	dispose(): void {
		super.dispose();

		if (this._documentCommentsProvider) {
			this._documentCommentsProvider.dispose();
		}

		if (this._inMemPRContentProvider) {
			this._inMemPRContentProvider.dispose();
		}
	}
}