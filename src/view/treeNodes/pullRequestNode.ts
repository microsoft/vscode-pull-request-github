/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { parseDiff, getModifiedContentFromDiffHunk, DiffChangeType, DiffHunk } from '../../common/diffHunk';
import { getZeroBased, getAbsolutePosition, getPositionInDiff } from '../../common/diffPositionMapping';
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
import { convertToVSCodeComment } from '../../github/utils';
import { getCommentThreadCommands } from '../../github/commands';

export function provideDocumentComments(
	control: vscode.CommentControl,
	pullRequestModel: PullRequestModel,
	uri: vscode.Uri,
	isBase: boolean,
	fileChange: (RemoteFileChangeNode | InMemFileChangeNode | GitFileChangeNode),
	inDraftMode: boolean) {

	if (!fileChange || fileChange instanceof RemoteFileChangeNode) {
		return;
	}

	// Partial file change indicates that the file content is only the diff, so the entire
	// document can be commented on.
	const commentingRanges = fileChange.isPartial
		? [new vscode.Range(0, 0, 0, 0)]
		: getCommentingRanges(fileChange.diffHunks, isBase);

	const matchingComments = fileChange.comments;
	if (!matchingComments || !matchingComments.length) {
		return {
			threads: [],
			commentingRanges,
			inDraftMode
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
			comments: comments.map(comment => {
				let vscodeComment = convertToVSCodeComment(comment, undefined, control, pullRequestModel);
				return vscodeComment;
			}),
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
		});
	}

	return {
		threads,
		commentingRanges,
		inDraftMode
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

function commentsToCommentThreads(fileChange: InMemFileChangeNode, comments: Comment[], isBase: boolean): vscode.CommentThread[] {
	let sections = groupBy(comments, comment => comment.position!.toString());
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
			threadId: firstComment.id.toString(),
			resource: isBase ? fileChange.parentFilePath : fileChange.filePath,
			range,
			comments: commentGroup.map(comment => convertToVSCodeComment(comment, undefined, undefined, undefined)),
			collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
		});
	}

	return threads;
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

export class PRNode extends TreeNode {
	static ID = 'PRNode';
	private _fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[];
	private _fileChangeCommentThreads: { [key: string]: vscode.CommentThread[] } = {};
	private _commentControl?: vscode.CommentControl;
	private _onDidChangeCommentThreads: vscode.EventEmitter<vscode.CommentThreadChangedEvent>;
	private _disposables: vscode.Disposable[] = [];

	private _inMemPRContentProvider?: vscode.Disposable;

	constructor(
		public parent: TreeNode | vscode.TreeView<TreeNode>,
		private _prManager: PullRequestManager,
		public pullRequestModel: PullRequestModel,
		private _isLocal: boolean
	) {
		super();
	}

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
				const inDraftMode = await this._prManager.inDraftMode(this.pullRequestModel);
					this._fileChanges = fileChanges;
					if (this._commentControl) {
						await this.updateComments(fileChanges);
						this._fileChanges = fileChanges;
					}

					this._commentControl = vscode.comment.createCommentControl(String(this.pullRequestModel.prNumber), this.pullRequestModel.title);

					this._fileChanges.forEach(fileChange => {
						if (fileChange instanceof InMemFileChangeNode) {
							let leftComments = provideDocumentComments(this._commentControl!, this.pullRequestModel, fileChange.parentFilePath, true, fileChange, inDraftMode);
							let rightComments = provideDocumentComments(this._commentControl!, this.pullRequestModel, fileChange.filePath, false, fileChange, inDraftMode);
							this.createCommentThread(
								fileChange.fileName,
								[...(leftComments ? leftComments.threads : []), ...(rightComments ? rightComments.threads : [])],
								inDraftMode
							);

							this.createCommentingRanges(
								fileChange.filePath,
								[...(leftComments ? leftComments.commentingRanges : []), ...(rightComments ? rightComments.commentingRanges : [])],
								inDraftMode);
						}
					});

