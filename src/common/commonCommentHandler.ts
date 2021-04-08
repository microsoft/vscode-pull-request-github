/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
import { Comment, CommentThreadStatus, GitPullRequestCommentThread } from 'azure-devops-node-api/interfaces/GitInterfaces';
import * as vscode from 'vscode';
import { FolderRepositoryManager } from '../azdo/folderRepositoryManager';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../azdo/prComment';
import { PullRequestModel } from '../azdo/pullRequestModel';
import { getCommentThreadStatusKeys, updateCommentThreadLabel } from '../azdo/utils';
import { URI_SCHEME_PR, URI_SCHEME_REVIEW } from '../constants';
import {
	GitFileChangeNode,
	gitFileChangeNodeFilter,
	InMemFileChangeNode,
	RemoteFileChangeNode,
} from '../view/treeNodes/fileChangeNode';
import { getCommentingRanges } from './commentingRanges';
import Logger from './logger';
import { fromPRUri, fromReviewUri } from './uri';

export class CommonCommentHandler {
	constructor(public pullRequestModel: PullRequestModel, private _folderReposManager: FolderRepositoryManager) {}

	public async createOrReplyComment(
		thread: GHPRCommentThread,
		input: string,
		inDraft: boolean,
		getFileChanges: (isOutdated: boolean) => Promise<(InMemFileChangeNode | RemoteFileChangeNode | GitFileChangeNode)[]>,
		addCommentToCache: (thread: GHPRCommentThread, fileName: string) => Promise<void>,
	): Promise<GitPullRequestCommentThread | undefined> {
		const hasExistingComments = thread.comments.length;
		const isDraft = inDraft !== undefined ? inDraft : this.pullRequestModel.hasPendingReview;
		const temporaryCommentId = this.optimisticallyAddComment(thread, input, isDraft);

		try {
			const fileChange = await this.findMatchingFileNode(thread.uri, getFileChanges);

			let rawThread: GitPullRequestCommentThread = thread.rawThread;
			let rawComment: Comment | undefined;
			if (!hasExistingComments) {
				let isLeft = this.isFileLeft(thread.uri);
				rawThread = (await this.createNewThread(thread, input, fileChange, isLeft))!;
				thread.threadId = rawThread?.id;
				thread.rawThread = rawThread!;
				addCommentToCache(thread, fileChange.fileName);
				updateCommentThreadLabel(thread);
				rawComment = rawThread.comments?.[0];
				fileChange.update(fileChange.comments.concat(rawThread!));
			} else {
				rawComment = await this.reply(thread, input);
				rawThread.comments?.push(rawComment!);
				fileChange.comments.find(r => r.id === rawThread.id)?.comments?.push(rawComment!);
				fileChange.update(fileChange.comments);
			}

			this.replaceTemporaryComment(thread, rawComment!, temporaryCommentId);
			return rawThread;
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

	private isFileLeft(uri: vscode.Uri): boolean {
		if (uri.scheme === URI_SCHEME_REVIEW) {
			return fromReviewUri(uri).base;
		} else if (uri.scheme === URI_SCHEME_PR) {
			return fromPRUri(uri).isBase;
		}

		return false;
	}

	public async editComment(
		thread: GHPRCommentThread,
		comment: GHPRComment,
		getFileChanges: (isOutdated: boolean) => Promise<(InMemFileChangeNode | RemoteFileChangeNode | GitFileChangeNode)[]>,
	): Promise<Comment | undefined> {
		const temporaryCommentId = this.optimisticallyEditComment(thread, comment);
		try {
			const fileChange = await this.findMatchingFileNode(thread.uri, getFileChanges);
			const rawComment = await this.pullRequestModel.editThread(
				comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body,
				thread.threadId,
				parseInt(comment.commentId),
			);

			const index = fileChange.comments.findIndex(c => c.id?.toString() === comment.commentId);
			if (index > -1) {
				fileChange.comments.splice(index, 1, rawComment);
			}

			this.replaceTemporaryComment(thread, rawComment!, temporaryCommentId);
			return rawComment;
		} catch (e) {
			vscode.window.showErrorMessage(`Editing comment failed ${e}`);

			thread.comments = thread.comments.map(c => {
				if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
					return new GHPRComment(
						comment._rawComment,
						this.pullRequestModel.getCommentPermission(comment._rawComment),
						thread,
					);
				}

				return c;
			});
		}
	}

	public async changeThreadStatus(thread: GHPRCommentThread): Promise<void> {
		try {
			const allKeys = getCommentThreadStatusKeys();

			const selectedStatus = await vscode.window.showQuickPick(
				allKeys.filter(f => f !== CommentThreadStatus[thread?.rawThread?.status ?? 0]),
				{
					canPickMany: false,
					ignoreFocusOut: true,
				},
			);

			if (!selectedStatus) {
				return;
			}

			const newThread = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					cancellable: false,
				},
				async (progress, _token) => {
					progress.report({
						message: `Updating thread status from "${
							CommentThreadStatus[thread.rawThread.status ?? 0]
						}" to "${selectedStatus}"`,
					});
					return await this.pullRequestModel.updateThreadStatus(
						thread.rawThread.id!,
						CommentThreadStatus[selectedStatus as keyof typeof CommentThreadStatus],
					);
				},
			);

			// const newThread = await this.pullRequestModel.updateThreadStatus(thread.rawThread.id!, CommentThreadStatus[selectedStatus as keyof typeof CommentThreadStatus]);
			thread.rawThread = newThread!;
			updateCommentThreadLabel(thread);
		} catch (e) {
			vscode.window.showErrorMessage(`Updating status failed: ${e}`);
			Logger.appendLine(e);
		}
	}

	private optimisticallyAddComment(thread: GHPRCommentThread, input: string, inDraft: boolean): number {
		const currentUser = this._folderReposManager.getCurrentUser();
		const comment = new TemporaryComment(thread, input, inDraft, currentUser);
		this.updateCommentThreadComments(thread, [...thread.comments, comment]);
		return comment.id;
	}

	private optimisticallyEditComment(thread: GHPRCommentThread, comment: GHPRComment): number {
		const currentUser = this._folderReposManager.getCurrentUser();
		const temporaryComment = new TemporaryComment(
			thread,
			comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body,
			!!comment.label,
			currentUser,
			comment,
		);
		thread.comments = thread.comments.map(c => {
			if (c instanceof GHPRComment && c.commentId === comment.commentId) {
				return temporaryComment;
			}

			return c;
		});

		return temporaryComment.id;
	}

	private updateCommentThreadComments(thread: GHPRCommentThread, newComments: (GHPRComment | TemporaryComment)[]) {
		thread.comments = newComments;
		updateCommentThreadLabel(thread);
	}

	private async findMatchingFileNode(
		uri: vscode.Uri,
		getFileChanges: (isOutdated: boolean) => Promise<(InMemFileChangeNode | RemoteFileChangeNode | GitFileChangeNode)[]>,
	): Promise<GitFileChangeNode | InMemFileChangeNode> {
		let fileName: string;
		let isOutdated = false;
		if (uri.scheme === URI_SCHEME_REVIEW) {
			const query = fromReviewUri(uri);
			isOutdated = query.isOutdated;
			fileName = query.path;
		}

		if (uri.scheme === URI_SCHEME_PR) {
			fileName = fromPRUri(uri)!.fileName;
		}

		const fileChangesToSearch = await getFileChanges(isOutdated);

		const matchedFile = (uri.scheme === URI_SCHEME_REVIEW
			? gitFileChangeNodeFilter(fileChangesToSearch)
			: fileChangesToSearch
		).find(fileChange => {
			if (uri.scheme === URI_SCHEME_REVIEW || uri.scheme === URI_SCHEME_PR) {
				return fileChange.fileName === fileName;
			} else {
				return fileChange.filePath.path === uri.path;
			}
		});

		if (!matchedFile) {
			throw new Error('No matching file found');
		}

		if (matchedFile instanceof RemoteFileChangeNode) {
			throw new Error('Comments not supported on remote file changes');
		}

		return matchedFile;
	}

	private async createNewThread(
		thread: GHPRCommentThread,
		input: string,
		fileChange: InMemFileChangeNode | GitFileChangeNode,
		isLeft: boolean,
	): Promise<GitPullRequestCommentThread | undefined> {
		const rawComment = await this.pullRequestModel.createThread(input, {
			filePath: fileChange.fileName,
			line: thread.range.start.line + 1,
			endOffset: 0,
			startOffset: 0,
			isLeft: isLeft,
		});

		return rawComment;
	}

	private reply(thread: GHPRCommentThread, input: string): Promise<Comment | undefined> {
		const replyingTo = thread.comments[0];
		if (replyingTo instanceof GHPRComment) {
			return this.pullRequestModel.createCommentOnThread(thread.threadId, input);
		} else {
			// TODO can we do better?
			throw new Error('Cannot respond to temporary comment');
		}
	}

	public replaceTemporaryComment(thread: GHPRCommentThread, realComment: Comment, temporaryCommentId: number): void {
		thread.comments = thread.comments.map(c => {
			if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
				return new GHPRComment(realComment, this.pullRequestModel.getCommentPermission(realComment), thread);
			}

			return c;
		});
	}

	async provideCommentingRanges(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
		getFileChanges: () => Promise<(RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode)[]>,
	): Promise<vscode.Range[] | undefined> {
		if (document.uri.scheme === URI_SCHEME_PR) {
			const params = fromPRUri(document.uri);

			if (!params || params.prNumber !== this.pullRequestModel.getPullRequestId()) {
				return;
			}

			const fileChange = (await getFileChanges()).find(change => change.fileName === params.fileName);

			if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
				return;
			}

			const range = getCommentingRanges(fileChange.diffHunks, params.isBase);
			return range;
		}
	}
}
