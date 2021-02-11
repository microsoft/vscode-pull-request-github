/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import * as uuid from 'uuid';
import * as vscode from 'vscode';
import { IComment } from '../common/comment';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../github/prComment';
import { getAbsolutePosition, getLastDiffLine, mapCommentsToHead, mapOldPositionToNew, getDiffLineByPosition, getZeroBased, mapHeadLineToDiffHunkPosition } from '../common/diffPositionMapping';
import { fromPRUri, fromReviewUri, ReviewUriParams } from '../common/uri';
import { formatError, groupBy, uniqBy } from '../common/utils';
import { Repository } from '../api/api';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { getDocumentThreadDatas, ThreadData } from './treeNodes/pullRequestNode';
import { parseGraphQLReaction, createVSCodeCommentThread, updateCommentThreadLabel, updateCommentReviewState, CommentReactionHandler, generateCommentReactions } from '../github/utils';
import { ReactionGroup } from '../github/graphql';
import { DiffHunk, DiffChangeType } from '../common/diffHunk';
import { CommentHandler, registerCommentHandler, unregisterCommentHandler } from '../commentHandlerResolver';
import { CommentThreadCache } from './commentThreadCache';
import { getCommentingRanges } from '../common/commentingRanges';
import { GitChangeType } from '../common/file';

function workspaceLocalCommentsToCommentThreads(repository: Repository, fileChange: GitFileChangeNode, fileComments: IComment[]): ThreadData[] {
	if (!fileChange) {
		return [];
	}

	if (!fileComments || !fileComments.length) {
		return [];
	}

	const ret: ThreadData[] = [];
	const sections = groupBy(fileComments, comment => String(comment.position));

	for (const i in sections) {
		const comments = sections[i];

		const firstComment = comments[0];
		const pos = new vscode.Position(getZeroBased(firstComment.absolutePosition || 0), 0);
		const range = new vscode.Range(pos, pos);

		const newPath = nodePath.join(repository.rootUri.path, firstComment.path!).replace(/\\/g, '/');
		const newUri = repository.rootUri.with({ path: newPath });
		ret.push({
			threadId: firstComment.id.toString(),
			uri: newUri,
			range,
			comments
		});
	}

	return ret;
}

function mapCommentThreadsToHead(diffHunks: DiffHunk[], localDiff: string, commentThreads: GHPRCommentThread[]) {
	commentThreads.forEach(thread => {
		if (thread.comments && thread.comments.length) {
			const comment = thread.comments[0];

			if (comment instanceof GHPRComment) {
				const diffLine = getDiffLineByPosition(diffHunks, comment._rawComment.position || comment._rawComment.originalPosition!);
				if (diffLine) {
					const positionInPr = diffLine.type === DiffChangeType.Delete ? diffLine.oldLineNumber : diffLine.newLineNumber;
					const newPosition = getZeroBased(mapOldPositionToNew(localDiff, positionInPr));
					const range = new vscode.Range(newPosition, 0, newPosition, 0);

					thread.range = range;
				}
			}
		}
	});
}

export class ReviewCommentController implements vscode.Disposable, CommentHandler, vscode.CommentingRangeProvider, CommentReactionHandler {

	private _localToDispose: vscode.Disposable[] = [];
	private _onDidChangeComments = new vscode.EventEmitter<IComment[]>();
	public onDidChangeComments = this._onDidChangeComments.event;

	private _commentHandlerId: string;

	private _commentController?: vscode.CommentController;

	public get commentController(): vscode.CommentController | undefined {
		return this._commentController;
	}

