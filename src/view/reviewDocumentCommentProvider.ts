/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import * as vscode from 'vscode';
import { IComment } from '../common/comment';
import { GHPRComment, GHPRCommentThread } from '../github/prComment';
import { getAbsolutePosition, getLastDiffLine, mapCommentsToHead, mapOldPositionToNew, getDiffLineByPosition, getZeroBased } from '../common/diffPositionMapping';
import { fromPRUri, fromReviewUri, ReviewUriParams } from '../common/uri';
import { formatError, groupBy } from '../common/utils';
import { Repository } from '../api/api';
import { PullRequestManager } from '../github/pullRequestManager';
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { getCommentingRanges, provideDocumentComments } from './treeNodes/pullRequestNode';
import { CommentHandler, getReactionGroup, parseGraphQLReaction, createVSCodeCommentThread, updateCommentThreadLabel, updateCommentCommands, updateCommentReviewState } from '../github/utils';
import { ReactionGroup } from '../github/graphql';
import { DiffHunk, DiffChangeType } from '../common/diffHunk';
import { registerCommentHandler } from '../commentThreadResolver';

function workspaceLocalCommentsToCommentThreads(repository: Repository, fileChange: GitFileChangeNode, fileComments: IComment[], collapsibleState: vscode.CommentThreadCollapsibleState): GHPRCommentThread[] {
	if (!fileChange) {
		return [];
	}

	if (!fileComments || !fileComments.length) {
		return [];
	}

	const ret: GHPRCommentThread[] = [];
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
			comments: comments.map(comment => new GHPRComment(comment)),
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
export class ReviewDocumentCommentProvider implements vscode.Disposable, CommentHandler, vscode.CommentingRangeProvider, vscode.CommentReactionProvider {

	public supportedSchemes: string[] = ['pr', 'review', 'file'];
	private _localToDispose: vscode.Disposable[] = [];
	private _onDidChangeComments = new vscode.EventEmitter<IComment[]>();
	public onDidChangeComments = this._onDidChangeComments.event;

	public availableReactions = getReactionGroup();

	private _commentController?: vscode.CommentController;

	public get commentController(): vscode.CommentController | undefined {
		return this._commentController;
	}

	private _workspaceFileChangeCommentThreads: { [key: string]: vscode.CommentThread[] } = {};
	private _obsoleteFileChangeCommentThreads: { [key: string]: vscode.CommentThread[] } = {};
	private _reviewDocumentCommentThreads: { [key: string]: vscode.CommentThread[] } = {};
	private _prDocumentCommentThreads: { [key: string]: { original?: vscode.CommentThread[], modified?: vscode.CommentThread[] }} = {};

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
				this._repository, matchedFile, matchingComments, vscode.CommentThreadCollapsibleState.Collapsed).map(thread => createVSCodeCommentThread(thread, this._commentController!, this._prManager.activePullRequest!, inDraftMode, this));
			this._workspaceFileChangeCommentThreads[matchedFile.fileName] = threads;
		});

		gitFileChangeNodeFilter(this._obsoleteFileChanges).forEach(fileChange => {
			let threads = this.outdatedCommentsToCommentThreads(fileChange, fileChange.comments, vscode.CommentThreadCollapsibleState.Expanded).map(thread => createVSCodeCommentThread(thread, this._commentController!, this._prManager.activePullRequest!, inDraftMode, this));
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
						this.updateCommentThreadCommands(thread, newDraftMode);
						updateCommentReviewState(thread, newDraftMode);
						updateCommentThreadLabel(thread);
					});
				}
			});

			for (let fileName in this._prDocumentCommentThreads) {
				[...this._prDocumentCommentThreads[fileName].original || [], ...this._prDocumentCommentThreads[fileName].modified || []].forEach(thread => {
					this.updateCommentThreadCommands(thread, newDraftMode);
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

					let documentComments = provideDocumentComments(editor.document.uri, params.isBase, matchedFileChanges[0], matchedFileChanges[0].comments);
					let newThreads: vscode.CommentThread[] = [];
					if (documentComments) {
						documentComments.threads.forEach(thread => {
							newThreads.push(createVSCodeCommentThread(thread, this._commentController!, this._prManager.activePullRequest!, inDraftMode, this));
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
				let newThreads: vscode.CommentThread[] = [];
				reviewCommentThreads.forEach((thread: GHPRCommentThread) => {
					newThreads.push(createVSCodeCommentThread(thread, this._commentController!, this._prManager.activePullRequest!, inDraftMode, this));
				});

				this._reviewDocumentCommentThreads[reviewUriString] = newThreads;
			}
		}
	}

	// #endregion

	hasCommentThread(thread: vscode.CommentThread): boolean {
		if (thread.resource.scheme === 'review') {
			return true;
		}

		if (thread.resource.scheme === 'pr') {
			let params = fromPRUri(thread.resource);
			if (this._prManager.activePullRequest && params && this._prManager.activePullRequest.prNumber === params.prNumber) {
				return true;
			} else {
				return false;
			}
		}

		const currentWorkspace = vscode.workspace.getWorkspaceFolder(thread.resource);
		if (!currentWorkspace) {
			return false;
		}

		if (thread.resource.scheme === currentWorkspace.uri.scheme) {
			return true;
		}

		return false;
	}

	// #region New Comment Thread

	async createEmptyCommentThread(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
		if (await this._prManager.authenticate()) {
			await this._prManager.validateDraftMode(this._prManager.activePullRequest!);
			// threadIds must be unique, otherwise they will collide when vscode saves pending comment text. Assumes
			// that only one empty thread can be created per line.
			// const threadId = document.uri.toString() + range.start.line;
			const thread = this._commentController!.createCommentThread(document.uri, range, []);
			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

			// const commands = getAcceptInputCommands(thread, inDraftMode, this, this._prManager.activePullRequest!.githubRepository.supportsGraphQl);

			// thread.acceptInputCommand = commands.acceptInputCommand;
			// thread.additionalCommands = commands.additionalCommands;
			// thread.deleteCommand = getDeleteThreadCommand(thread);
			updateCommentThreadLabel(thread);
		}
	}

	private addToCommentThreadCache(thread: vscode.CommentThread): void {
		const uri = thread.resource;
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

	private updateCommentThreadCommands(thread: vscode.CommentThread, newDraftMode: boolean) {
		// let commands = getAcceptInputCommands(thread, newDraftMode, this, this._prManager.activePullRequest!.githubRepository.supportsGraphQl);
		// thread.acceptInputCommand = commands.acceptInputCommand;
		// thread.additionalCommands = commands.additionalCommands;
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

	private outdatedCommentsToCommentThreads(fileChange: GitFileChangeNode, fileComments: IComment[], collapsibleState: vscode.CommentThreadCollapsibleState): GHPRCommentThread[] {
		if (!fileComments || !fileComments.length) {
			return [];
		}

		let ret: GHPRCommentThread[] = [];
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
				comments: comments.map(comment => {
					let vscodeComment = new GHPRComment(comment);

					return vscodeComment;
				}),
				collapsibleState: collapsibleState
			});
		}

		return ret;
	}

	private provideCommentsForReviewUri(document: vscode.TextDocument, query: ReviewUriParams): GHPRCommentThread[] {
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
		let ret: GHPRCommentThread[] = [];
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
				comments: commentGroup.map(comment => {
					let vscodeComment = new GHPRComment(comment);
					return vscodeComment;
				}),
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
	public async startReview(thread: vscode.CommentThread): Promise<void> {
		await this._prManager.startReview(this._prManager.activePullRequest!);

		// if (thread.comments.length) {
		// 	let comment = thread.comments[0] as (vscode.Comment & { _rawComment: Comment });
		// 	const rawComment = await this._prManager.createCommentReply(this._prManager.activePullRequest!, this.commentController!.inputBox ? this.commentController!.inputBox!.value : '', comment._rawComment);

		// 	const vscodeComment = convertToVSCodeComment(rawComment!, undefined);
		// 	updateCommentCommands(vscodeComment,this.commentController!, thread, this._prManager.activePullRequest!, this);
		// 	thread.comments = [...thread.comments, vscodeComment];
		// 	updateCommentThreadLabel(thread);
		// } else {
		// 	// create new comment thread

		// 	if (this.commentController!.inputBox && this.commentController!.inputBox!.value) {
		// 		await this.updateCommentThreadRoot(thread, this.commentController!.inputBox!.value);
		// 	}
		// }

		// if (this.commentController!.inputBox) {
		// 	this.commentController!.inputBox!.value = '';
		// }
	}

	public async finishReview(thread: vscode.CommentThread): Promise<void> {
		// if (this.commentController && this.commentController.inputBox && this.commentController.inputBox.value) {
		// 	let comment = thread.comments[0] as (vscode.Comment & { _rawComment: Comment });
		// 	const rawComment = await this._prManager.createCommentReply(this._prManager.activePullRequest!, this.commentController!.inputBox!.value, comment._rawComment);
		// 	const vscodeComment = convertToVSCodeComment(rawComment!, undefined);
		// 	updateCommentCommands(vscodeComment, this.commentController!, thread, this._prManager.activePullRequest!, this);
		// 	thread.comments = [...thread.comments, vscodeComment];
		// 	updateCommentThreadLabel(thread);
		// 	this.commentController!.inputBox!.value = '';
		// }

		// await this._prManager.submitReview(this._prManager.activePullRequest!);
	}

	async deleteReview(): Promise<void> {
		const { deletedReviewComments } = await this._prManager.deleteReview(this._prManager.activePullRequest!);
		// if (this.commentController!.inputBox && this.commentController!.inputBox!.value) {
		// 	this.commentController!.inputBox!.value = '';
		// }

		[this._workspaceFileChangeCommentThreads, this._obsoleteFileChangeCommentThreads, this._reviewDocumentCommentThreads].forEach(commentThreadMap => {
			for (let fileName in commentThreadMap) {
				let threads: vscode.CommentThread[] = [];
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
					let threads: vscode.CommentThread[] = [];

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
					let threads: vscode.CommentThread[] = [];

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

	// #region Comment
	async createOrReplyComment(thread: vscode.CommentThread, input: string): Promise<void> {
		if (await this._prManager.authenticate()) {
			if (thread.comments.length === 0) {
				this.addToCommentThreadCache(thread);
			}

			let comment = thread.comments[0] as (vscode.Comment & { _rawComment: IComment });
			const rawComment = await this._prManager.createCommentReply(this._prManager.activePullRequest!, input, comment._rawComment);
			const vscodeComment = new GHPRComment(rawComment!);
			updateCommentCommands(vscodeComment, this.commentController!, thread, this._prManager.activePullRequest!, this);
			thread.comments = [...thread.comments, vscodeComment];
			updateCommentThreadLabel(thread);
		}
	}

	async editComment(thread: vscode.CommentThread, comment: GHPRComment): Promise<void> {
		try {
			if (!await this._prManager.authenticate()) {
				return;
			}

			if (!this._prManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			const matchedFile = this.findMatchedFileByUri(thread.resource);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			const rawComment = matchedFile.comments.find(c => c.id === Number(comment.commentId));
			if (!rawComment) {
				throw new Error('Unable to find comment');
			}

			const editedComment = await this._prManager.editReviewComment(this._prManager.activePullRequest, rawComment, comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body);

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

			const vscodeComment = new GHPRComment(editedComment);

			let newComments = thread.comments.map((cmt: GHPRComment) => {
				if (cmt.commentId === vscodeComment.commentId) {
					// vscodeComment.editCommand = getEditCommand(thread, vscodeComment, this);
					// vscodeComment.deleteCommand = getDeleteCommand(thread, vscodeComment, this);
					return vscodeComment;
				}

				return cmt;
			});
			thread.comments = newComments;
			updateCommentThreadLabel(thread);

		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	async deleteComment(thread: vscode.CommentThread, comment: GHPRComment): Promise<void> {
		try {
			if (!this._prManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			const matchedFile = this.findMatchedFileByUri(thread.resource);
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

			let resultThreads: vscode.CommentThread[] = [];

			newThreads.forEach(thread => {
				let matchedThread = existingCommentThreads.filter(existingThread => existingThread.threadId === thread.threadId);

				if (matchedThread.length) {
					// let commands = getAcceptInputCommands(matchedThread[0], inDraftMode, this, this._prManager.activePullRequest!.githubRepository.supportsGraphQl);
					// update
					resultThreads.push(matchedThread[0]);
					matchedThread[0].range = thread.range;
					matchedThread[0].comments = thread.comments.map(comment => {
						updateCommentCommands(comment, this.commentController!, matchedThread[0], this._prManager.activePullRequest!, this);
						return comment;
					});
					updateCommentThreadLabel(matchedThread[0]);

				} else {
					// create new thread
					resultThreads.push(createVSCodeCommentThread(thread, this._commentController!, this._prManager.activePullRequest!, inDraftMode, this));
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