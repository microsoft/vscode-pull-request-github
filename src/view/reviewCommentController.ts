/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import * as vscode from 'vscode';
import { IComment } from '../common/comment';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../github/prComment';
import { getAbsolutePosition, getLastDiffLine, mapCommentsToHead, mapOldPositionToNew, getDiffLineByPosition, getZeroBased, mapHeadLineToDiffHunkPosition } from '../common/diffPositionMapping';
import { fromPRUri, fromReviewUri, ReviewUriParams } from '../common/uri';
import { formatError, groupBy } from '../common/utils';
import { Repository } from '../api/api';
import { PullRequestManager } from '../github/pullRequestManager';
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { getCommentingRanges, getDocumentThreadDatas, ThreadData } from './treeNodes/pullRequestNode';
import { getReactionGroup, parseGraphQLReaction, createVSCodeCommentThread, updateCommentThreadLabel , updateCommentReviewState } from '../github/utils';
import { ReactionGroup } from '../github/graphql';
import { DiffHunk, DiffChangeType } from '../common/diffHunk';
import { CommentHandler, registerCommentHandler } from '../commentHandlerResolver';

function workspaceLocalCommentsToCommentThreads(repository: Repository, fileChange: GitFileChangeNode, fileComments: IComment[], collapsibleState: vscode.CommentThreadCollapsibleState): ThreadData[] {
	if (!fileChange) {
		return [];
	}

	if (!fileComments || !fileComments.length) {
		return [];
	}

	const ret: ThreadData[] = [];
	const sections = groupBy(fileComments, comment => String(comment.position));

	for (let i in sections) {
		const comments = sections[i];

		const firstComment = comments[0];
		const pos = new vscode.Position(getZeroBased(firstComment.absolutePosition || 0), 0);
		const range = new vscode.Range(pos, pos);

		const newPath = nodePath.join(repository.rootUri.path, firstComment.path!).replace(/\\/g, '/');
		const newUri = repository.rootUri.with({ path: newPath });
		ret.push({
			threadId: firstComment.id.toString(),
			resource: newUri,
			range,
			comments,
			collapsibleState
		});
	}

	return ret;
}

function mapCommentThreadsToHead(diffHunks: DiffHunk[], localDiff: string, commentThreads: vscode.CommentThread[]) {
	commentThreads.forEach(thread => {
		if (thread.comments && thread.comments.length) {
			let comment = thread.comments[0] as vscode.Comment & { _rawComment: IComment };

			const diffLine = getDiffLineByPosition(diffHunks, comment._rawComment.position || comment._rawComment.originalPosition!);
			if (diffLine) {
				const positionInPr = diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber;
				const newPosition = getZeroBased(mapOldPositionToNew(localDiff, positionInPr));
				const range = new vscode.Range(newPosition, 0, newPosition, 0);

				thread.range = range;
			}
		}
	});
}
export class ReviewCommentController implements vscode.Disposable, CommentHandler, vscode.CommentingRangeProvider, vscode.CommentReactionProvider {

	private _localToDispose: vscode.Disposable[] = [];
	private _onDidChangeComments = new vscode.EventEmitter<IComment[]>();
	public onDidChangeComments = this._onDidChangeComments.event;

	public availableReactions = getReactionGroup();

	private _commentController?: vscode.CommentController;

	public get commentController(): vscode.CommentController | undefined {
		return this._commentController;
	}

