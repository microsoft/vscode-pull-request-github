/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import * as vscode from 'vscode';
import { Comment } from '../common/comment';
import { getAbsolutePosition, getLastDiffLine, mapCommentsToHead, mapOldPositionToNew, getDiffLineByPosition, getZeroBased, mapCommentThreadsToHead } from '../common/diffPositionMapping';
import { fromPRUri, fromReviewUri, ReviewUriParams } from '../common/uri';
import { formatError, groupBy } from '../common/utils';
import { Repository } from '../git/api';
import { PullRequestManager } from '../github/pullRequestManager';
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { getCommentingRanges, provideDocumentComments } from './treeNodes/pullRequestNode';
import { convertToVSCodeComment, getReactionGroup, parseGraphQLReaction, createVSCodeCommentThread } from '../github/utils';
import { GitChangeType } from '../common/file';
import { ReactionGroup } from '../github/graphql';
import { getCommentThreadCommands, getEditCommand, getDeleteCommand } from '../github/commands';

function workspaceLocalCommentsToCommentThreads(repository: Repository, fileChange: GitFileChangeNode, fileComments: Comment[], collapsibleState: vscode.CommentThreadCollapsibleState): vscode.CommentThread[] {
	if (!fileChange) {
		return [];
	}

	if (!fileComments || !fileComments.length) {
		return [];
	}

	const ret: vscode.CommentThread[] = [];
	const sections = groupBy(fileComments, comment => String(comment.position));

	let command: vscode.Command | undefined = undefined;
	if (fileChange.status === GitChangeType.DELETE) {
		command = {
			title: 'View Changes',
			command: 'pr.viewChanges',
			arguments: [
				fileChange
			]
		};
	}

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
			comments: comments.map(comment => {
				let vscodeComment = convertToVSCodeComment(comment, command);
				return vscodeComment;
			}),
			collapsibleState
		});
	}

	return ret;
}
export class ReviewDocumentCommentProvider implements vscode.Disposable {
	private _localToDispose: vscode.Disposable[] = [];

	private _onDidChangeDocumentCommentThreads = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();
	public onDidChangeCommentThreads = this._onDidChangeDocumentCommentThreads.event;

	private _onDidChangeComments = new vscode.EventEmitter<Comment[]>();
	public onDidChangeComments = this._onDidChangeComments.event;

	public startDraftLabel = 'Start Review';
	public deleteDraftLabel = 'Delete Review';
	public finishDraftLabel = 'Submit Review';
	public reactionGroup? = getReactionGroup();

	private _commentController?: vscode.CommentController;
	private _workspaceFileChangeCommentThreads: { [key: string]: vscode.CommentThread[] } = {};
	private _obsoleteFileChangeCommentThreads: { [key: string]: vscode.CommentThread[] } = {};
	private _reviewDocumentCommentThreads: { [key: string]: vscode.CommentThread[] } = {};
	private _prDocumentCommentThreads: { [key: string]: vscode.CommentThread[] } = {};

	constructor(
		private _prManager: PullRequestManager,
		private _repository: Repository,
		private _localFileChanges: GitFileChangeNode[],
		private _obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
		private _comments: Comment[]) {
		this._commentController = vscode.comment.createCommentController(`review-${_prManager.activePullRequest!.prNumber}`, _prManager.activePullRequest!.title);
		this._commentController.registerCommentingRangeProvider(this.provideCommentingRanges.bind(this), this.createNewCommentWidgetCallback.bind(this));
		this._localToDispose.push(this._commentController);
	}

	async initialize() {
		await this.initializeWorkspaceCommentThreads();
		await this.initializeDocumentCommentThreadsAndListeners();
	}

