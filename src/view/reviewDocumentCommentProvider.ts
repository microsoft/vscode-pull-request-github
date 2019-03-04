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
import { convertToVSCodeComment, getReactionGroup, parseGraphQLReaction } from '../github/utils';
import { GitChangeType } from '../common/file';
import { ReactionGroup } from '../github/graphql';
import { PullRequestModel } from '../github/pullRequestModel';
import { getCommentThreadCommands } from '../github/commands';

const _onDidChangeWorkspaceCommentThreads = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();

function workspaceLocalCommentsToCommentThreads(control: vscode.CommentControl, pullRequestModel: PullRequestModel ,repository: Repository, fileChange: GitFileChangeNode, fileComments: Comment[], collapsibleState: vscode.CommentThreadCollapsibleState): vscode.CommentThread[] {
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
				let vscodeComment = convertToVSCodeComment(comment, command, control, pullRequestModel);
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

	private _commentControl?: vscode.CommentControl;
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
		this._commentControl = vscode.comment.createCommentControl(`review-${_prManager.activePullRequest!.prNumber}`, _prManager.activePullRequest!.title);
		this._localToDispose.push(this._commentControl);
	}

	async initialize() {
		await this.initializeWorkspaceCommentThreads();
		await this.initializeDocumentCommentThreadsAndListeners();
	}

	async initializeWorkspaceCommentThreads() {
		const inDraftMode = await this._prManager.inDraftMode(this._prManager.activePullRequest!);
		let commands = getCommentThreadCommands(this._commentControl!, this._prManager.activePullRequest!, inDraftMode);
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

			let allFileChangeWorkspaceCommentThreads = workspaceLocalCommentsToCommentThreads(this._commentControl!, this._prManager.activePullRequest!, this._repository, matchedFile, matchingComments, vscode.CommentThreadCollapsibleState.Expanded);

			let threads: vscode.CommentThread[] = [];
			allFileChangeWorkspaceCommentThreads.forEach(thread => {
				threads.push(this._commentControl!.createCommentThread(
					thread.threadId,
					thread.resource,
					thread.range!,
					thread.comments,
					commands,
					thread.collapsibleState
				));
			});

			this._workspaceFileChangeCommentThreads[matchedFile.fileName] = threads;
		});

		gitFileChangeNodeFilter(this._obsoleteFileChanges).forEach(fileChange => {
			let allFileChangeWorkspaceCommentThreads = this.outdatedCommentsToCommentThreads(fileChange, fileChange.comments, vscode.CommentThreadCollapsibleState.Expanded);

			let threads: vscode.CommentThread[] = [];
			allFileChangeWorkspaceCommentThreads.forEach(thread => {
				threads.push(this._commentControl!.createCommentThread(
					thread.threadId,
					thread.resource,
					thread.range!,
					thread.comments,
					commands,
					thread.collapsibleState
				));
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
			let commands = getCommentThreadCommands(this._commentControl!, this._prManager.activePullRequest!, newDraftMode);

			[this._workspaceFileChangeCommentThreads, this._obsoleteFileChangeCommentThreads, this._prDocumentCommentThreads, this._reviewDocumentCommentThreads].forEach(commentThreadMap => {
				for (let fileName in commentThreadMap) {
					commentThreadMap[fileName].forEach(thread => thread.acceptInputCommands = commands);
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
					let commentThreads = provideDocumentComments(this._commentControl!, this._prManager.activePullRequest!, editor.document.uri, params.isBase, matchedFileChanges[0], inDraftMode);

					if (commentThreads) {
						let commands = getCommentThreadCommands(this._commentControl!, this._prManager.activePullRequest!, inDraftMode);

						let newThreads: vscode.CommentThread[] = [];
						commentThreads.threads.forEach(thread => {
							newThreads.push(this._commentControl!.createCommentThread(
								thread.threadId,
								thread.resource,
								thread.range!,
								thread.comments,
								commands,
								thread.collapsibleState
							));
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
			let commands = getCommentThreadCommands(this._commentControl!, this._prManager.activePullRequest!, inDraftMode);
			let reviewCommentThreads = this.provideCommentInfoForReviewUri(editor.document, query, inDraftMode);

			if (reviewCommentThreads) {
				let newThreads: vscode.CommentThread[] = [];
				reviewCommentThreads.threads.forEach(thread => {
					newThreads.push(this._commentControl!.createCommentThread(
						thread.threadId,
						editor.document.uri,
						thread.range!,
						thread.comments,
						commands,
						thread.collapsibleState
					));
				});

				this._reviewDocumentCommentThreads[reviewUriString] = newThreads;
			}
		}
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
					}, this._commentControl!, this._prManager.activePullRequest!);

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
				threads: workspaceLocalCommentsToCommentThreads(this._commentControl!, this._prManager.activePullRequest!, this._repository, matchedFile, matchingComments.filter(comment => comment.absolutePosition !== undefined && comment.absolutePosition > 0), vscode.CommentThreadCollapsibleState.Expanded),
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
					let vscodeComment = convertToVSCodeComment(comment, undefined, this._commentControl!, this._prManager.activePullRequest!);
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

	async deleteDraft(_document: vscode.TextDocument, _token: vscode.CancellationToken) {
		if (!this._prManager.activePullRequest) {
			throw new Error('Unable to find active pull request');
		}

		const { deletedReviewId, deletedReviewComments } = await this._prManager.deleteReview(this._prManager.activePullRequest);

		const removed: vscode.CommentThread[] = [];
		const changed: vscode.CommentThread[] = [];

		const oldCommentThreads = this.allCommentsToCommentThreads(this._comments, vscode.CommentThreadCollapsibleState.Expanded);
		oldCommentThreads.forEach(thread => {
			thread.comments = thread.comments.filter(comment => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId));
			if (!thread.comments.length) {
				removed.push(thread);
			} else {
				changed.push(thread);
			}
		});

		const commentsByFile = groupBy(deletedReviewComments, comment => comment.path!);
		for (let filePath in commentsByFile) {
			const matchedFile = this._localFileChanges.find(fileChange => fileChange.fileName === filePath);
			if (matchedFile) {
				matchedFile.comments = matchedFile.comments.filter(comment => comment.pullRequestReviewId !== deletedReviewId);
			}
		}

		this._comments = this._comments.filter(comment => !deletedReviewComments.some(deletedComment => deletedComment.id === comment.id));
		this._onDidChangeComments.fire(this._comments);

		this._onDidChangeDocumentCommentThreads.fire({
			added: [],
			changed,
			removed,
			inDraftMode: false
		});

		_onDidChangeWorkspaceCommentThreads.fire({
			added: [],
			changed,
			removed,
			inDraftMode: false
		});
	}

	async finishDraft(document: vscode.TextDocument, _token: vscode.CancellationToken) {
		try {
			if (!this._prManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			await this._prManager.submitReview(this._prManager.activePullRequest);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to submit the review: ${e}`);
		}
	}

	public async update(localFileChanges: GitFileChangeNode[], obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[], comments: Comment[]): Promise<void> {
		const inDraftMode = await this._prManager.inDraftMode(this._prManager.activePullRequest!);
		let commands = getCommentThreadCommands(this._commentControl!, this._prManager.activePullRequest!, inDraftMode);

		// _workspaceFileChangeCommentThreads
		for (let fileName in this._workspaceFileChangeCommentThreads) {
			this.updateFileChangeCommentThreads(localFileChanges, fileName, commands);
		}

		this._localFileChanges = localFileChanges;

		// _obsoleteFileChangeCommentThreads
		for (let fileName in this._obsoleteFileChangeCommentThreads) {
			this.updateFileChangeCommentThreads(gitFileChangeNodeFilter(obsoleteFileChanges), fileName, commands);
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
				this.updatePRorReviewCommentThreads(threads, matchedFileCommentThreads, commands);
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
				this.updatePRorReviewCommentThreads(threads, matchedFileCommentThreads, commands);
			}
		}
	}

	public async updatePRorReviewCommentThreads(threads: vscode.CommentThread[], matchedFileCommentThreads: vscode.CommentThread[], commands: vscode.Command[]) {
		if (threads && threads.length) {
			// update
			let resourceUri = threads[0].resource;

			let resultThreads: vscode.CommentThread[] = [];
			threads.forEach(thread => {
				let matchedFileCommentThread = matchedFileCommentThreads.find(localFileCommentThread => localFileCommentThread.threadId === thread.threadId);

				if (matchedFileCommentThread) {
					matchedFileCommentThread.range = matchedFileCommentThread.range;
					matchedFileCommentThread.comments = matchedFileCommentThread.comments;
					matchedFileCommentThread.acceptInputCommands = commands;
					resultThreads.push(matchedFileCommentThread);
				} else {
					thread.dispose!();
				}
			});

			matchedFileCommentThreads.forEach(localFileCommentThread => {
				if (!threads.find(thread => thread.threadId === localFileCommentThread.threadId)) {
					resultThreads.push(this._commentControl!.createCommentThread(
						localFileCommentThread.threadId,
						resourceUri,
						localFileCommentThread.range!,
						localFileCommentThread.comments,
						commands,
						localFileCommentThread.collapsibleState
					));
				}
			});
		}
	}

	public async updateFileChangeCommentThreads(fileChanges: GitFileChangeNode[], fileName: string, commands: vscode.Command[]) {
		let matchedFileChanges = fileChanges.filter(fileChange => fileChange.fileName === fileName);

		if (matchedFileChanges.length === 0) {
			this._workspaceFileChangeCommentThreads[fileName].forEach(thread => thread.dispose!());
			delete this._workspaceFileChangeCommentThreads[fileName];
		} else {
			let existingCommentThreads = this._workspaceFileChangeCommentThreads[fileName];
			let matchedFile = matchedFileChanges[0];

			// update commentThreads
			let matchingComments: Comment[] = [];
			let ranges = [];

			const headCommitSha = this._prManager.activePullRequest!.head.sha;
			let contentDiff: string;
			contentDiff = await this._repository.diffWith(headCommitSha, matchedFile.fileName);

			matchingComments = matchedFile.comments;
			matchingComments = mapCommentsToHead(matchedFile.diffHunks, contentDiff, matchingComments);

			let newThreads = workspaceLocalCommentsToCommentThreads(this._commentControl!, this._prManager.activePullRequest!, this._repository, matchedFile, matchingComments, vscode.CommentThreadCollapsibleState.Collapsed);

			let resultThreads: vscode.CommentThread[] = [];

			newThreads.forEach(thread => {
				let matchedThread = existingCommentThreads.filter(existingThread => existingThread.threadId === thread.threadId);

				if (matchedThread.length) {
					// update
					resultThreads.push(matchedThread[0]);
					matchedThread[0].range = thread.range;
					matchedThread[0].comments = thread.comments;
					matchedThread[0].acceptInputCommands = commands;
				} else {
					// create new thread
					resultThreads.push(this._commentControl!.createCommentThread(
						thread.threadId,
						thread.resource,
						thread.range!,
						thread.comments,
						commands,
						thread.collapsibleState
					));
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

	private allCommentsToCommentThreads(comments: Comment[], collapsibleState: vscode.CommentThreadCollapsibleState): vscode.CommentThread[] {
		if (!comments || !comments.length) {
			return [];
		}

		let fileCommentGroups = groupBy(comments, comment => comment.path!);
		let ret: vscode.CommentThread[] = [];

		for (let file in fileCommentGroups) {
			let fileComments: Comment[] = fileCommentGroups[file];

			let matchedFiles = gitFileChangeNodeFilter(this._localFileChanges).filter(fileChange => fileChange.fileName === file);

			if (matchedFiles && matchedFiles.length) {
				ret = [...ret, ...workspaceLocalCommentsToCommentThreads(this._commentControl!, this._prManager.activePullRequest!, this._repository, matchedFiles[0], fileComments, collapsibleState)];
			}
		}
		return ret;
	}

	private updateCommentPendingState(submittedComments: Comment[]) {
		this._comments.forEach(comment => {
			comment.isDraft = false;
		});

		this._onDidChangeComments.fire(this._comments);

		const commentsByFile = groupBy(submittedComments, comment => comment.path || '');
		for (let filePath in commentsByFile) {
			const matchedFile = this._localFileChanges.find(fileChange => fileChange.fileName === filePath);
			if (matchedFile) {
				matchedFile.comments.forEach(comment => {
					comment.isDraft = false;
				});
			}
		}

		const open = groupBy(vscode.workspace.textDocuments,
			doc => doc.uri.scheme === 'file'
				? vscode.workspace.asRelativePath(doc.uri.path)
				: doc.uri.path[0] === '/' ? doc.uri.path.slice(1) : doc.uri.path);
		const changed = this.allCommentsToCommentThreads(this._comments, vscode.CommentThreadCollapsibleState.Expanded);
		let i = changed.length; while (i-- > 0) {
			const thread = changed[i];
			const docsForThread = open[vscode.workspace.asRelativePath(thread.resource)];
			if (!docsForThread) { continue; }
			changed.push(...docsForThread.map(doc => ({ ...thread, resource: doc.uri })));
		}
		this._onDidChangeDocumentCommentThreads.fire({
			added: [],
			changed,
			removed: [],
			inDraftMode: false
		});
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
				const changedThreads = workspaceLocalCommentsToCommentThreads(this._commentControl!, this._prManager.activePullRequest!, this._repository, matchedFile, matchedFile.comments.filter(c => c.position === editedComment.position), vscode.CommentThreadCollapsibleState.Expanded);

				this._onDidChangeDocumentCommentThreads.fire({
					added: [],
					changed: changedThreads,
					removed: []
				});
			}
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	public dispose() {
		if (this._commentControl) {
			this._commentControl.dispose();
		}

		this._localToDispose.forEach(d => d.dispose());
	}
}