/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { Comment, GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import { v4 as uuid } from 'uuid';
import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../../azdo/folderRepositoryManager';
import { CommentPermissions, CommentWithPermissions } from '../../azdo/interface';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../../azdo/prComment';
import { PullRequestModel } from '../../azdo/pullRequestModel';
import {
	CommentReactionHandler,
	createVSCodeCommentThread,
	getPositionFromThread,
	removeLeadingSlash,
	updateCommentReviewState,
} from '../../azdo/utils';
import { CommentHandler, registerCommentHandler, unregisterCommentHandler } from '../../commentHandlerResolver';
import { mapThreadsToBase } from '../../common/commentingRanges';
import { CommonCommentHandler } from '../../common/commonCommentHandler';
import { parseDiffAzdo } from '../../common/diffHunk';
import { getZeroBased } from '../../common/diffPositionMapping';
import { GitChangeType, SlimFileChange } from '../../common/file';
import Logger from '../../common/logger';
import { fromPRUri, toPRUriAzdo } from '../../common/uri';
import { uniqBy } from '../../common/utils';
import { SETTINGS_NAMESPACE, URI_SCHEME_PR, URI_SCHEME_RESOURCE } from '../../constants';
import { getInMemPRContentProvider } from '../inMemPRContentProvider';
import { DescriptionNode } from './descriptionNode';
import { DirectoryTreeNode } from './directoryTreeNode';
import { GitFileChangeNode, InMemFileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { TreeNode, TreeNodeParent } from './treeNode';

/**
 * Thread data is raw data. It should be transformed to GHPRCommentThreads
 * before being sent to VSCode.
 */
export interface ThreadData {
	threadId: number;
	uri: vscode.Uri;
	range: vscode.Range;
	comments: CommentWithPermissions[];
	collapsibleState: vscode.CommentThreadCollapsibleState;
	rawThread: GitPullRequestCommentThread;
}

export function getDocumentThreadDatas(
	uri: vscode.Uri,
	isBase: boolean,
	fileChange: RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode,
	matchingComments: GitPullRequestCommentThread[],
	getCommentPermission: (comment: Comment) => CommentPermissions,
): ThreadData[] {
	if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
		return [];
	}

	const threads: ThreadData[] = [];

	const commentsPerBase = mapThreadsToBase(matchingComments, isBase);

	for (const azdoThread of commentsPerBase) {
		const commentAbsolutePosition = getPositionFromThread(azdoThread);

		if (!commentAbsolutePosition || commentAbsolutePosition < 0) {
			continue;
		}

		const pos = new vscode.Position(getZeroBased(commentAbsolutePosition), 0);
		const range = new vscode.Range(pos, pos);

		threads.push({
			threadId: azdoThread.id!,
			uri: uri,
			range,
			comments:
				azdoThread.comments?.map(c => {
					return { comment: c, commentPermissions: getCommentPermission(c) };
				}) ?? [],
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
			rawThread: azdoThread,
		});
	}

	return threads;
}

export class PRNode extends TreeNode implements CommentHandler, vscode.CommentingRangeProvider, CommentReactionHandler {
	static ID = 'PRNode';

	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[] | undefined;
	private _commentController?: vscode.CommentController;
	private _commonCommentHandler: CommonCommentHandler;
	public get commentController(): vscode.CommentController | undefined {
		return this._commentController;
	}

	private _prCommentController?: vscode.Disposable & { commentThreadCache: { [key: string]: GHPRCommentThread[] } };
	private _disposables: vscode.Disposable[] = [];

	private _inMemPRContentProvider?: vscode.Disposable;

	private _refreshCommentsInProgress?: Promise<void>;

	private _command: vscode.Command;

	private _commentHandlerId: string;

	public get command(): vscode.Command {
		return this._command;
	}

	public set command(newCommand: vscode.Command) {
		this._command = newCommand;
	}

	constructor(
		public parent: TreeNodeParent,
		private _folderReposManager: FolderRepositoryManager,
		public pullRequestModel: PullRequestModel,
		private _isLocal: boolean,
	) {
		super();
		this._commentHandlerId = uuid();
		this._commonCommentHandler = new CommonCommentHandler(pullRequestModel, _folderReposManager);
		registerCommentHandler(this._commentHandlerId, this);
	}

	// #region Tree
	async getChildren(): Promise<TreeNode[]> {
		Logger.debug(`Fetch children of PRNode #${this.pullRequestModel.getPullRequestId()}`, PRNode.ID);
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
			await this.pullRequestModel.getPullRequestFileViewState();

			if (!this._inMemPRContentProvider) {
				this._inMemPRContentProvider = getInMemPRContentProvider().registerTextDocumentContentProvider(
					this.pullRequestModel.getPullRequestId(),
					this.provideDocumentContent.bind(this),
				);
			}

			// The review manager will register a document comment's controller, so the node does not need to
			if (!this.pullRequestModel.equals(this._folderReposManager.activePullRequest)) {
				if (!this._prCommentController || !this._commentController) {
					await this.resolvePRCommentController();
				}

				await this.refreshExistingPREditors(vscode.window.visibleTextEditors, true);
				//await this.pullRequestModel.validateDraftMode();
				await this.refreshContextKey(vscode.window.activeTextEditor);
			} else {
				await this.pullRequestModel.azdoRepository.ensureCommentsController();
				this.pullRequestModel.azdoRepository.commentsHandler!.clearCommentThreadCache(
					this.pullRequestModel.getPullRequestId(),
				);
			}

			const result: TreeNode[] = [descriptionNode];
			const layout = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE).get<string>('fileListLayout');
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

		await this.pullRequestModel.azdoRepository.ensureCommentsController();
		this._commentController = this.pullRequestModel.azdoRepository.commentsController!;
		this._prCommentController = this.pullRequestModel.azdoRepository.commentsHandler!.registerCommentController(
			this.pullRequestModel.getPullRequestId(),
			this,
		);

		this.registerListeners();

		return this._prCommentController;
	}

	private registerListeners(): void {
		this._disposables.push(
			this.pullRequestModel.onDidChangePendingReviewState(async newDraftMode => {
				// if (!newDraftMode) {
				// 	(await this.getFileChanges()).forEach(fileChange => {
				// 		if (fileChange instanceof InMemFileChangeNode) {
				// 			fileChange.comments.forEach(c => c.isDraft = newDraftMode);
				// 		}
				// 	});
				// }

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
				// Create Comment Threads when the editor is visible
				// Dispose when the editor is invisible and remove them from the cache map
				// Comment Threads in cache map is updated only when users trigger refresh
				if (!this._refreshCommentsInProgress) {
					this._refreshCommentsInProgress = this.refreshExistingPREditors(e, false);
				} else {
					this._refreshCommentsInProgress = this._refreshCommentsInProgress.then(async _ => {
						return await this.refreshExistingPREditors(e, false);
					});
				}
			}),
		);

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

		const comments = (await this.pullRequestModel.getAllActiveThreadsBetweenAllIterations()) ?? [];
		const data = await this.pullRequestModel.getFileChangesInfo();

		// TODO Which is the correct diff to show from source HEAD - merge-base or target HEAD
		// Merge base is set as part of getPullRequestFileChangesInfo
		const mergeBase = this.pullRequestModel.getDiffTarget();
		if (!mergeBase) {
			return [];
		}

		const rawChanges = await parseDiffAzdo(data, this._folderReposManager.repository, mergeBase);

		return rawChanges.map(change => {
			const headCommit = this.pullRequestModel.head!.sha;
			let fileName = change.fileName;
			let parentFileName = change.previousFileName!;
			let sha = change.fileSHA;

			if (change.status === GitChangeType.DELETE) {
				fileName = change.previousFileName!; // filename is empty. Used as "label" in treenode
				parentFileName = change.previousFileName!;
				sha = change.previousFileSHA;
			}

			if (change instanceof SlimFileChange) {
				return new RemoteFileChangeNode(
					this,
					this.pullRequestModel,
					change.status,
					fileName,
					change.previousFileName,
					change.blobUrl,
					toPRUriAzdo(
						vscode.Uri.file(
							path.resolve(this._folderReposManager.repository.rootUri.fsPath, removeLeadingSlash(fileName)),
						),
						this.pullRequestModel,
						change.baseCommit,
						headCommit,
						fileName,
						false,
						change.status,
					),
					toPRUriAzdo(
						vscode.Uri.file(
							path.resolve(
								this._folderReposManager.repository.rootUri.fsPath,
								removeLeadingSlash(parentFileName),
							),
						),
						this.pullRequestModel,
						change.baseCommit,
						headCommit,
						parentFileName,
						true,
						change.status,
					),
					sha,
				);
			}

			const changedItem = new InMemFileChangeNode(
				this,
				this.pullRequestModel,
				change.status,
				fileName,
				change.previousFileName,
				change.blobUrl,
				toPRUriAzdo(
					vscode.Uri.file(
						path.resolve(this._folderReposManager.repository.rootUri.fsPath, removeLeadingSlash(fileName)),
					),
					this.pullRequestModel,
					change.baseCommit,
					headCommit,
					fileName,
					false,
					change.status,
				),
				toPRUriAzdo(
					vscode.Uri.file(
						path.resolve(this._folderReposManager.repository.rootUri.fsPath, removeLeadingSlash(parentFileName)),
					),
					this.pullRequestModel,
					change.baseCommit,
					headCommit,
					parentFileName,
					true,
					change.status,
				),
				change.isPartial,
				change.patch,
				change.diffHunks,
				comments.filter(comment => comment.threadContext?.filePath === fileName && !!getPositionFromThread(comment)),
				sha,
			);

			return changedItem;
		});
	}

	async refreshExistingPREditors(editors: vscode.TextEditor[], incremental: boolean): Promise<void> {
		let currentPRDocuments = editors
			.filter(editor => {
				if (editor.document.uri.scheme !== URI_SCHEME_PR) {
					return false;
				}

				const params = fromPRUri(editor.document.uri);

				if (!params || params.prNumber !== this.pullRequestModel.getPullRequestId()) {
					return false;
				}

				return true;
			})
			.map(editor => {
				return {
					fileName: fromPRUri(editor.document.uri)!.fileName,
					document: editor.document,
				};
			});

		const commentThreadCache = (await this.resolvePRCommentController()).commentThreadCache;

		for (const fileName in commentThreadCache) {
			const commentThreads = commentThreadCache[fileName];

			const matchedEditor = currentPRDocuments.find(editor => editor.fileName === fileName);

			if (!matchedEditor) {
				commentThreads.forEach(thread => thread.dispose!());
				delete commentThreadCache[fileName];
			}
		}

		if (!incremental) {
			// it's triggered by file opening, so we only take care newly opened documents.
			currentPRDocuments = currentPRDocuments.filter(editor => commentThreadCache[editor.fileName] === undefined);
		}

		currentPRDocuments = uniqBy(currentPRDocuments, editor => editor.fileName);

		if (currentPRDocuments.length) {
			const fileChanges = await this.getFileChanges();
			// await this.pullRequestModel.validateDraftMode();
			currentPRDocuments.forEach(editor => {
				const fileChange = fileChanges.find(fc => fc.fileName === editor.fileName);

				if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
					return;
				}

				const parentFilePath = fileChange.parentFilePath;
				const filePath = fileChange.filePath;

				const newLeftCommentThreads = getDocumentThreadDatas(
					parentFilePath,
					true,
					fileChange,
					fileChange.comments,
					this.pullRequestModel.getCommentPermission.bind(this.pullRequestModel),
				);
				const newRightSideCommentThreads = getDocumentThreadDatas(
					filePath,
					false,
					fileChange,
					fileChange.comments,
					this.pullRequestModel.getCommentPermission.bind(this.pullRequestModel),
				);

				let oldCommentThreads: GHPRCommentThread[] = [];

				if (incremental) {
					const cachedThreads = commentThreadCache[editor.fileName] || [];
					const oldLeftSideCommentThreads = cachedThreads.filter(
						thread => thread.uri.toString() === parentFilePath.toString(),
					);
					const oldRightSideCommentThreads = cachedThreads.filter(
						thread => thread.uri.toString() === filePath.toString(),
					);

					oldCommentThreads = [...oldLeftSideCommentThreads, ...oldRightSideCommentThreads];
				}

				this.updateFileChangeCommentThreads(
					oldCommentThreads,
					[...newLeftCommentThreads, ...newRightSideCommentThreads],
					fileChange,
					commentThreadCache,
				);
			});
		}
	}

	private async refreshContextKey(editor: vscode.TextEditor | undefined) {
		if (!editor) {
			return;
		}

		const editorUri = editor.document.uri;
		if (editorUri.scheme !== URI_SCHEME_PR) {
			return;
		}

		const params = fromPRUri(editorUri);
		if (!params || params.prNumber !== this.pullRequestModel.getPullRequestId()) {
			return;
		}

		this.setContextKey(this.pullRequestModel.hasPendingReview);
	}

	private setContextKey(inDraftMode: boolean): void {
		vscode.commands.executeCommand('setContext', 'prInDraft', inDraftMode);
	}

	getTreeItem(): vscode.TreeItem {
		const currentBranchIsForThisPR = this.pullRequestModel.equals(this._folderReposManager.activePullRequest);

		const { isDraft } = this.pullRequestModel;
		const title = this.pullRequestModel.item.title;
		const number = this.pullRequestModel.getPullRequestId();
		const html_url = this.pullRequestModel.url;
		const login = this.pullRequestModel.item.createdBy?.uniqueName;

		const labelPrefix = currentBranchIsForThisPR ? '✓ ' : '';
		const tooltipPrefix = currentBranchIsForThisPR ? 'Current Branch * ' : '';
		const formattedPRNumber = number.toString();
		const label = `${labelPrefix}#${formattedPRNumber}: ${isDraft ? '[DRAFT] ' : ''}${title}`;
		const tooltip = `${tooltipPrefix}${title} by ${login}`;
		const description = `#${formattedPRNumber} by ${login}`;

		return {
			label,
			id: `${this.parent instanceof TreeNode ? this.parent.label : ''}${html_url}`, // unique id stable across checkout status
			tooltip,
			description,
			collapsibleState: 1,
			contextValue:
				'pullrequest' + (this._isLocal ? ':local' : '') + (currentBranchIsForThisPR ? ':active' : ':nonactive'),
			iconPath: this.pullRequestModel.item.createdBy?.imageUrl
				? this.pullRequestModel.item.createdBy?.imageUrl
				: new vscode.ThemeIcon('github'),
		};
	}

	// #endregion

	// #region Helper
	hasCommentThread(thread: vscode.CommentThread): boolean {
		if (thread.uri.scheme !== URI_SCHEME_PR) {
			return false;
		}

		if (
			this._folderReposManager.activePullRequest &&
			this._folderReposManager.activePullRequest.getPullRequestId() === this.pullRequestModel.getPullRequestId()
		) {
			return false;
		}

		const params = fromPRUri(thread.uri);

		if (!params || params.prNumber !== this.pullRequestModel.getPullRequestId()) {
			return false;
		}

		return true;
	}

	private createCommentThreads(
		fileName: string,
		commentThreads: ThreadData[],
		commentThreadCache: { [key: string]: GHPRCommentThread[] },
	) {
		const threads = commentThreads.map(thread => createVSCodeCommentThread(thread, this._commentController!));
		commentThreadCache[fileName] = threads;
	}

	// #endregion

	async provideCommentingRanges(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<vscode.Range[] | undefined> {
		return await this._commonCommentHandler.provideCommentingRanges(
			document,
			token,
			async () => await this.getFileChanges(),
		);
	}

	// #endregion

	// #region Incremental updates
	private updateFileChangeCommentThreads(
		oldCommentThreads: GHPRCommentThread[],
		newCommentThreads: ThreadData[],
		newFileChange: InMemFileChangeNode,
		commentThreadCache: { [key: string]: GHPRCommentThread[] },
	) {
		// remove
		oldCommentThreads.forEach(thread => {
			// No current threads match old thread, it has been removed
			const matchingThreads =
				newCommentThreads && newCommentThreads.filter(newThread => newThread.threadId === thread.threadId);
			if (!matchingThreads.length) {
				thread.dispose!();
			}
		});

		if (newCommentThreads && newCommentThreads.length) {
			const added: ThreadData[] = [];
			newCommentThreads.forEach(thread => {
				const matchingCommentThreads = oldCommentThreads.filter(oldComment => oldComment.threadId === thread.threadId);

				if (matchingCommentThreads.length === 0) {
					added.push(thread);
					if (thread.uri.scheme === URI_SCHEME_RESOURCE) {
						thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
					}
				}

				matchingCommentThreads.forEach(existingThread => {
					existingThread.comments = existingThread.comments
						.map(cmt => {
							if (cmt instanceof TemporaryComment) {
								// If the body of the temporary comment already matches the comment, then replace it.
								// Otherwise, retain the temporary comment.
								const matchingComment = thread.comments.find(c => c.comment.content === cmt.body);
								if (matchingComment) {
									return new GHPRComment(
										matchingComment.comment,
										matchingComment.commentPermissions,
										existingThread,
									);
								}

								return cmt;
							}

							// Update existing comments
							const matchedComment = thread.comments.find(c => c.comment.id?.toString() === cmt.commentId);
							if (matchedComment) {
								return new GHPRComment(
									matchedComment.comment,
									matchedComment.commentPermissions,
									existingThread,
								);
							}

							// Remove comments that are no longer present
							return undefined;
						})
						.filter((c: TemporaryComment | GHPRComment | undefined): c is GHPRComment | TemporaryComment => !!c);

					const addedComments = thread.comments.filter(
						cmt =>
							!existingThread.comments.some(
								existingComment =>
									existingComment instanceof GHPRComment &&
									existingComment.commentId === cmt.comment.id?.toString(),
							),
					);
					existingThread.comments = [
						...existingThread.comments,
						...addedComments.map(
							comment => new GHPRComment(comment.comment, comment.commentPermissions, existingThread),
						),
					];
				});
			});

			if (added.length) {
				this.createCommentThreads(newFileChange.fileName, added, commentThreadCache);
			}
		}
	}

	// #endregion

	// #region Document Content Provider
	private async provideDocumentContent(uri: vscode.Uri): Promise<string> {
		const params = fromPRUri(uri);
		if (!params) {
			return '';
		}

		const allFileChanges = await this.getFileChanges();
		const fileChange = allFileChanges.find(contentChange => contentChange.fileName === params.fileName);
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
				return this.pullRequestModel.getFile(fileChange.sha!);
			} catch (e) {
				Logger.appendLine(`PR> Fetching file content failed: ${e}`);
				vscode.window
					.showWarningMessage(
						'Opening this file locally failed. Would you like to view it on GitHub?',
						'Open in GitHub',
					)
					.then(result => {
						if (result === 'Open in GitHub') {
							vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(fileChange.blobUrl));
						}
					});
				return '';
			}
		}

		if (fileChange instanceof InMemFileChangeNode) {
			if (fileChange.status === GitChangeType.ADD) {
				const originalFileName = fileChange.fileName;
				const originalFilePath = vscode.Uri.joinPath(this._folderReposManager.repository.rootUri, originalFileName!);
				const commit = params.headCommit;
				const originalContent = await this._folderReposManager.repository.show(commit, originalFilePath.fsPath);
				return originalContent;
			} else if (fileChange.status === GitChangeType.RENAME) {
				let commit = params.baseCommit;
				let originalFileName = fileChange.previousFileName;
				if (!params.isBase) {
					commit = params.headCommit;
					originalFileName = fileChange.fileName;
				}

				const originalFilePath = vscode.Uri.joinPath(this._folderReposManager.repository.rootUri, originalFileName!);
				const originalContent = await this._folderReposManager.repository.show(commit, originalFilePath.fsPath);
				return originalContent;
			} else {
				const originalFileName =
					fileChange.status === GitChangeType.DELETE ? fileChange.previousFileName : fileChange.fileName;
				const originalFilePath = vscode.Uri.joinPath(this._folderReposManager.repository.rootUri, originalFileName!);
				let commit = params.baseCommit;
				if (!params.isBase) {
					commit = params.headCommit;
				}
				const originalContent = await this._folderReposManager.repository.show(commit, originalFilePath.fsPath);
				return originalContent;
				// if (params.isBase) {
				// 	return originalContent;
				// } else {
				// 	return getModifiedContentFromDiffHunkAzdo(originalContent, fileChange.diffHunks);
				// }
			}
		}

		return '';
	}

	// #endregion

	// #region comment
	public async createOrReplyComment(thread: GHPRCommentThread, input: string, inDraft?: boolean) {
		await this._commonCommentHandler.createOrReplyComment(
			thread,
			input,
			inDraft ?? false,
			async _ => await this.getFileChanges(),
			async (rawThread, fileName) => await this.updateCommentThreadCache(rawThread, fileName),
		);
	}

	public async changeThreadStatus(thread: GHPRCommentThread): Promise<void> {
		await this._commonCommentHandler.changeThreadStatus(thread);
	}

	private async updateCommentThreadCache(thread: GHPRCommentThread, fileName: string): Promise<void> {
		const commentThreadCache = (await this.resolvePRCommentController()).commentThreadCache;
		const existingThreads = commentThreadCache[fileName];
		if (existingThreads) {
			commentThreadCache[fileName] = [...existingThreads, thread];
		} else {
			commentThreadCache[fileName] = [thread];
		}
	}

	public async editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			await this._commonCommentHandler.editComment(thread, comment, async _ => await this.getFileChanges());
		} else {
			this.createOrReplyComment(
				thread,
				comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body,
			);
		}
	}

	// public async deleteComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
	// 	if (comment instanceof GHPRComment) {
	// 		await this.pullRequestModel.deleteReviewComment(comment.commentId);
	// 		const fileChange = await this.findMatchingFileNode(thread.uri);
	// 		const index = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
	// 		if (index > -1) {
	// 			fileChange.comments.splice(index, 1);
	// 		}

	// 		thread.comments = thread.comments.filter(c => c instanceof GHPRComment && c.commentId !== comment.commentId);

	// 		if (thread.comments.length === 0) {
	// 			const rawComment = comment._rawComment;

	// 			if (rawComment.path) {
	// 				const commentThreadCache = (await this.resolvePRCommentController()).commentThreadCache;
	// 				const threadIndex = commentThreadCache[rawComment.path].findIndex(cachedThread => cachedThread.threadId === thread.threadId);
	// 				commentThreadCache[rawComment.path].splice(threadIndex, 1);
	// 			}

	// 			thread.dispose!();
	// 		}

	// 		if (fileChange.comments.length === 0) {
	// 			fileChange.update(fileChange.comments);
	// 		}
	// 	} else {
	// 		thread.comments = thread.comments.filter(c => c instanceof TemporaryComment && c.id === comment.id);
	// 	}

	// 	await this.pullRequestModel.validateDraftMode();
	// }
	// #endregion

	// #region Reaction
	async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		// if (comment.parent!.uri.scheme !== 'pr') {
		// 	return;
		// }
		// const params = fromPRUri(comment.parent!.uri);
		// if (!params) {
		// 	return;
		// }
		// const fileChange = await this.findMatchingFileNode(comment.parent!.uri);
		// const commentIndex = fileChange.comments.findIndex(c => c.id.toString() === comment.commentId);
		// if (commentIndex < 0) {
		// 	return;
		// }
		// let reactionGroups: ReactionGroup[];
		// if (comment.reactions && !comment.reactions.find(ret => ret.label === reaction.label && !!ret.authorHasReacted)) {
		// 	// add reaction
		// 	const result = await this.pullRequestModel.addCommentReaction(comment._rawComment.graphNodeId, reaction);
		// 	reactionGroups = result.addReaction.subject.reactionGroups;
		// } else {
		// 	const result = await this.pullRequestModel.deleteCommentReaction(comment._rawComment.graphNodeId, reaction);
		// 	reactionGroups = result.removeReaction.subject.reactionGroups;
		// }
		// fileChange.comments[commentIndex].reactions = parseGraphQLReaction(reactionGroups);
		// updateCommentReactions(comment, fileChange.comments[commentIndex].reactions!);
		// const commentThreadCache = (await this.resolvePRCommentController()).commentThreadCache;
		// if (commentThreadCache[params.fileName]) {
		// 	commentThreadCache[params.fileName].forEach(thread => {
		// 		if (!thread.comments) {
		// 			return;
		// 		}
		// 		if (thread.comments.find((cmt: GHPRComment) => cmt.commentId === comment.commentId)) {
		// 			// The following line is necessary to refresh the comments thread UI
		// 			// Read more: https://github.com/microsoft/vscode-pull-request-github/issues/1421#issuecomment-546995347
		// 			thread.comments = thread.comments;
		// 		}
		// 	});
		// }
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