	async initializeWorkspaceCommentThreads() {
		const inDraftMode = await this._prManager.inDraftMode(this._prManager.activePullRequest!);
		this._localFileChanges.forEach(async matchedFile => {
			let matchingComments: Comment[] = [];
			let ranges = [];

			const headCommitSha = this._prManager.activePullRequest!.head.sha;
			let contentDiff: string;
			contentDiff = await this._repository.diffWith(headCommitSha, matchedFile.fileName);

			matchingComments = matchedFile.comments;
			matchingComments = mapCommentsToHead(matchedFile.diffHunks, contentDiff, matchingComments);

			let diffHunks = matchedFile.diffHunks;

			for (let i = 0; i < diffHunks.length; i++) {
				let diffHunk = diffHunks[i];
				let start = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber);
				let end = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber + diffHunk.newLength - 1);
				if (start > 0 && end > 0) {
					ranges.push(new vscode.Range(start - 1, 0, end - 1, 0));
				}
			}

			let allFileChangeWorkspaceCommentThreads = workspaceLocalCommentsToCommentThreads(
				this._repository, matchedFile, matchingComments, vscode.CommentThreadCollapsibleState.Expanded);

			let threads: vscode.CommentThread[] = [];
			allFileChangeWorkspaceCommentThreads.forEach(thread => {
				threads.push(createVSCodeCommentThread(thread, this._commentController!, this._prManager.activePullRequest!, inDraftMode));
			});

			this._workspaceFileChangeCommentThreads[matchedFile.fileName] = threads;
		});

		gitFileChangeNodeFilter(this._obsoleteFileChanges).forEach(fileChange => {
			let allFileChangeWorkspaceCommentThreads = this.outdatedCommentsToCommentThreads(fileChange, fileChange.comments, vscode.CommentThreadCollapsibleState.Expanded);

			let threads: vscode.CommentThread[] = [];
			allFileChangeWorkspaceCommentThreads.forEach(thread => {
				threads.push(createVSCodeCommentThread(thread, this._commentController!, this._prManager.activePullRequest!, inDraftMode));
			});

			this._obsoleteFileChangeCommentThreads[fileChange.fileName] = threads;
		});
	}

	async initializeDocumentCommentThreadsAndListeners() {
		this._localToDispose.push(vscode.window.onDidChangeVisibleTextEditors(async e => {
			for (let editor of e) {
				await this.initializeCommentThreadsForEditor(editor);
			}
		}));

		this._localToDispose.push(this._prManager.activePullRequest!.onDidChangeDraftMode(newDraftMode => {
			[this._workspaceFileChangeCommentThreads, this._obsoleteFileChangeCommentThreads, this._prDocumentCommentThreads, this._reviewDocumentCommentThreads].forEach(commentThreadMap => {
				for (let fileName in commentThreadMap) {
					commentThreadMap[fileName].forEach(thread => {
						let commands = getCommentThreadCommands(this._commentController!, thread, this._prManager.activePullRequest!, newDraftMode);
						thread.acceptInputCommands = commands;
						thread.comments = thread.comments.map(comment => {
							comment.label = newDraftMode ? 'Draft' : undefined;
							comment.isDraft = newDraftMode;
							return comment;
						});
					});
				}
			});
		}));
	}

	async initializeCommentThreadsForEditor(editor: vscode.TextEditor) {
		if (editor.document.uri.scheme === 'pr') {
			const params = fromPRUri(editor.document.uri);

			if (params && params.prNumber === this._prManager.activePullRequest!.prNumber) {
				if (this._prDocumentCommentThreads[params.fileName]) {
					return;
				}

				let matchedFileChanges = this._localFileChanges.filter(localFileChange => localFileChange.fileName === params.fileName);

				if (matchedFileChanges.length) {
					const inDraftMode = await this._prManager.inDraftMode(this._prManager.activePullRequest!);
					let commentThreads = provideDocumentComments(editor.document.uri, params.isBase, matchedFileChanges[0], inDraftMode);

					if (commentThreads) {
						let newThreads: vscode.CommentThread[] = [];
						commentThreads.threads.forEach(thread => {
							newThreads.push(createVSCodeCommentThread(thread, this._commentController!, this._prManager.activePullRequest!, inDraftMode));
						});

						this._prDocumentCommentThreads[params.fileName] = newThreads;
					}
				}
			}

			return;
		}

		if (editor.document.uri.scheme !== 'review' && editor.document.uri.scheme === this._repository.rootUri.scheme) {
			let fileName = vscode.workspace.asRelativePath(editor.document.uri.path);
			// local files
			let matchedFiles = this._localFileChanges.filter(fileChange => fileChange.fileName === fileName);

			if (matchedFiles && !matchedFiles.length) {
				return;
			}

			let commentThreads = this._workspaceFileChangeCommentThreads[fileName];

			const headCommitSha = this._prManager.activePullRequest!.head.sha;
			let contentDiff: string;
			if (editor.document.isDirty) {
				const documentText = editor.document.getText();
				const details = await this._repository.getObjectDetails(headCommitSha, fileName);
				const idAtLastCommit = details.object;
				const idOfCurrentText = await this._repository.hashObject(documentText);

				// git diff <blobid> <blobid>
				contentDiff = await this._repository.diffBlobs(idAtLastCommit, idOfCurrentText);
			} else {
				// git diff sha -- fileName
				contentDiff = await this._repository.diffWith(headCommitSha, fileName);
			}

			mapCommentThreadsToHead(matchedFiles[0].diffHunks, contentDiff, commentThreads);
			return;
		}

		let query: ReviewUriParams | undefined;
		let reviewUriString = editor.document.uri.toString();

		if (this._reviewDocumentCommentThreads[reviewUriString]) {
			return;
		}

		try {
			query = fromReviewUri(editor.document.uri);
		} catch (e) { }

		if (query) {
			const inDraftMode = await this._prManager.inDraftMode(this._prManager.activePullRequest!);
			let reviewCommentThreads = this.provideCommentInfoForReviewUri(editor.document, query, inDraftMode);

			if (reviewCommentThreads) {
				let newThreads: vscode.CommentThread[] = [];
				reviewCommentThreads.threads.forEach(thread => {
					newThreads.push(createVSCodeCommentThread(thread, this._commentController!, this._prManager.activePullRequest!, inDraftMode));
				});

				this._reviewDocumentCommentThreads[reviewUriString] = newThreads;
			}
		}
	}

	async createNewCommentWidgetCallback(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
		if (await this._prManager.authenticate()) {
			let thread = this._commentController!.createCommentThread('', document.uri, range);
			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

			let commands = [];
			commands.push({
				title: 'Start Review',
				command: 'pr.startReview',
				arguments: [
					this._commentController!,
					thread,
					this._prManager.activePullRequest!
				]
			});

			commands.push({
				title: 'Add Comment',
				command: 'pr.replyComment',
				arguments: [
					this._commentController!,
					thread,
					this._prManager.activePullRequest!
				]
			});

			thread.acceptInputCommands = commands;
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

				let contentDiff: string;
				if (document.isDirty) {
					const documentText = document.getText();
					const details = await this._repository.getObjectDetails(headCommitSha, matchedFile.fileName);
					const idAtLastCommit = details.object;
					const idOfCurrentText = await this._repository.hashObject(documentText);

					// git diff <blobid> <blobid>
					contentDiff = await this._repository.diffBlobs(idAtLastCommit, idOfCurrentText);
				} else {
					// git diff sha -- fileName
					contentDiff = await this._repository.diffWith(headCommitSha, matchedFile.fileName);
				}

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

	private outdatedCommentsToCommentThreads(fileChange: GitFileChangeNode, fileComments: Comment[], collapsibleState: vscode.CommentThreadCollapsibleState): vscode.CommentThread[] {
		if (!fileComments || !fileComments.length) {
			return [];
		}

		let ret: vscode.CommentThread[] = [];
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
					let vscodeComment = convertToVSCodeComment(comment, {
						title: 'View Changes',
						command: 'pr.viewChanges',
						arguments: [
							fileChange
						]
					});

					return vscodeComment;
				}),
				collapsibleState: collapsibleState
			});
		}

		return ret;
	}

	private provideCommentInfoForReviewUri(document: vscode.TextDocument, query: ReviewUriParams, inDraftMode: boolean): vscode.CommentInfo | undefined {
		const matchedFile = this.findMatchedFileChangeForReviewDiffView(this._localFileChanges, document.uri);

		if (matchedFile) {
			const matchingComments = matchedFile.comments;
			const isBase = query.base;
			matchingComments.forEach(comment => { comment.absolutePosition = getAbsolutePosition(comment, matchedFile!.diffHunks, isBase); });

			return {
				threads: workspaceLocalCommentsToCommentThreads(this._repository, matchedFile, matchingComments.filter(comment => comment.absolutePosition !== undefined && comment.absolutePosition > 0), vscode.CommentThreadCollapsibleState.Expanded),
				commentingRanges: getCommentingRanges(matchedFile.diffHunks, isBase),
				inDraftMode: inDraftMode
			};
		}

		const matchedObsoleteFile = this.findMatchedFileChangeForReviewDiffView(this._obsoleteFileChanges, document.uri);
		let comments: Comment[] = [];
		if (!matchedObsoleteFile) {
			// The file may be a change from a specific commit, check the comments themselves to see if they match it, as obsolete file changs
			// may not contain it
			try {
				comments = this._comments.filter(comment => comment.path === query!.path && `${comment.originalCommitId}^` === query.commit);
			} catch (_) {
				// Do nothing
			}

			if (!comments.length) {
				return;
			}
		} else {
			comments = matchedObsoleteFile.comments;
		}

		let sections = groupBy(comments, comment => String(comment.originalPosition)); // comment.position is null in this case.
		let ret: vscode.CommentThread[] = [];
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
				resource: vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, firstComment.path!)),
				range,
				comments: commentGroup.map(comment => {
					let vscodeComment = convertToVSCodeComment(comment, undefined);
					return vscodeComment;
				}),
				collapsibleState: vscode.CommentThreadCollapsibleState.Expanded
			});

			return {
				threads: ret,
				inDraftMode: inDraftMode
			};
		}
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

	private findMatchedFileByUri(document: vscode.TextDocument): GitFileChangeNode | undefined {
		const uri = document.uri;

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

	async deleteReview(deletedReviewId: number, deletedReviewComments: Comment[]) {
		[this._workspaceFileChangeCommentThreads, this._obsoleteFileChangeCommentThreads, this._prDocumentCommentThreads, this._reviewDocumentCommentThreads].forEach(commentThreadMap => {
			for (let fileName in commentThreadMap) {
				let threads: vscode.CommentThread[] = [];
				commentThreadMap[fileName].forEach(thread => {
					thread.comments = thread.comments.filter(comment => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId));
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
	}

	public async update(localFileChanges: GitFileChangeNode[], obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[], comments: Comment[]): Promise<void> {
		const inDraftMode = await this._prManager.inDraftMode(this._prManager.activePullRequest!);
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

		// update pr document comments
		for (let fileName in this._prDocumentCommentThreads) {
			let matchedFileCommentThreads = this._workspaceFileChangeCommentThreads[fileName];

			if (!matchedFileCommentThreads || matchedFileCommentThreads.length === 0) {
				// remove
				this._prDocumentCommentThreads[fileName].forEach(thread => thread.dispose!());
				delete this._prDocumentCommentThreads[fileName];
			} else {
				let threads = this._prDocumentCommentThreads[fileName];
				this.updatePRorReviewCommentThreads(this._prDocumentCommentThreads, fileName, threads, matchedFileCommentThreads, inDraftMode);
			}
		}

		// update review document comments
		for (let reviewUriString in this._reviewDocumentCommentThreads) {
			let reviewUri = vscode.Uri.parse(reviewUriString);
			let params = fromReviewUri(reviewUri);
			let fileName = params.path;
			let matchedFileCommentThreads: vscode.CommentThread[] = [];

			if (params.commit === this._prManager.activePullRequest!.head.sha) {
				matchedFileCommentThreads = this._workspaceFileChangeCommentThreads[fileName];
			} else {
				let obsoleteFileChange = gitFileChangeNodeFilter(this._obsoleteFileChanges).find(fileChange => fileChange.sha === params.commit && fileChange.fileName === fileName);

				if (obsoleteFileChange) {
					matchedFileCommentThreads = this._obsoleteFileChangeCommentThreads[obsoleteFileChange.fileName];
				}
			}

			if (!matchedFileCommentThreads || matchedFileCommentThreads.length === 0) {
				// remove
				this._reviewDocumentCommentThreads[fileName].forEach(thread => thread.dispose!());
				delete this._reviewDocumentCommentThreads[fileName];
			} else {
				let threads = this._reviewDocumentCommentThreads[fileName];
				this.updatePRorReviewCommentThreads(this._reviewDocumentCommentThreads, fileName, threads, matchedFileCommentThreads, inDraftMode);
			}
		}
	}

	public async updatePRorReviewCommentThreads(map: { [key: string]: vscode.CommentThread[] }, fileName: string, threads: vscode.CommentThread[], matchedFileCommentThreads: vscode.CommentThread[], inDraftMode: boolean) {
		if (threads && threads.length) {
			// update
			let resourceUri = threads[0].resource;

			let resultThreads: vscode.CommentThread[] = [];
			threads.forEach(thread => {
				let matchedFileCommentThread = matchedFileCommentThreads.find(localFileCommentThread => localFileCommentThread.threadId === thread.threadId);

				if (matchedFileCommentThread) {
					matchedFileCommentThread.range = matchedFileCommentThread.range;
					matchedFileCommentThread.comments = matchedFileCommentThread.comments;
					let commands = getCommentThreadCommands(this._commentController!, matchedFileCommentThread, this._prManager.activePullRequest!, inDraftMode);
					matchedFileCommentThread.acceptInputCommands = commands;
					resultThreads.push(matchedFileCommentThread);
				} else {
					thread.dispose!();
				}
			});

			matchedFileCommentThreads.forEach(localFileCommentThread => {
				if (!threads.find(thread => thread.threadId === localFileCommentThread.threadId)) {
					let vscodeThread = this._commentController!.createCommentThread(
						localFileCommentThread.threadId,
						resourceUri,
						localFileCommentThread.range!
					);

					localFileCommentThread.comments.forEach(comment => {
						if (comment.canEdit) {
							comment.editCommand = getEditCommand(this._commentController!, vscodeThread, this._prManager.activePullRequest!, comment);

						}
						if (comment.canDelete) {
							comment.deleteCommand = getDeleteCommand(this._commentController!, vscodeThread, this._prManager.activePullRequest!, comment);
						}
					});

					vscodeThread.comments = localFileCommentThread.comments;

					let commands = getCommentThreadCommands(this._commentController!, vscodeThread, this._prManager.activePullRequest!, inDraftMode);
					vscodeThread.acceptInputCommands = commands;
					vscodeThread.collapsibleState = localFileCommentThread.collapsibleState;

					resultThreads.push(vscodeThread);
				}
			});

			map[fileName] = resultThreads;
		}
	}

	public async updateFileChangeCommentThreads(fileChanges: GitFileChangeNode[], fileName: string, inDraftMode: boolean) {
		let matchedFileChanges = fileChanges.filter(fileChange => fileChange.fileName === fileName);

		if (matchedFileChanges.length === 0) {
			this._workspaceFileChangeCommentThreads[fileName].forEach(thread => thread.dispose!());
			delete this._workspaceFileChangeCommentThreads[fileName];
		} else {
			let existingCommentThreads = this._workspaceFileChangeCommentThreads[fileName];
			let matchedFile = matchedFileChanges[0];

			// update commentThreads
			let matchingComments: Comment[] = [];

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
					let commands = getCommentThreadCommands(this._commentController!, matchedThread[0], this._prManager.activePullRequest!, inDraftMode);
					// update
					resultThreads.push(matchedThread[0]);
					matchedThread[0].range = thread.range;
					matchedThread[0].comments = thread.comments;
					matchedThread[0].acceptInputCommands = commands;
				} else {
					// create new thread
					resultThreads.push(createVSCodeCommentThread(thread, this._commentController!, this._prManager.activePullRequest!, inDraftMode));
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

	public async addReaction(document: vscode.TextDocument, comment: vscode.Comment, reaction: vscode.CommentReaction) {
		await this.editReaction(document, comment, reaction, true);
	}

	public async deleteReaction(document: vscode.TextDocument, comment: vscode.Comment, reaction: vscode.CommentReaction) {
		await this.editReaction(document, comment, reaction, false);
	}

	private async editReaction(document: vscode.TextDocument, comment: vscode.Comment, reaction: vscode.CommentReaction, addReaction: boolean) {
		try {
			if (!this._prManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			const matchedFile = this.findMatchedFileByUri(document);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			const rawComment = matchedFile.comments.find(c => c.id === Number(comment.commentId));
			if (!rawComment) {
				throw new Error('Unable to find comment');
			}

			let reactionGroups: ReactionGroup[] = [];
			if (addReaction) {
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
				// const changedThreads = workspaceLocalCommentsToCommentThreads(this._repository, matchedFile, matchedFile.comments.filter(c => c.position === editedComment.position), vscode.CommentThreadCollapsibleState.Expanded);

				// this._onDidChangeDocumentCommentThreads.fire({
				// 	added: [],
				// 	changed: changedThreads,
				// 	removed: []
				// });
			}
		} catch (e) {
			throw new Error(formatError(e));
		}
	}
	public dispose() {
		if (this._commentController) {
			this._commentController.dispose();
		}

		this._localToDispose.forEach(d => d.dispose());
	}
}