					this._disposables.push(this.pullRequestModel.onDidChangeDraftMode(newDraftMode => {
						let commands = getCommentThreadCommands(this._commentControl!, this.pullRequestModel, newDraftMode);
						for (let fileName in this._fileChangeCommentThreads) {
							this._fileChangeCommentThreads[fileName].forEach(thread => {
								thread.acceptInputCommands = commands;
							});
						}
					}));
				// }
			} else {
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

	createCommentingRanges(filePath: vscode.Uri, ranges: vscode.Range[], inDraftMode: boolean) {
		this._commentControl!.createCommentingRanges(filePath, ranges, {
			title: 'Create New Command Thread',
			command: 'pr.createNewCommentThread',
			arguments: [
				this._commentControl,
				this.pullRequestModel
			]
		});
	}

	createCommentThread(fileName: string, commentThreads: vscode.CommentThread[], inDraftMode: boolean) {
		let commands = getCommentThreadCommands(this._commentControl!, this.pullRequestModel, inDraftMode);
		let threads: vscode.CommentThread[] = [];
		commentThreads.forEach(thread => {
			threads.push(this._commentControl!.createCommentThread(
				thread.threadId,
				thread.resource,
				thread.range!,
				thread.comments,
				commands,
				thread.collapsibleState
			));
		});

		this._fileChangeCommentThreads[fileName] = threads;
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

	private async updateComments(fileChanges: (RemoteFileChangeNode | InMemFileChangeNode)[]): Promise<void> {
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

			let oldLeftSideCommentThreads = this._fileChangeCommentThreads[oldFileChange.fileName].filter(thread => thread.resource.toString() === (oldFileChange as InMemFileChangeNode).parentFilePath.toString());
			let newLeftSideCommentThreads = provideDocumentComments(this._commentControl!, this.pullRequestModel, newFileChange.parentFilePath, true, newFileChange, inDraftMode);

			this.updateFileChangeCommentThreads(oldLeftSideCommentThreads, newLeftSideCommentThreads ? newLeftSideCommentThreads.threads : [], newFileChange, inDraftMode);

			let oldRightSideCommentThreads = this._fileChangeCommentThreads[oldFileChange.fileName].filter(thread => thread.resource.toString() === (oldFileChange as InMemFileChangeNode).filePath.toString());
			let newRightSideCommentThreads = provideDocumentComments(this._commentControl!, this.pullRequestModel, newFileChange.filePath, true, newFileChange, inDraftMode);

			this.updateFileChangeCommentThreads(oldRightSideCommentThreads, newRightSideCommentThreads ? newRightSideCommentThreads.threads : [], newFileChange, inDraftMode);
		}

		return;
	}

	private updateFileChangeCommentThreads(oldCommentThreads: vscode.CommentThread[], newCommentThreads: vscode.CommentThread[], newFileChange: InMemFileChangeNode, inDraftMode: boolean) {
// remove
		oldCommentThreads.forEach(thread => {
			// No current threads match old thread, it has been removed
			const matchingThreads = newCommentThreads && newCommentThreads.filter(newThread => newThread.threadId === thread.threadId);
			if (matchingThreads !== undefined) {
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
					}
				});
			});

			if (added.length) {
				this.createCommentThread(newFileChange.fileName, added, inDraftMode);
			}
		}
	}

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

	private findMatchingFileNode(uri: vscode.Uri): InMemFileChangeNode {
		const params = fromPRUri(uri);

		if (!params) {
			throw new Error(`${uri.toString()} is not valid PR document`);
		}

		const fileChange = this._fileChanges.find(change => change.fileName === params.fileName);

		if (!fileChange) {
			throw new Error('No matching file found');
		}

		if (fileChange instanceof RemoteFileChangeNode) {
			throw new Error('Comments not supported on remote file changes');
		}

		return fileChange;
	}

	async addReaction(document: vscode.TextDocument, comment: vscode.Comment, reaction: vscode.CommentReaction) {
		const fileChange = this.findMatchingFileNode(document.uri);
		if (!fileChange) {
			throw new Error('Unable to find matching file');
		}

		let matchedRawComment = fileChange.comments.find(cmt => String(cmt.id) === comment.commentId);

		if (!matchedRawComment) {
			throw new Error('Unable to find matching comment');
		}

		await this._prManager.addCommentReaction(this.pullRequestModel, matchedRawComment.graphNodeId, reaction);
		const params = fromPRUri(document.uri);
		let comments = await this._prManager.getPullRequestComments(this.pullRequestModel);
		let changedCommentThreads = commentsToCommentThreads(fileChange, comments.filter(cmt => cmt.path === fileChange.fileName && cmt.position !== null), params!.isBase);

		this._onDidChangeCommentThreads.fire({
			added: [],
			changed: changedCommentThreads,
			removed: []
		});
	}

	async deleteReaction(document: vscode.TextDocument, comment: vscode.Comment, reaction: vscode.CommentReaction) {
		const fileChange = this.findMatchingFileNode(document.uri);
		let matchedRawComment = fileChange.comments.find(cmt => String(cmt.id) === comment.commentId);

		if (!matchedRawComment) {
			throw new Error('Unable to find matching comment');
		}

		await this._prManager.deleteCommentReaction(this.pullRequestModel, matchedRawComment.graphNodeId, reaction);
		const params = fromPRUri(document.uri);
		let comments = await this._prManager.getPullRequestComments(this.pullRequestModel);
		let changedCommentThreads = commentsToCommentThreads(fileChange, comments.filter(cmt => cmt.path === fileChange.fileName && cmt.position !== null), params!.isBase);

		this._onDidChangeCommentThreads.fire({
			added: [],
			changed: changedCommentThreads,
			removed: []
		});
	}

	dispose(): void {
		super.dispose();

		if (this._inMemPRContentProvider) {
			this._inMemPRContentProvider.dispose();
		}

		this._disposables.forEach(d => d.dispose());
	}
}