	// Note: marked as protected so that tests can verify caches have been updated correctly without breaking type safety
	protected _workspaceFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};
	protected _obsoleteFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};

	// In most cases, the right side/modified document is of type 'file' scheme, so comments
	// for that side are from _workspaceFileChangeCommentThreads. If the document has been
	// deleted, the right hand side will be 'review' scheme.
	protected _reviewDocumentCommentThreads: CommentThreadCache = new CommentThreadCache();

	protected _prDocumentCommentThreads: CommentThreadCache = new CommentThreadCache();

	protected _visibleNormalTextEditors: vscode.TextEditor[] = [];

	constructor(
		private _reposManager: FolderRepositoryManager,
		private _repository: Repository,
		private _localFileChanges: GitFileChangeNode[],
		private _obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
		private _comments: IComment[]) {
		this._commentController = vscode.comments.createCommentController(`review-${_reposManager.activePullRequest!.number}`, _reposManager.activePullRequest!.title);
		this._commentController.commentingRangeProvider = this;
		this._commentController.reactionHandler = this.toggleReaction.bind(this);
		this._localToDispose.push(this._commentController);
		this._commentHandlerId = uuid();
		registerCommentHandler(this._commentHandlerId, this);
	}

	// #region initialize
	async initialize(): Promise<void> {
		this._visibleNormalTextEditors = vscode.window.visibleTextEditors.filter(ed => ed.document.uri.scheme !== 'comment');
		await this.initializeWorkspaceCommentThreads();
		await this.initializeDocumentCommentThreadsAndListeners();
	}

	async initializeWorkspaceCommentThreads(): Promise<void[]> {
		await this._reposManager.activePullRequest!.validateDraftMode();
		const localFileChangePromises = this._localFileChanges.map(async matchedFile => {
			const threadData = await this.getWorkspaceFileThreadDatas(matchedFile);
			this._workspaceFileChangeCommentThreads[matchedFile.fileName] = threadData.map(thread => createVSCodeCommentThread(thread, this._commentController!));
			return;
		});

		const outdatedFileChangePromises = gitFileChangeNodeFilter(this._obsoleteFileChanges).map(fileChange => {
			const threads = this.outdatedCommentsToCommentThreads(fileChange, fileChange.comments).map(thread => createVSCodeCommentThread(thread, this._commentController!));
			this._obsoleteFileChangeCommentThreads[fileChange.fileName] = threads;
			return;
		});

		return Promise.all([...localFileChangePromises, ...outdatedFileChangePromises]);
	}

	private async getWorkspaceFileThreadDatas(matchedFile: GitFileChangeNode): Promise<ThreadData[]> {
		if (!this._reposManager.activePullRequest || !this._reposManager.activePullRequest.isResolved()) {
			return [];
		}

		const contentDiff = await this._repository.diffWithHEAD(matchedFile.fileName);
		const fileComments = mapCommentsToHead(matchedFile.diffHunks, contentDiff, matchedFile.comments)
			.filter(comment => comment.absolutePosition !== undefined);

		return workspaceLocalCommentsToCommentThreads(this._repository, matchedFile, fileComments);
	}

	async initializeDocumentCommentThreadsAndListeners(): Promise<void> {
		this._localToDispose.push(vscode.window.onDidChangeVisibleTextEditors(async visibleTextEditors => {
			if (this.visibleEditorsEqual(this._visibleNormalTextEditors, visibleTextEditors)) {
				return;
			}

			this._visibleNormalTextEditors = visibleTextEditors.filter(ed => ed.document.uri.scheme !== 'comment');
			// remove comment threads in `pr/review` documents if there are no longer visible
			const prEditors = visibleTextEditors.filter(editor => {
				if (editor.document.uri.scheme !== 'pr') {
					return false;
				}

				const params = fromPRUri(editor.document.uri);
				return !!params && params.prNumber === this._reposManager.activePullRequest!.number;
			});

			this._prDocumentCommentThreads.maybeDisposeThreads(prEditors, (editor: vscode.TextEditor, fileName: string, isBase: boolean) => {
				const params = fromPRUri(editor.document.uri);
				return !!params && params.fileName === fileName && params.isBase === isBase;
			});

			this._reviewDocumentCommentThreads.maybeDisposeThreads(visibleTextEditors, (editor: vscode.TextEditor, fileName: string, isBase: boolean) => {
				const editorFileName = this.gitRelativeRootPath(editor.document.uri.path);
				if (editor.document.uri.scheme !== 'review' && editor.document.uri.scheme === this._repository.rootUri.scheme && editor.document.uri.query) {
					const params = fromReviewUri(editor.document.uri);
					if (fileName === editorFileName && params.base === isBase) {
						return true;
					}
				}

				if (editor.document.uri.scheme !== 'review') {
					return false;
				}

				try {
					const params = fromReviewUri(editor.document.uri);
					if (fileName === editorFileName && params.base === isBase) {
						return true;
					}
				} catch {
					return false;
				}

				return false;
			});

			const workspaceDocuments = visibleTextEditors.filter(editor => editor.document.uri.scheme === this._repository.rootUri.scheme);
			workspaceDocuments.forEach(editor => {
				const fileName = this.gitRelativeRootPath(editor.document.uri.path);
				const threadsForEditor = this._workspaceFileChangeCommentThreads[fileName] || [];
				// If the editor has no view column, assume it is part of a diff editor and expand the comments. Otherwise, collapse them.
				const isEmbedded = !editor.viewColumn;
				this._workspaceFileChangeCommentThreads[fileName] = threadsForEditor.map(thread => {
					thread.collapsibleState = isEmbedded && !thread.isResolved
						? vscode.CommentThreadCollapsibleState.Expanded
						: vscode.CommentThreadCollapsibleState.Collapsed;

					return thread;
				});
			});

			for (const editor of this._visibleNormalTextEditors) {
				await this.updateCommentThreadsForEditor(editor);
			}
		}));

		this._localToDispose.push(this._reposManager.activePullRequest!.onDidChangePendingReviewState(newDraftMode => {
			[this._workspaceFileChangeCommentThreads, this._obsoleteFileChangeCommentThreads].forEach(commentThreadMap => {
				for (const fileName in commentThreadMap) {
					commentThreadMap[fileName].forEach(thread => {
						updateCommentReviewState(thread, newDraftMode);
						updateCommentThreadLabel(thread);
					});
				}
			});

			this._reviewDocumentCommentThreads.getDocuments().forEach(fileName => {
				this._reviewDocumentCommentThreads.getAllThreadsForDocument(fileName)!.forEach(thread => {
					updateCommentReviewState(thread, newDraftMode);
					updateCommentThreadLabel(thread);
				});
			});

			this._prDocumentCommentThreads.getDocuments().forEach(fileName => {
				this._prDocumentCommentThreads.getAllThreadsForDocument(fileName)!.forEach(thread => {
					thread.comments = thread.comments.map(comment => {
						comment.label = newDraftMode ? 'Pending' : undefined;
						return comment;
					});
					updateCommentThreadLabel(thread);
				});
			});
		}));
	}

	async updateCommentThreadsForEditor(editor: vscode.TextEditor): Promise<void> {
		if (editor.document.uri.scheme === 'pr') {
			const params = fromPRUri(editor.document.uri);

			if (params && params.prNumber === this._reposManager.activePullRequest!.number) {
				const existingPRThreads = this._prDocumentCommentThreads.getThreadsForDocument(params.fileName, params.isBase);
				if (existingPRThreads) {
					return;
				}

				this._prDocumentCommentThreads.setDocumentThreads(params.fileName, params.isBase, []);

				const matchedFileChanges = this._localFileChanges.filter(localFileChange => localFileChange.fileName === params.fileName);

				if (matchedFileChanges.length) {
					await this._reposManager.activePullRequest!.validateDraftMode();

					const documentComments = getDocumentThreadDatas(editor.document.uri, params.isBase, matchedFileChanges[0], matchedFileChanges[0].comments);
					const newThreads: GHPRCommentThread[] = documentComments.map(thread => createVSCodeCommentThread(thread, this._commentController!));

					this._prDocumentCommentThreads.setDocumentThreads(params.fileName, params.isBase, newThreads);
				}
			}

			return;
		}

		const fileName = this.gitRelativeRootPath(editor.document.uri.path);
		if (editor.document.uri.scheme === this._repository.rootUri.scheme && editor.viewColumn !== undefined) {
			// local files
			const matchedFiles = this._localFileChanges.filter(fileChange => fileChange.fileName === fileName);

			if (matchedFiles && !matchedFiles.length) {
				return;
			}

			const commentThreads = this._workspaceFileChangeCommentThreads[fileName];

			if (!this._reposManager.activePullRequest!.isResolved()) {
				return;
			}

			const contentDiff = await this.getContentDiff(editor.document, fileName);
			mapCommentThreadsToHead(matchedFiles[0].diffHunks, contentDiff, commentThreads);
			return;
		}

		let query: ReviewUriParams | undefined;

		try {
			query = fromReviewUri(editor.document.uri);
		} catch (e) { }

		if (query) {
			if (query.isOutdated) {
				return;
			}

			const existingThreadsForDocument = this._reviewDocumentCommentThreads.getThreadsForDocument(fileName, query.base);
			if (existingThreadsForDocument) {
				return;
			}

			this._reviewDocumentCommentThreads.setDocumentThreads(fileName, query.base, []);

			await this._reposManager.activePullRequest!.validateDraftMode();

			const threadData = this.provideCommentsForReviewUri(editor.document, query);
			const newThreads = threadData.map(thread => createVSCodeCommentThread(thread, this._commentController!));
			this._reviewDocumentCommentThreads.setDocumentThreads(fileName, query.base, newThreads);
		}
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
		if (thread.uri.scheme === 'review') {
			return true;
		}

		if (thread.uri.scheme === 'pr') {
			const params = fromPRUri(thread.uri);
			if (this._reposManager.activePullRequest && params && this._reposManager.activePullRequest.number === params.prNumber) {
				return true;
			} else {
				return false;
			}
		}

		const currentWorkspace = vscode.workspace.getWorkspaceFolder(thread.uri);
		if (!currentWorkspace) {
			return false;
		}

		if ((thread.uri.scheme === currentWorkspace.uri.scheme) && thread.uri.fsPath.startsWith(this._repository.rootUri.fsPath)) {
			return true;
		}

		return false;
	}

	private addToCommentThreadCache(thread: GHPRCommentThread): void {
		const uri = thread.uri;
		const currentWorkspace = vscode.workspace.getWorkspaceFolder(uri)!;
		switch (uri.scheme) {
			case 'pr':
				const params = fromPRUri(uri);
				if (params) {
					const { fileName, isBase } = params;
					const existingThreads = this._prDocumentCommentThreads.getThreadsForDocument(fileName, isBase) || [];
					this._prDocumentCommentThreads.setDocumentThreads(fileName, isBase, existingThreads.concat(thread));
				}
				return;

			case 'review':
				const reviewParams = uri.query && fromReviewUri(uri);
				if (reviewParams) {
					const documentFileName = this.gitRelativeRootPath(uri.path);
					const existingThreads = this._reviewDocumentCommentThreads.getThreadsForDocument(documentFileName, reviewParams.base) || [];
					this._reviewDocumentCommentThreads.setDocumentThreads(documentFileName, reviewParams.base, existingThreads.concat(thread));
					return;
				}

			case currentWorkspace.uri.scheme:
				const workspaceFileName = this.gitRelativeRootPath(uri.path);
				const existingWorkspaceThreads = this._workspaceFileChangeCommentThreads[workspaceFileName];
				existingWorkspaceThreads.push(thread);
				return;

			default:
				return;
		}
	}

	async provideCommentingRanges(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.Range[] | undefined> {
		if (document.uri.scheme === 'pr') {
			const params = fromPRUri(document.uri);

			if (!params || params.prNumber !== this._reposManager.activePullRequest!.number) {
				return;
			}

			const fileChange = this._localFileChanges.find(change => change.fileName === params.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return;
			}

			return getCommentingRanges(fileChange.diffHunks, params.isBase);
		}

		let query: ReviewUriParams | undefined;

		try {
			query = fromReviewUri(document.uri);
		} catch (e) { }

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
			const matchedFile = gitFileChangeNodeFilter(this._localFileChanges).find(fileChange => fileChange.fileName === fileName);
			const ranges = [];

			if (matchedFile) {
				if (matchedFile.status === GitChangeType.RENAME) {
					return [];
				}

				const contentDiff = await this.getContentDiff(document, matchedFile.fileName);
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

	private async getNewCommentPosition(thread: GHPRCommentThread, matchedFile: GitFileChangeNode): Promise<number> {
		const uri = thread.uri;
		let isBase = false;
		if (uri.query) {
			if (uri.scheme === 'review') {
				try {
					isBase = fromReviewUri(uri).base;
				} catch {
					// do nothing
				}
			}

			if (uri.scheme === 'pr') {
				const params = fromPRUri(uri);
				isBase = !!params && params.isBase;
			}
		}

		if (!this._reposManager.activePullRequest) {
			throw new Error('No active pull request');
		}

		if (!this._reposManager.activePullRequest.validatePullRequestModel('Creating new comment failed')) {
			throw new Error('No upstream branch');
		}

		// git diff sha -- fileName
		const contentDiff = await this._repository.diffWithHEAD(matchedFile.fileName);
		const position = mapHeadLineToDiffHunkPosition(matchedFile.diffHunks, contentDiff, thread.range.start.line + 1, isBase);
		// If this is base and the diff line isn't a deletion, then this should actually be created on the right hand side

		if (position < 0) {
			throw new Error('Comment position cannot be negative');
		}

		return position;
	}

	private async createNewThread(thread: GHPRCommentThread, matchedFile: GitFileChangeNode, text: string): Promise<IComment | undefined> {
		const position = await this.getNewCommentPosition(thread, matchedFile);
		// Comments created on 'pr' scheme files (those from the pull request tree) are always against the head commit of the PR.
		// Those on 'review' and 'file' documents are using the local head commit, so may be out of date.
		const headCommit = thread.uri.scheme !== 'pr' ? this._repository.state.HEAD?.commit : undefined;
		return await this._reposManager.activePullRequest!.createReviewComment(text, matchedFile.fileName, position, headCommit);
	}

	private async getContentDiff(document: vscode.TextDocument, fileName: string): Promise<string> {
		let contentDiff: string;

		if (document.isDirty) {
			const headCommitSha = this._repository.state.HEAD!.commit!;
			const documentText = document.getText();
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

	private outdatedCommentsToCommentThreads(fileChange: GitFileChangeNode, fileComments: IComment[]): ThreadData[] {
		if (!fileComments || !fileComments.length) {
			return [];
		}

		const ret: ThreadData[] = [];
		const sections = groupBy(fileComments, comment => String(comment.position));

		for (const i in sections) {
			const comments = sections[i];

			const firstComment = comments[0];
			const diffLine = getDiffLineByPosition(firstComment.diffHunks || [], firstComment.originalPosition!);

			if (diffLine) {
				firstComment.absolutePosition = diffLine.newLineNumber;
			}

			const pos = new vscode.Position(getZeroBased(firstComment.absolutePosition || 0), 0);
			const range = new vscode.Range(pos, pos);

			ret.push({
				threadId: firstComment.id.toString(),
				uri: fileChange.filePath,
				range,
				comments
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

			return workspaceLocalCommentsToCommentThreads(this._repository, matchedFile, matchingComments.filter(comment => comment.absolutePosition !== undefined && comment.absolutePosition > 0)).map(thread => {
				thread.uri = document.uri;
				return thread;
			});
		}

		const matchedObsoleteFile = this.findMatchedFileChangeForReviewDiffView(this._obsoleteFileChanges, document.uri);
		let comments: IComment[] = [];
		if (!matchedObsoleteFile) {
			// The file may be a change from a specific commit, check the comments themselves to see if they match it, as obsolete file changes
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

		const sections = groupBy(comments, comment => String(comment.originalPosition)); // comment.position is null in this case.
		const ret: ThreadData[] = [];
		for (const i in sections) {
			const commentGroup = sections[i];
			const firstComment = commentGroup[0];
			const diffLine = getLastDiffLine(firstComment.diffHunk);
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
				uri: document.uri,
				range,
				comments
			});
		}

		return ret;
	}

	private findMatchedFileChangeForReviewDiffView(fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[], uri: vscode.Uri): GitFileChangeNode | undefined {
		const query = fromReviewUri(uri);
		const matchedFiles = fileChanges.filter(fileChange => {
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
				const q = JSON.parse(fileChange.filePath.query);

				if (q.commit === query.commit) {
					return true;
				}
			} catch (e) { }

			try {
				const q = JSON.parse(fileChange.parentFilePath.query);

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

		if (uri.scheme === 'pr') {
			fileName = fromPRUri(uri)!.fileName;
		}

		const fileChangesToSearch = isOutdated ? this._obsoleteFileChanges : this._localFileChanges;
		const matchedFiles = gitFileChangeNodeFilter(fileChangesToSearch).filter(fileChange => {
			if (uri.scheme === 'review' || uri.scheme === 'pr') {
				return fileChange.fileName === fileName;
			} else {
				return fileChange.filePath.path === uri.path;
			}
		});

		if (matchedFiles && matchedFiles.length) {
			return matchedFiles[0];
		}
	}

	private gitRelativeRootPath(path: string) {
		// get path relative to git root directory. Handles windows path by converting it to unix path.
		return nodePath.relative(this._repository.rootUri.path, path).replace(/\\/g, '/');
	}

	// #endregion

	// #region Review
	public async startReview(thread: GHPRCommentThread, input: string): Promise<void> {
		const temporaryCommentId = this.optimisticallyAddComment(thread, input, true);

		try {
			const matchedFile = this.findMatchedFileByUri(thread.uri);
			if (!matchedFile) {
				throw new Error('No matching file found');
			}

			const position = await this.getNewCommentPosition(thread, matchedFile);

			// Comments created on 'pr' scheme files (those from the pull request tree) are always against the head commit of the PR.
			// Those on 'review' and 'file' documents are using the local head commit, so may be out of date.
			const headCommit = thread.uri.scheme !== 'pr' ? this._repository.state.HEAD?.commit : undefined;
			const comment = await this._reposManager.activePullRequest!.startReview(
				{
					body: input,
					path: matchedFile.fileName,
					position
				},
				headCommit
			);

			thread.threadId = comment.id.toString();
			this.addToCommentThreadCache(thread);
			this.replaceTemporaryComment(thread, comment, temporaryCommentId);
			await this.updateWithNewComment(comment, matchedFile);
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

	public async finishReview(thread: GHPRCommentThread, input: string): Promise<void> {
		try {
			await this.createOrReplyComment(thread, input);
			await this._reposManager.activePullRequest!.submitReview();
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to submit the review: ${e}`);
		}
	}

	private getUpdatedThreads(originalCommentThreads: GHPRCommentThread[], deletedReviewComments: IComment[]): GHPRCommentThread[] {
		const threads: GHPRCommentThread[] = [];
		originalCommentThreads.forEach(thread => {
			thread.comments = thread.comments.filter((comment: GHPRComment) => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId));
			updateCommentThreadLabel(thread);
			if (!thread.comments.length) {
				thread.dispose!();
			} else {
				threads.push(thread);
			}
		});

		return threads;
	}

	async deleteReview(): Promise<void> {
		const { deletedReviewComments } = await this._reposManager.activePullRequest!.deleteReview();

		[this._workspaceFileChangeCommentThreads, this._obsoleteFileChangeCommentThreads].forEach(commentThreadMap => {
			for (const fileName in commentThreadMap) {
				const updatedThreads = this.getUpdatedThreads(commentThreadMap[fileName], deletedReviewComments);

				if (updatedThreads.length) {
					commentThreadMap[fileName] = updatedThreads;
				} else {
					delete commentThreadMap[fileName];
				}
			}
		});

		this._reviewDocumentCommentThreads.getDocuments().forEach(fileName => {
			const originalDocumentThreads = this._reviewDocumentCommentThreads.getThreadsForDocument(fileName, true);
			if (originalDocumentThreads) {
				const updatedThreads = this.getUpdatedThreads(originalDocumentThreads, deletedReviewComments);
				this._reviewDocumentCommentThreads.setDocumentThreads(fileName, true, updatedThreads.length ? updatedThreads : undefined);
			}

			const modifiedDocumentThreads = this._reviewDocumentCommentThreads.getThreadsForDocument(fileName, false);
			if (modifiedDocumentThreads) {
				const updatedThreads = this.getUpdatedThreads(modifiedDocumentThreads, deletedReviewComments);
				this._reviewDocumentCommentThreads.setDocumentThreads(fileName, false, updatedThreads.length ? updatedThreads : undefined);
			}
		});

		this._prDocumentCommentThreads.getDocuments().forEach(fileName => {
			const originalDocumentThreads = this._prDocumentCommentThreads.getThreadsForDocument(fileName, true);
			if (originalDocumentThreads) {
				const updatedThreads = this.getUpdatedThreads(originalDocumentThreads, deletedReviewComments);
				this._prDocumentCommentThreads.setDocumentThreads(fileName, true, updatedThreads.length ? updatedThreads : undefined);
			}

			const modifiedDocumentThreads = this._prDocumentCommentThreads.getThreadsForDocument(fileName, false);
			if (modifiedDocumentThreads) {
				const updatedThreads = this.getUpdatedThreads(modifiedDocumentThreads, deletedReviewComments);
				this._prDocumentCommentThreads.setDocumentThreads(fileName, false, updatedThreads.length ? updatedThreads : undefined);
			}
		});
	}

	// #endregion
	private optimisticallyAddComment(thread: GHPRCommentThread, input: string, inDraft: boolean): number {
		const currentUser = this._reposManager.getCurrentUser(this._reposManager.activePullRequest!);
		const comment = new TemporaryComment(thread, input, inDraft, currentUser);
		this.updateCommentThreadComments(thread, [...thread.comments, comment]);
		return comment.id;
	}

	private updateCommentThreadComments(thread: GHPRCommentThread, newComments: (GHPRComment | TemporaryComment)[]) {
		thread.comments = newComments;
		updateCommentThreadLabel(thread);
	}

	private optimisticallyEditComment(thread: GHPRCommentThread, comment: GHPRComment): number {
		const currentUser = this._reposManager.getCurrentUser(this._reposManager.activePullRequest!);
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

	private async updateWithNewComment(comment: IComment, matchedFile: GitFileChangeNode): Promise<void> {
		matchedFile.update(matchedFile.comments.concat(comment));
		this._comments.push(comment);

		await this.update(this._localFileChanges, this._obsoleteFileChanges);
		this._onDidChangeComments.fire(this._comments);
	}

	// #region Comment
	async createOrReplyComment(thread: GHPRCommentThread, input: string, inDraft?: boolean): Promise<void> {
		const hasExistingComments = thread.comments.length;
		const isDraft = inDraft !== undefined ? inDraft : this._reposManager.activePullRequest!.hasPendingReview;
		const temporaryCommentId = this.optimisticallyAddComment(thread, input, isDraft);

		try {
			const matchedFile = this.findMatchedFileByUri(thread.uri);
			if (!matchedFile) {
				throw new Error(`Cannot find document ${thread.uri.toString()}`);
			}

			let rawComment: IComment | undefined;
			if (!hasExistingComments) {
				rawComment = await this.createNewThread(thread, matchedFile, input);
				thread.threadId = rawComment!.id.toString();
				this.addToCommentThreadCache(thread);
			} else {
				const comment = thread.comments[0];
				if (comment instanceof GHPRComment) {
					rawComment = await this._reposManager.activePullRequest!.createReviewCommentReply(input, comment._rawComment);
				} else {
					throw new Error('Cannot reply to temporary comment');
				}
			}

			this.replaceTemporaryComment(thread, rawComment!, temporaryCommentId);
			this.updateWithNewComment(rawComment!, matchedFile);
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
				if (!this._reposManager.activePullRequest) {
					throw new Error('Unable to find active pull request');
				}

				const matchedFile = this.findMatchedFileByUri(thread.uri);
				if (!matchedFile) {
					throw new Error('Unable to find matching file');
				}

				const editedComment = await this._reposManager.activePullRequest.editReviewComment(comment._rawComment, comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body);

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

	async deleteComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		try {
			if (!this._reposManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			const matchedFile = this.findMatchedFileByUri(thread.uri);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			if (comment instanceof GHPRComment) {
				await this._reposManager.activePullRequest.deleteReviewComment(comment.commentId);
				const matchingCommentIndex = matchedFile.comments.findIndex(c => c.id.toString() === comment.commentId);
				if (matchingCommentIndex > -1) {
					matchedFile.comments.splice(matchingCommentIndex, 1);
					matchedFile.update(matchedFile.comments);
				}

				const indexInAllComments = this._comments.findIndex(c => c.id.toString() === comment.commentId);
				if (indexInAllComments > -1) {
					this._comments.splice(indexInAllComments, 1);
				}

				thread.comments = thread.comments.filter(c => c instanceof GHPRComment && c.commentId !== comment.commentId);
			} else {
				thread.comments = thread.comments.filter(c => c instanceof TemporaryComment && c.id === comment.id);
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

			this.update(this._localFileChanges, this._obsoleteFileChanges);

		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	// #endregion

	// #region Incremental update comments
	public async update(localFileChanges: GitFileChangeNode[], obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[]): Promise<void> {
		await this._reposManager.activePullRequest!.validateDraftMode();
		// _workspaceFileChangeCommentThreads
		for (const fileName in this._workspaceFileChangeCommentThreads) {
			this.updateFileChangeCommentThreads(localFileChanges, fileName, false);
		}

		this._localFileChanges = localFileChanges;

		// _obsoleteFileChangeCommentThreads
		for (const fileName in this._obsoleteFileChangeCommentThreads) {
			this.updateFileChangeCommentThreads(gitFileChangeNodeFilter(obsoleteFileChanges), fileName, true);
		}

		this._obsoleteFileChanges = obsoleteFileChanges;

		// for pr and review document comments, as we dispose them when the editor is being closed, we only need to update for visible editors.
		for (const editor of vscode.window.visibleTextEditors) {
			await this.updateCommentThreadsForEditor(editor);
		}
	}

	private async updateFileChangeCommentThreads(fileChanges: GitFileChangeNode[], fileName: string, forOutdated: boolean): Promise<void> {
		const matchedFile = fileChanges.find(fileChange => fileChange.fileName === fileName);

		if (!matchedFile) {
			this._workspaceFileChangeCommentThreads[fileName].forEach(thread => thread.dispose());
			delete this._workspaceFileChangeCommentThreads[fileName];
		} else {
			const existingCommentThreads = forOutdated
				? this._obsoleteFileChangeCommentThreads[fileName]
				: this._workspaceFileChangeCommentThreads[fileName];

			const newThreads = forOutdated
				? this.outdatedCommentsToCommentThreads(matchedFile, matchedFile.comments)
				: await this.getWorkspaceFileThreadDatas(matchedFile);

			const resultThreads: GHPRCommentThread[] = [];

			newThreads.forEach(thread => {
				const matchedThread = existingCommentThreads.find(existingThread => existingThread.threadId === thread.threadId);

				if (matchedThread) {
					// update
					resultThreads.push(matchedThread);
					matchedThread.range = thread.range;
					matchedThread.comments = thread.comments.map(comment => {
						return new GHPRComment(comment, matchedThread);
					});
					updateCommentThreadLabel(matchedThread);
				} else {
					// create new thread
					resultThreads.push(createVSCodeCommentThread(thread, this._commentController!));
				}
			});

			existingCommentThreads.forEach(existingThread => {
				const matchedThread = newThreads.filter(thread => thread.threadId === existingThread.threadId);

				if (!matchedThread) {
					existingThread.dispose();
				}
			});

			this._workspaceFileChangeCommentThreads[fileName] = resultThreads;
		}
	}
	// #endregion

	// #region Reactions
	async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		try {
			if (!this._reposManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			const matchedFile = this.findMatchedFileByUri(comment.parent!.uri);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			let reactionGroups: ReactionGroup[] = [];
			if (comment.reactions && !comment.reactions.find(ret => ret.label === reaction.label && !!ret.authorHasReacted)) {
				const result = await this._reposManager.activePullRequest.addCommentReaction(comment._rawComment.graphNodeId, reaction);
				reactionGroups = result.addReaction.subject.reactionGroups;
			} else {
				const result = await this._reposManager.activePullRequest.deleteCommentReaction(comment._rawComment.graphNodeId, reaction);
				reactionGroups = result.removeReaction.subject.reactionGroups;
			}

			// Update the cached comments of the file
			const matchingCommentIndex = matchedFile.comments.findIndex(c => c.id.toString() === comment.commentId);
			if (matchingCommentIndex > -1) {
				const editedComment = matchedFile.comments[matchingCommentIndex];
				editedComment.reactions = parseGraphQLReaction(reactionGroups);
				const vscodeCommentReactions = generateCommentReactions(editedComment.reactions);
				const fileName = matchedFile.fileName;
				const modifiedThreads = [
					...(this._prDocumentCommentThreads.getAllThreadsForDocument(fileName) || []),
					...(this._reviewDocumentCommentThreads.getAllThreadsForDocument(fileName) || []),
					...(this._workspaceFileChangeCommentThreads[fileName] || []),
					...(this._obsoleteFileChangeCommentThreads[fileName] || [])
				].filter(td => !!td.comments.find((cmt: GHPRComment) => cmt.commentId === comment.commentId));

				modifiedThreads.forEach(thread => {
					thread.comments = thread.comments.map((cmt: GHPRComment) => {
						if (cmt.commentId === comment.commentId) {
							cmt.reactions = vscodeCommentReactions;
						}

						return cmt;
					});
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

		unregisterCommentHandler(this._commentHandlerId);

		this._localToDispose.forEach(d => d.dispose());
	}
}
