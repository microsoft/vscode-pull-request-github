/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { parseDiff } from '../../common/diffHunk';
import { mapHeadLineToDiffHunkPosition, getZeroBased, getAbsolutePosition, getPositionInDiff } from '../../common/diffPositionMapping';
import { SlimFileChange } from '../../common/file';
import Logger from '../../common/logger';
import { Repository } from '../../common/repository';
import { Resource } from '../../common/resources';
import { toPRUri, fromPRUri } from '../../common/uri';
import { groupBy, formatError } from '../../common/utils';
import { IPullRequestManager, IPullRequestModel } from '../../github/interface';
import { DescriptionNode } from './descriptionNode';
import { FileChangeNode, RemoteFileChangeNode } from './fileChangeNode';
import { TreeNode } from './treeNode';

export function providePRDocumentComments(
	document: vscode.TextDocument,
	prNumber: number,
	fileChanges: (RemoteFileChangeNode | FileChangeNode)[]) {
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

		const comment = comments[0];
		let commentAbsolutePosition = fileChange.isPartial
			? getPositionInDiff(comment, fileChange.diffHunks, isBase)
			: getAbsolutePosition(comment, fileChange.diffHunks, isBase);

		if (commentAbsolutePosition < 0) {
			continue;
		}

		const pos = new vscode.Position(getZeroBased(commentAbsolutePosition), 0);
		const range = new vscode.Range(pos, pos);

		threads.push({
			threadId: comment.id,
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

export class PRNode extends TreeNode {
	private _contentChanges: (RemoteFileChangeNode | FileChangeNode)[];
	private _documentCommentsProvider: vscode.Disposable;

	constructor(
		private _prManager: IPullRequestManager,
		private repository: Repository,
		public pullRequestModel: IPullRequestModel,
		private _isLocal: boolean
	) {
		super();
		this._documentCommentsProvider = null;
	}

	async getChildren(): Promise<TreeNode[]> {
		try {
			if (this._documentCommentsProvider) {
				this._documentCommentsProvider.dispose();
			}

			if (this.childrenDisposables && this.childrenDisposables.length) {
				this.childrenDisposables.forEach(dp => dp.dispose());
			}

			const comments = await this._prManager.getPullRequestComments(this.pullRequestModel);
			const data = await this._prManager.getPullRequestChangedFiles(this.pullRequestModel);
			await this._prManager.fullfillPullRequestCommitInfo(this.pullRequestModel);
			let mergeBase = await this._prManager.getPullRequestMergeBase(this.pullRequestModel);
			const rawChanges = await parseDiff(data, this.repository, mergeBase || this.pullRequestModel.base.sha);
			this._contentChanges = rawChanges.map(change => {
				if (change instanceof SlimFileChange) {
					return new RemoteFileChangeNode(
						this.pullRequestModel,
						change.status,
						change.fileName,
						change.blobUrl
					);
				}
				let fileInRepo = path.resolve(this.repository.path, change.fileName);
				let changedItem = new FileChangeNode(
					this.pullRequestModel,
					change.status,
					change.fileName,
					change.blobUrl,
					toPRUri(vscode.Uri.file(change.filePath), this.pullRequestModel, fileInRepo, change.fileName, false),
					toPRUri(vscode.Uri.file(change.originalFilePath), this.pullRequestModel, fileInRepo, change.fileName, true),
					change.isPartial,
					change.diffHunks,
					comments.filter(comment => comment.path === change.fileName && comment.position !== null)
				);
				return changedItem;
			});

			// The review manager will register a document comment's provider, so the node does not need to
			if (!this.pullRequestModel.equals(this._prManager.activePullRequest)) {
				const _onDidChangeCommentThreads = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();
				this._documentCommentsProvider = vscode.workspace.registerDocumentCommentProvider({
					onDidChangeCommentThreads: _onDidChangeCommentThreads.event,
					provideDocumentComments: this.provideDocumentComments.bind(this),
					createNewCommentThread: this.createNewCommentThread.bind(this),
					replyToCommentThread: this.replyToCommentThread.bind(this)
				});
			}

			let result = [new DescriptionNode('Description', {
				light: Resource.icons.light.Description,
				dark: Resource.icons.dark.Description
			}, this.pullRequestModel), ...this._contentChanges];

			this.childrenDisposables = result;
			return result;
		} catch (e) {
			Logger.appendLine(e);
		}
	}

	getTreeItem(): vscode.TreeItem {
		let currentBranchIsForThisPR = this.pullRequestModel.equals(this._prManager.activePullRequest);
		return {
			label: (currentBranchIsForThisPR ? ' * ' : '') + this.pullRequestModel.title,
			tooltip: (currentBranchIsForThisPR ? 'Current Branch * ' : '') + this.pullRequestModel.title,
			collapsibleState: 1,
			contextValue: 'pullrequest' + (this._isLocal ? ':local' : '') + (currentBranchIsForThisPR ? ':active' : ':nonactive'),
			iconPath: this.pullRequestModel.userAvatarUri
		};
	}

	private async createNewCommentThread(document: vscode.TextDocument, range: vscode.Range, text: string) {
		try {
			let uri = document.uri;
			let params = fromPRUri(uri);

			if (params.prNumber !== this.pullRequestModel.prNumber) {
				return null;
			}

			let fileChange = this._contentChanges.find(change => change.fileName === params.fileName);

			if (!fileChange) {
				throw new Error('No matching file found');
			}

			if (fileChange instanceof RemoteFileChangeNode) {
				throw new Error('Cannot add comment to this file')
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
	};

	private async replyToCommentThread(document: vscode.TextDocument, _range: vscode.Range, thread: vscode.CommentThread, text: string) {
		try {
			const uri = document.uri;
			const params = JSON.parse(uri.query);
			const fileChange = this._contentChanges.find(change => change.fileName === params.fileName);

			if (!fileChange) {
				throw new Error('No matching file found');
			}

			if (fileChange instanceof RemoteFileChangeNode) {
				throw new Error('Cannot add comment to this file')
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
	};

	private async provideDocumentComments(document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<vscode.CommentInfo> {
		if (document.uri.scheme === 'pr') {
			return providePRDocumentComments(document, this.pullRequestModel.prNumber, this._contentChanges);
		}

		return null;
	}

	dispose(): void {
		super.dispose();

		if (this._documentCommentsProvider) {
			this._documentCommentsProvider.dispose();
		}
	}
}