	private _workspaceFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};
	private _obsoleteFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};
	private _reviewDocumentCommentThreads: { [key: string]: GHPRCommentThread[] } = {};
	private _prDocumentCommentThreads: { [key: string]: { original?: GHPRCommentThread[], modified?: GHPRCommentThread[] }} = {};

	constructor(
		private _prManager: PullRequestManager,
		private _repository: Repository,
		private _localFileChanges: GitFileChangeNode[],
		private _obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
		private _comments: IComment[]) {
		this._commentController = vscode.comments.createCommentController(`review-${_prManager.activePullRequest!.prNumber}`, _prManager.activePullRequest!.title);
		this._commentController.commentingRangeProvider = this;
		this._commentController.reactionProvider = this;
		this._localToDispose.push(this._commentController);
		registerCommentHandler(this);
	}

	// #region initialize
	async initialize(): Promise<void> {
		await this.initializeWorkspaceCommentThreads();
		await this.initializeDocumentCommentThreadsAndListeners();
	}

	async initializeWorkspaceCommentThreads(): Promise<void> {
		const inDraftMode = await this._prManager.validateDraftMode(this._prManager.activePullRequest!);
		this._localFileChanges.forEach(async matchedFile => {
			let matchingComments: IComment[] = [];
			const headCommitSha = this._prManager.activePullRequest!.head.sha;
			let contentDiff = await this._repository.diffWith(headCommitSha, matchedFile.fileName);
			matchingComments = matchedFile.comments;
			matchingComments = mapCommentsToHead(matchedFile.diffHunks, contentDiff, matchingComments);

			let threads = workspaceLocalCommentsToCommentThreads(
				this._repository, matchedFile, matchingComments, vscode.CommentThreadCollapsibleState.Collapsed).map(thread => createVSCodeCommentThread(thread, this._commentController!, inDraftMode));
			this._workspaceFileChangeCommentThreads[matchedFile.fileName] = threads;
		});

		gitFileChangeNodeFilter(this._obsoleteFileChanges).forEach(fileChange => {
			let threads = this.outdatedCommentsToCommentThreads(fileChange, fileChange.comments, vscode.CommentThreadCollapsibleState.Expanded).map(thread => createVSCodeCommentThread(thread, this._commentController!, inDraftMode));
			this._obsoleteFileChangeCommentThreads[fileChange.fileName] = threads;
		});
	}

	async initializeDocumentCommentThreadsAndListeners(): Promise<void> {
		this._localToDispose.push(vscode.window.onDidChangeVisibleTextEditors(async e => {
			// remove comment threads in `pr/reivew` documents if there are no longer visible
			let prEditors = vscode.window.visibleTextEditors.filter(editor => {
				if (editor.document.uri.scheme !== 'pr') {
					return false;
				}

				const params = fromPRUri(editor.document.uri);
				return !!params && params.prNumber === this._prManager.activePullRequest!.prNumber;
			});

			for (let fileName in this._prDocumentCommentThreads) {
				let threads = this._prDocumentCommentThreads[fileName];

				let originalEditor = prEditors.find(editor => {
					const params = fromPRUri(editor.document.uri);
					return !!params && params.fileName === fileName && params.isBase;
				});

				if (!originalEditor && threads.original) {
					threads.original.forEach(thread => thread.dispose!());
					this._prDocumentCommentThreads[fileName].original = undefined;
				}

				let modifiedEditor = prEditors.find(editor => {
					const params = fromPRUri(editor.document.uri);
					return !!params && params.fileName === fileName && !params.isBase;
				});

				if (!modifiedEditor && threads.modified) {
					threads.modified.forEach(thread => thread.dispose!());
					this._prDocumentCommentThreads[fileName].modified = undefined;
				}

				if (!this._prDocumentCommentThreads[fileName].original && !this._prDocumentCommentThreads[fileName].modified) {
					delete this._prDocumentCommentThreads[fileName];
				}
			}

			for (let fileName in this._reviewDocumentCommentThreads) {
				let threads = this._reviewDocumentCommentThreads[fileName];
				let visible = vscode.window.visibleTextEditors.find(editor => {
					if (editor.document.uri.scheme !== 'review' && editor.document.uri.scheme === this._repository.rootUri.scheme && editor.document.uri.query) {
						if (fileName === editor.document.uri.toString()) {
							return true;
						}
					}

					if (editor.document.uri.scheme !== 'review') {
						return false;
					}

					if (fileName === editor.document.uri.toString()) {
						return true;
					}

					return false;
				});

				if (!visible) {
					threads.forEach(thread => thread.dispose!());
					delete this._reviewDocumentCommentThreads[fileName];
				}
			}

			for (let editor of e.filter(ed => ed.document.uri.scheme !== 'comment')) {
				await this.updateCommentThreadsForEditor(editor);
			}
		}));

		this._localToDispose.push(this._prManager.activePullRequest!.onDidChangeDraftMode(newDraftMode => {
			[this._workspaceFileChangeCommentThreads, this._obsoleteFileChangeCommentThreads, this._reviewDocumentCommentThreads].forEach(commentThreadMap => {
				for (let fileName in commentThreadMap) {
					commentThreadMap[fileName].forEach(thread => {
						updateCommentReviewState(thread, newDraftMode);
						updateCommentThreadLabel(thread);
					});
				}
			});

			for (let fileName in this._prDocumentCommentThreads) {
				[...this._prDocumentCommentThreads[fileName].original || [], ...this._prDocumentCommentThreads[fileName].modified || []].forEach(thread => {
					thread.comments = thread.comments.map(comment => {
						comment.label = newDraftMode ? 'Pending' : undefined;
						return comment;
					});
					updateCommentThreadLabel(thread);
				});
			}
		}));
	}

	async updateCommentThreadsForEditor(editor: vscode.TextEditor): Promise<void> {
		if (editor.document.uri.scheme === 'pr') {
			const params = fromPRUri(editor.document.uri);

			if (params && params.prNumber === this._prManager.activePullRequest!.prNumber) {
				if (!this._prDocumentCommentThreads[params.fileName]) {
					this._prDocumentCommentThreads[params.fileName] = {};
				}

				if (params.isBase && this._prDocumentCommentThreads[params.fileName].original) {
					return;
				}

				if (!params.isBase && this._prDocumentCommentThreads[params.fileName].modified) {
					return;
				}

				if (params.isBase) {
					this._prDocumentCommentThreads[params.fileName].original = [];
				} else {
					this._prDocumentCommentThreads[params.fileName].modified = [];
				}

				let matchedFileChanges = this._localFileChanges.filter(localFileChange => localFileChange.fileName === params.fileName);

				if (matchedFileChanges.length) {
					const inDraftMode = await this._prManager.validateDraftMode(this._prManager.activePullRequest!);

					let documentComments = getDocumentThreadDatas(editor.document.uri, params.isBase, matchedFileChanges[0], matchedFileChanges[0].comments);
					let newThreads: GHPRCommentThread[] = [];
					if (documentComments) {
						documentComments.forEach(thread => {
							newThreads.push(createVSCodeCommentThread(thread, this._commentController!, inDraftMode));
						});
					}

					if (params.isBase) {
						this._prDocumentCommentThreads[params.fileName].original = newThreads;
					} else {
						this._prDocumentCommentThreads[params.fileName].modified = newThreads;
					}
				}
			}

			return;
		}

		if (editor.document.uri.scheme !== 'review' && editor.document.uri.scheme === this._repository.rootUri.scheme && !editor.document.uri.query) {
			let fileName = vscode.workspace.asRelativePath(editor.document.uri.path);
			// local files
			let matchedFiles = this._localFileChanges.filter(fileChange => fileChange.fileName === fileName);

			if (matchedFiles && !matchedFiles.length) {
				return;
			}

			let commentThreads = this._workspaceFileChangeCommentThreads[fileName];

			const headCommitSha = this._prManager.activePullRequest!.head.sha;
			let contentDiff = await this.getContentDiff(editor.document, headCommitSha, fileName);
			mapCommentThreadsToHead(matchedFiles[0].diffHunks, contentDiff, commentThreads);
			return;
		}

		let query: ReviewUriParams | undefined;
		let reviewUriString = editor.document.uri.toString();

		if (this._reviewDocumentCommentThreads[reviewUriString]) {
			return;
		}

		this._reviewDocumentCommentThreads[reviewUriString] = [];

		try {
			query = fromReviewUri(editor.document.uri);
		} catch (e) { }

		if (query) {
			const inDraftMode = await this._prManager.validateDraftMode(this._prManager.activePullRequest!);
			let reviewCommentThreads = this.provideCommentsForReviewUri(editor.document, query);

			if (reviewCommentThreads) {
				let newThreads: GHPRCommentThread[] = [];
				reviewCommentThreads.forEach(thread => {
					newThreads.push(createVSCodeCommentThread(thread, this._commentController!, inDraftMode));
				});

				this._reviewDocumentCommentThreads[reviewUriString] = newThreads;
			}
		}
	}

	// #endregion

	hasCommentThread(thread: vscode.CommentThread): boolean {
		if (thread.uri.scheme === 'review') {
			return true;
		}

		if (thread.uri.scheme === 'pr') {
			let params = fromPRUri(thread.uri);
			if (this._prManager.activePullRequest && params && this._prManager.activePullRequest.prNumber === params.prNumber) {
				return true;
			} else {
				return false;
			}
		}

		const currentWorkspace = vscode.workspace.getWorkspaceFolder(thread.uri);
		if (!currentWorkspace) {
			return false;
		}

		if (thread.uri.scheme === currentWorkspace.uri.scheme) {
			return true;
		}

		return false;
	}

	private addToCommentThreadCache(thread: GHPRCommentThread): void {
		const uri = thread.uri;
		switch (uri.scheme) {
			case 'pr':
				const params = fromPRUri(uri);
				if (params) {
					const documentCommentThreads = this._prDocumentCommentThreads[params.fileName];
					if (documentCommentThreads) {
						if (params.isBase && documentCommentThreads.original) {
							documentCommentThreads.original.push(thread);
						} else if (!params.isBase && documentCommentThreads.modified) {
							documentCommentThreads.modified.push(thread);
						}
					}
				}
				return;

			case 'review':
				const fileName = uri.toString();
				const reviewCommentThreads = this._reviewDocumentCommentThreads[fileName];
				if (reviewCommentThreads) {
					reviewCommentThreads.push(thread);
				}
				return;

			default:
				return;
		}
	}

	async provideCommentingRanges(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.Range[] | undefined> {
		if (document.uri.scheme === 'pr') {
			const params = fromPRUri(document.uri);

			if (!params || params.prNumber !== this._prManager.activePullRequest!.prNumber) {
				return;
			}

			const fileChange = this._localFileChanges.find(change => change.fileName === params.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return;
			}

			const commentingRanges = fileChange.isPartial ? [new vscode.Range(0, 0, 0, 0)] : getCommentingRanges(fileChange.diffHunks, params.isBase);

			return commentingRanges;
		}

		let query: ReviewUriParams | undefined;

		try {
			query = fromReviewUri(document.uri);
		} catch (e) { }

		if (query) {
			const matchedFile = this.findMatchedFileChangeForReviewDiffView(this._localFileChanges, document.uri);

			if (matchedFile) {
				const matchingComments = matchedFile.comments;
				const isBase = query.base;
				matchingComments.forEach(comment => { comment.absolutePosition = getAbsolutePosition(comment, matchedFile!.diffHunks, isBase); });

				return getCommentingRanges(matchedFile.diffHunks, isBase);
			}
		}

		const currentWorkspace = vscode.workspace.getWorkspaceFolder(document.uri);
		if (!currentWorkspace) {
			return;
		}

		if (document.uri.scheme === currentWorkspace.uri.scheme) {
			const fileName = nodePath.relative(currentWorkspace!.uri.fsPath, document.uri.fsPath);
			const matchedFiles = gitFileChangeNodeFilter(this._localFileChanges).filter(fileChange => fileChange.fileName === fileName);
			let matchedFile: GitFileChangeNode;
			let ranges = [];

			const headCommitSha = this._prManager.activePullRequest!.head.sha;
			if (matchedFiles && matchedFiles.length) {
				matchedFile = matchedFiles[0];
				let contentDiff = await this.getContentDiff(document, headCommitSha, matchedFile.fileName);
				let diffHunks = matchedFile.diffHunks;

				for (let i = 0; i < diffHunks.length; i++) {
					let diffHunk = diffHunks[i];
					let start = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber);
					let end = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber + diffHunk.newLength - 1);
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

	private async updateCommentThreadRoot(thread: GHPRCommentThread, text: string, temporaryCommentId: number): Promise<void> {
		const uri = thread.uri;
		const matchedFile = this.findMatchedFileByUri(uri);
		const query = uri.query === '' ? undefined : fromReviewUri(uri);
		const isBase = query && query.base;

		if (!matchedFile) {
			throw new Error(`Cannot find document ${uri.toString()}`);
		}

		if (!this._prManager.activePullRequest) {
			throw new Error('No active pull request');
		}
		const headCommitSha = this._prManager.activePullRequest.head.sha;

		// git diff sha -- fileName
		const contentDiff = await this._repository.diffWith(headCommitSha, matchedFile.fileName);
		const position = mapHeadLineToDiffHunkPosition(matchedFile.diffHunks, contentDiff, thread.range.start.line + 1, isBase);

		if (position < 0) {
			throw new Error('Comment position cannot be negative');
		}

		// there is no thread Id, which means it's a new thread
		const rawComment = await this._prManager.createComment(this._prManager.activePullRequest!, text, matchedFile.fileName, position);

		this.replaceTemporaryComment(thread, rawComment!, temporaryCommentId);
		this.addToCommentThreadCache(thread);

		matchedFile.comments.push(rawComment!);
		this._comments.push(rawComment!);

		await this.update(this._localFileChanges, this._obsoleteFileChanges);
		this._onDidChangeComments.fire(this._comments);
	}

	private async getContentDiff(document: vscode.TextDocument, headCommitSha: string, fileName: string): Promise<string> {
		let contentDiff: string;
		if (document.isDirty) {
			const documentText = document.getText();
			const details = await this._repository.getObjectDetails(headCommitSha, fileName);
			const idAtLastCommit = details.object;
			const idOfCurrentText = await this._repository.hashObject(documentText);

			// git diff <blobid> <blobid>
			contentDiff = await this._repository.diffBlobs(idAtLastCommit, idOfCurrentText);
		} else {
			// git diff sha -- fileName
			contentDiff = await this._repository.diffWith(headCommitSha, fileName);
		}

		return contentDiff;
	}

	private outdatedCommentsToCommentThreads(fileChange: GitFileChangeNode, fileComments: IComment[], collapsibleState: vscode.CommentThreadCollapsibleState): ThreadData[] {
		if (!fileComments || !fileComments.length) {
			return [];
		}

		let ret: ThreadData[] = [];
		let sections = groupBy(fileComments, comment => String(comment.position));

		for (let i in sections) {
			let comments = sections[i];

			const firstComment = comments[0];
			let diffLine = getDiffLineByPosition(firstComment.diffHunks || [], firstComment.originalPosition!);

			if (diffLine) {
				firstComment.absolutePosition = diffLine.newLineNumber;
			}

			const pos = new vscode.Position(getZeroBased(firstComment.absolutePosition || 0), 0);
			const range = new vscode.Range(pos, pos);

			ret.push({
				threadId: firstComment.id.toString(),
				resource: fileChange.filePath,
				range,
				comments,
				collapsibleState: collapsibleState
			});
		}

		return ret;
	}

	private provideCommentsForReviewUri(document: vscode.TextDocument, query: ReviewUriParams): ThreadData[] {
		const matchedFile = this.findMatchedFileChangeForReviewDiffView(this._localFileChanges, document.uri);

		if (matchedFile) {
			const matchingComments = matchedFile.comments;
			const isBase = query.base;
			matchingComments.forEach(comment => { comment.absolutePosition = getAbsolutePosition(comment, matchedFile!.diffHunks, isBase); });

			return  workspaceLocalCommentsToCommentThreads(this._repository, matchedFile, matchingComments.filter(comment => comment.absolutePosition !== undefined && comment.absolutePosition > 0), vscode.CommentThreadCollapsibleState.Expanded).map(thread => {
				thread.resource = document.uri; // TODO, this thread is not created yet
				return thread;
			});
		}

		const matchedObsoleteFile = this.findMatchedFileChangeForReviewDiffView(this._obsoleteFileChanges, document.uri);
		let comments: IComment[] = [];
		if (!matchedObsoleteFile) {
			// The file may be a change from a specific commit, check the comments themselves to see if they match it, as obsolete file changs
			// may not contain it
			try {
				comments = this._comments.filter(comment => comment.path === query!.path && `${comment.originalCommitId}^` === query.commit);
			} catch (_) {
				// Do nothing
			}

			if (!comments.length) {
				return [];
			}
		} else {
			comments = matchedObsoleteFile.comments;
		}

		let sections = groupBy(comments, comment => String(comment.originalPosition)); // comment.position is null in this case.
		let ret: ThreadData[] = [];
		for (let i in sections) {
			let commentGroup = sections[i];
			const firstComment = commentGroup[0];
			let diffLine = getLastDiffLine(firstComment.diffHunk);
			if (!diffLine) {
				continue;
			}

			const lineNumber = query.base
				? diffLine.oldLineNumber
				: diffLine.oldLineNumber > 0
					? -1
					: diffLine.newLineNumber;

			if (lineNumber < 0) {
				continue;
			}

			const range = new vscode.Range(new vscode.Position(lineNumber, 0), new vscode.Position(lineNumber, 0));

			ret.push({
				threadId: String(firstComment.id),
				resource: document.uri,
				range,
				comments,
				collapsibleState: vscode.CommentThreadCollapsibleState.Expanded
			});
		}

		return ret;
	}

	private findMatchedFileChangeForReviewDiffView(fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[], uri: vscode.Uri): GitFileChangeNode | undefined {
		let query = fromReviewUri(uri);
		let matchedFiles = fileChanges.filter(fileChange => {
			if (fileChange instanceof RemoteFileChangeNode) {
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

			try {
				let q = JSON.parse(fileChange.filePath.query);

				if (q.commit === query.commit) {
					return true;
				}
			} catch (e) { }

			try {
				let q = JSON.parse(fileChange.parentFilePath.query);

				if (q.commit === query.commit) {
					return true;
				}
			} catch (e) { }

			return false;
		});

		if (matchedFiles && matchedFiles.length) {
			return matchedFiles[0] as GitFileChangeNode;
		}
	}

	private findMatchedFileByUri(uri: vscode.Uri): GitFileChangeNode | undefined {
		let fileName: string;
		let isOutdated = false;
		if (uri.scheme === 'review') {
			const query = fromReviewUri(uri);
			isOutdated = query.isOutdated;
			fileName = query.path;
		}

		if (uri.scheme === 'file') {
			fileName = uri.path;
		}

		if (uri.scheme === 'pr') {
			fileName = fromPRUri(uri)!.fileName;
		}

		const fileChangesToSearch = isOutdated ? this._obsoleteFileChanges : this._localFileChanges;
		const matchedFiles = gitFileChangeNodeFilter(fileChangesToSearch).filter(fileChange => {
			if (uri.scheme === 'review' || uri.scheme === 'pr') {
				return fileChange.fileName === fileName;
			} else {
				let absoluteFilePath = vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, fileChange.fileName));
				let targetFilePath = vscode.Uri.file(fileName);
				return absoluteFilePath.fsPath === targetFilePath.fsPath;
			}
		});

		if (matchedFiles && matchedFiles.length) {
			return matchedFiles[0];
		}
	}

	// #endregion

	// #region Review
	public async startReview(thread: GHPRCommentThread, input: string): Promise<void> {
		await this._prManager.startReview(this._prManager.activePullRequest!);
		await this.createOrReplyComment(thread, input);
	}

	public async finishReview(thread: GHPRCommentThread, input: string): Promise<void> {
		try {
			this.createOrReplyComment(thread, input);
			await this._prManager.submitReview(this._prManager.activePullRequest!);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to submit the review: ${e}`);
		}
	}

	async deleteReview(): Promise<void> {
		const { deletedReviewComments } = await this._prManager.deleteReview(this._prManager.activePullRequest!);

		[this._workspaceFileChangeCommentThreads, this._obsoleteFileChangeCommentThreads, this._reviewDocumentCommentThreads].forEach(commentThreadMap => {
			for (let fileName in commentThreadMap) {
				let threads: GHPRCommentThread[] = [];
				commentThreadMap[fileName].forEach(thread => {
					thread.comments = thread.comments.filter((comment: GHPRComment) => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId));
					updateCommentThreadLabel(thread);
					if (!thread.comments.length) {
						thread.dispose!();
					} else {
						threads.push(thread);
					}
				});

				if (threads.length) {
					commentThreadMap[fileName] = threads;
				} else {
					delete commentThreadMap[fileName];
				}
			}
		});

		for (let fileName in this._prDocumentCommentThreads) {
			if (this._prDocumentCommentThreads[fileName]) {
				if (this._prDocumentCommentThreads[fileName].original) {
					let threads: GHPRCommentThread[] = [];

					this._prDocumentCommentThreads[fileName].original!.forEach(thread => {
						thread.comments = thread.comments.filter((comment: GHPRComment) => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId));
						updateCommentThreadLabel(thread);
						if (!thread.comments.length) {
							thread.dispose!();
						} else {
							threads.push(thread);
						}
					});

					if (threads.length) {
						this._prDocumentCommentThreads[fileName].original! = threads;
					} else {
						this._prDocumentCommentThreads[fileName].original = undefined;
					}
				}

				if (this._prDocumentCommentThreads[fileName].modified) {
					let threads: GHPRCommentThread[] = [];

					this._prDocumentCommentThreads[fileName].modified!.forEach(thread => {
						thread.comments = thread.comments.filter((comment: GHPRComment) => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId));
						updateCommentThreadLabel(thread);
						if (!thread.comments.length) {
							thread.dispose!();
						} else {
							threads.push(thread);
						}
					});

					if (threads.length) {
						this._prDocumentCommentThreads[fileName].modified! = threads;
					} else {
						this._prDocumentCommentThreads[fileName].modified = undefined;
					}
				}
			}

		}
	}

	// #endregion
	private optimisticallyAddComment(thread: GHPRCommentThread, input: string, inDraft: boolean): number {
		const currentUser = this._prManager.getCurrentUser(this._prManager.activePullRequest!); // TODO rmacfarlane add real type
		const comment = new TemporaryComment(thread, input, inDraft, currentUser);
		this.updateCommentThreadComments(thread, [...thread.comments, comment]);
		return comment.id;
	}

	private updateCommentThreadComments(thread: vscode.CommentThread | GHPRCommentThread, newComments: vscode.Comment[]) {
		thread.comments = newComments;
		updateCommentThreadLabel(thread);
	}

	private optimisticallyEditComment(thread: GHPRCommentThread, comment: GHPRComment): number {
		const currentUser = this._prManager.getCurrentUser(this._prManager.activePullRequest!); // TODO rmacfarlane add real type
		const temporaryComment = new TemporaryComment(thread, comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body, !!comment.label, currentUser, comment._rawComment.body);
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

	// #region Comment
	async createOrReplyComment(thread: GHPRCommentThread, input: string, inDraft?: boolean): Promise<void> {
		const hasExistingComments = thread.comments.length;
		const isDraft = inDraft !== undefined ? inDraft : this._prManager.activePullRequest!.inDraftMode;
		const temporaryCommentId = this.optimisticallyAddComment(thread, input, isDraft);

		try {
			if (!hasExistingComments) {
				this.addToCommentThreadCache(thread);
				this.updateCommentThreadRoot(thread, input, temporaryCommentId);
			} else {
				const comment = thread.comments[0];
				if (comment instanceof GHPRComment) {
					const rawComment = await this._prManager.createCommentReply(this._prManager.activePullRequest!, input, comment._rawComment);
					this.replaceTemporaryComment(thread, rawComment!, temporaryCommentId);
				} else {
					throw new Error('Cannot reply to temporary comment');
				}
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

	async editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			const temporaryCommentId = this.optimisticallyEditComment(thread, comment);
			try {
				if (!this._prManager.activePullRequest) {
					throw new Error('Unable to find active pull request');
				}

				const matchedFile = this.findMatchedFileByUri(thread.uri);
				if (!matchedFile) {
					throw new Error('Unable to find matching file');
				}

				const editedComment = await this._prManager.editReviewComment(this._prManager.activePullRequest, comment._rawComment, comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body);

				// Update the cached comments of the file
				const matchingCommentIndex = matchedFile.comments.findIndex(c => String(c.id) === comment.commentId);
				if (matchingCommentIndex > -1) {
					matchedFile.comments.splice(matchingCommentIndex, 1, editedComment);
				}

				// Also update this._comments
				const indexInAllComments = this._comments.findIndex(c => String(c.id) === comment.commentId);
				if (indexInAllComments > -1) {
					this._comments.splice(indexInAllComments, 1, editedComment);
				}

				this.replaceTemporaryComment(thread, editedComment!, temporaryCommentId);
				updateCommentThreadLabel(thread);
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
			this.createOrReplyComment(thread, comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body);
		}
	}

	async deleteComment(thread: vscode.CommentThread, comment: GHPRComment): Promise<void> {
		try {
			if (!this._prManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			const matchedFile = this.findMatchedFileByUri(thread.uri);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			await this._prManager.deleteReviewComment(this._prManager.activePullRequest, comment.commentId);
			const matchingCommentIndex = matchedFile.comments.findIndex(c => c.id.toString() === comment.commentId);
			if (matchingCommentIndex > -1) {
				matchedFile.comments.splice(matchingCommentIndex, 1);
			}

			const indexInAllComments = this._comments.findIndex(c => c.id.toString() === comment.commentId);
			if (indexInAllComments > -1) {
				this._comments.splice(indexInAllComments, 1);
			}

			thread.comments = thread.comments.filter((c: GHPRComment) => c.commentId !== comment.commentId);
			if (thread.comments.length === 0) {
				thread.dispose();
			} else {
				updateCommentThreadLabel(thread);
			}

			let inDraftMode = await this._prManager.validateDraftMode(this._prManager.activePullRequest!);
			if (inDraftMode !== this._prManager.activePullRequest!.inDraftMode) {
				this._prManager.activePullRequest!.inDraftMode = inDraftMode;
			}

			this.update(this._localFileChanges, this._obsoleteFileChanges);

		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	// #endregion

	// #region Incremental update comments
	public async update(localFileChanges: GitFileChangeNode[], obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[]): Promise<void> {
		const inDraftMode = await this._prManager.validateDraftMode(this._prManager.activePullRequest!);
		// _workspaceFileChangeCommentThreads
		for (let fileName in this._workspaceFileChangeCommentThreads) {
			this.updateFileChangeCommentThreads(localFileChanges, fileName, inDraftMode);
		}

		this._localFileChanges = localFileChanges;

		// _obsoleteFileChangeCommentThreads
		for (let fileName in this._obsoleteFileChangeCommentThreads) {
			this.updateFileChangeCommentThreads(gitFileChangeNodeFilter(obsoleteFileChanges), fileName, inDraftMode);
		}

		this._obsoleteFileChanges = obsoleteFileChanges;

		// for pr and review documenet comments, as we dispose them when the editor is being closed, we only need to update for visible editors.
		for (let editor of vscode.window.visibleTextEditors) {
			await this.updateCommentThreadsForEditor(editor);
		}
	}

	private async updateFileChangeCommentThreads(fileChanges: GitFileChangeNode[], fileName: string, inDraftMode: boolean): Promise<void> {
		let matchedFileChanges = fileChanges.filter(fileChange => fileChange.fileName === fileName);

		if (matchedFileChanges.length === 0) {
			this._workspaceFileChangeCommentThreads[fileName].forEach(thread => thread.dispose!());
			delete this._workspaceFileChangeCommentThreads[fileName];
		} else {
			let existingCommentThreads = this._workspaceFileChangeCommentThreads[fileName];
			let matchedFile = matchedFileChanges[0];

			// update commentThreads
			let matchingComments: IComment[] = [];

			const headCommitSha = this._prManager.activePullRequest!.head.sha;
			let contentDiff: string;
			contentDiff = await this._repository.diffWith(headCommitSha, matchedFile.fileName);

			matchingComments = matchedFile.comments;
			matchingComments = mapCommentsToHead(matchedFile.diffHunks, contentDiff, matchingComments);

			let newThreads = workspaceLocalCommentsToCommentThreads(this._repository, matchedFile, matchingComments, vscode.CommentThreadCollapsibleState.Collapsed);

			let resultThreads: GHPRCommentThread[] = [];

			newThreads.forEach(thread => {
				let matchedThread = existingCommentThreads.filter(existingThread => existingThread.threadId === thread.threadId);

				if (matchedThread.length) {
					// let commands = getAcceptInputCommands(matchedThread[0], inDraftMode, this, this._prManager.activePullRequest!.githubRepository.supportsGraphQl);
					// update
					resultThreads.push(matchedThread[0]);
					matchedThread[0].range = thread.range;
					matchedThread[0].comments = thread.comments.map(comment => {
						return new GHPRComment(comment, matchedThread as any);
					});
					updateCommentThreadLabel(matchedThread[0]);

				} else {
					// create new thread
					resultThreads.push(createVSCodeCommentThread(thread, this._commentController!, inDraftMode));
				}
			});

			existingCommentThreads.forEach(existingThread => {
				let matchedThread = newThreads.filter(thread => thread.threadId === existingThread.threadId);

				if (matchedThread.length === 0) {
					existingThread.dispose!();
				}
			});

			this._workspaceFileChangeCommentThreads[fileName] = resultThreads;
		}
	}
	// #endregion

	// #region Reactions
	async toggleReaction(document: vscode.TextDocument, comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		try {
			if (!this._prManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			const matchedFile = this.findMatchedFileByUri(document.uri);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			const rawComment = matchedFile.comments.find(c => String(c.id) === comment.commentId);
			if (!rawComment) {
				throw new Error('Unable to find comment');
			}

			let reactionGroups: ReactionGroup[] = [];
			if (comment.commentReactions && !comment.commentReactions.find(ret => ret.label === reaction.label && !!ret.hasReacted)) {
				let result = await this._prManager.addCommentReaction(this._prManager.activePullRequest, rawComment.graphNodeId, reaction);
				reactionGroups = result.addReaction.subject.reactionGroups;
			} else {
				let result = await this._prManager.deleteCommentReaction(this._prManager.activePullRequest, rawComment.graphNodeId, reaction);
				reactionGroups = result.removeReaction.subject.reactionGroups;
			}

			// Update the cached comments of the file
			const matchingCommentIndex = matchedFile.comments.findIndex(c => c.id.toString() === comment.commentId);
			if (matchingCommentIndex > -1) {
				let editedComment = matchedFile.comments[matchingCommentIndex];
				editedComment.reactions = parseGraphQLReaction(reactionGroups);
				const vscodeCommentReactions = editedComment.reactions.map(ret => {
					return { label: ret.label, hasReacted: ret.viewerHasReacted, count: ret.count, iconPath: ret.icon };
				});

				const fileName = matchedFile.fileName;
				const modifiedThreads = [
					...(this._prDocumentCommentThreads[fileName] ? this._prDocumentCommentThreads[fileName].original || [] : []),
					...(this._prDocumentCommentThreads[fileName] ? this._prDocumentCommentThreads[fileName].modified || []: []),
					...(this._reviewDocumentCommentThreads[fileName] || []),
					...(this._workspaceFileChangeCommentThreads[fileName] || []),
					...(this._obsoleteFileChangeCommentThreads[fileName] || [])
				].filter(td => !!td.comments.find((cmt: GHPRComment) => cmt.commentId === comment.commentId));

				modifiedThreads.forEach(thread => {
					thread.comments = thread.comments.map((cmt: GHPRComment) => {
						if (cmt.commentId === comment.commentId) {
							cmt.commentReactions = vscodeCommentReactions;
						}

						return cmt;
					});
					updateCommentThreadLabel(thread);
				});
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

		this._localToDispose.forEach(d => d.dispose());
	}
}