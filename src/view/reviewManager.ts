/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import * as vscode from 'vscode';
import { parseDiff, parsePatch } from '../common/diffHunk';
import { getDiffLineByPosition, getLastDiffLine, mapCommentsToHead, mapHeadLineToDiffHunkPosition, mapOldPositionToNew, getZeroBased, getAbsolutePosition } from '../common/diffPositionMapping';
import { toReviewUri, fromReviewUri, fromPRUri, ReviewUriParams } from '../common/uri';
import { groupBy, formatError } from '../common/utils';
import { Comment } from '../common/comment';
import { GitChangeType, InMemFileChange } from '../common/file';
import { ITelemetry } from '../github/interface';
import { Repository, GitErrorCodes, Branch } from '../typings/git';
import { PullRequestChangesTreeDataProvider } from './prChangesTreeDataProvider';
import { GitContentProvider } from './gitContentProvider';
import { DiffChangeType } from '../common/diffHunk';
import { GitFileChangeNode, RemoteFileChangeNode, gitFileChangeNodeFilter } from './treeNodes/fileChangeNode';
import Logger from '../common/logger';
import { PullRequestsTreeDataProvider } from './prsTreeDataProvider';
import { providePRDocumentComments, PRNode } from './treeNodes/pullRequestNode';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { Remote, parseRepositoryRemotes } from '../common/remote';
import { RemoteQuickPickItem } from './quickpick';
import { PullRequestManager, onDidSubmitReview } from '../github/pullRequestManager';
import { PullRequestModel } from '../github/pullRequestModel';

export class ReviewManager implements vscode.DecorationProvider {
	public static ID = 'Review';
	private static _instance: ReviewManager;
	private _localToDispose: vscode.Disposable[] = [];
	private _disposables: vscode.Disposable[];

	private _comments: Comment[] = [];
	private _localFileChanges: (GitFileChangeNode)[] = [];
	private _obsoleteFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];
	private _lastCommitSha: string;
	private _updateMessageShown: boolean = false;
	private _validateStatusInProgress: Promise<void>;

	private _onDidChangeDocumentCommentThreads = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();
	private _onDidChangeWorkspaceCommentThreads = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();

	private _prsTreeDataProvider: PullRequestsTreeDataProvider;
	private _prFileChangesProvider: PullRequestChangesTreeDataProvider;
	private _statusBarItem: vscode.StatusBarItem;
	private _prNumber: number;
	private _previousRepositoryState: {
		HEAD: Branch | undefined;
		remotes: Remote[];
	};

	private _switchingToReviewMode: boolean;

	public get switchingToReviewMode(): boolean {
		return this._switchingToReviewMode;
	}

	public set switchingToReviewMode(newState: boolean) {
		this._switchingToReviewMode = newState;
		if (!newState) {
			this.updateState();
		}
	}

	constructor(
		private _context: vscode.ExtensionContext,
		onShouldReload: vscode.Event<any>,
		private _repository: Repository,
		private _prManager: PullRequestManager,
		private _telemetry: ITelemetry
	) {
		this._switchingToReviewMode = false;
		this._disposables = [];
		let gitContentProvider = new GitContentProvider(_repository);
		gitContentProvider.registerTextDocumentContentFallback(this.provideTextDocumentContent.bind(this));
		this._disposables.push(vscode.workspace.registerTextDocumentContentProvider('review', gitContentProvider));
		this._disposables.push(vscode.commands.registerCommand('review.openFile', (value: GitFileChangeNode | vscode.Uri) => {
			let params: ReviewUriParams;
			let filePath: string;
			if (value instanceof GitFileChangeNode) {
				params = fromReviewUri(value.filePath);
				filePath = value.filePath.path;
			} else {
				params = fromReviewUri(value);
				filePath = value.path;
			}

			const activeTextEditor = vscode.window.activeTextEditor;
			const opts: vscode.TextDocumentShowOptions = {
				preserveFocus: false,
				viewColumn: vscode.ViewColumn.Active
			};

			// Check if active text editor has same path as other editor. we cannot compare via
			// URI.toString() here because the schemas can be different. Instead we just go by path.
			if (activeTextEditor && activeTextEditor.document.uri.path === filePath) {
				opts.selection = activeTextEditor.selection;
			}

			vscode.commands.executeCommand('vscode.open', vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, params.path)), opts);
		}));
		this._disposables.push(vscode.commands.registerCommand('pr.openChangedFile', (value: GitFileChangeNode) => {
			const openDiff = vscode.workspace.getConfiguration().get('git.openDiffOnClick');
			if (openDiff) {
				return vscode.commands.executeCommand('pr.openDiffView', value);
			} else {
				return vscode.commands.executeCommand('review.openFile', value);
			}
		}));

		this._disposables.push(_repository.state.onDidChange(e => {
			const oldHead = this._previousRepositoryState.HEAD;
			const newHead = this._repository.state.HEAD;

			if (!oldHead && !newHead) {
				// both oldHead and newHead are undefined
				return;
			}

			let sameUpstream;

			if (!oldHead || !newHead) {
				sameUpstream = false;
			} else {
				sameUpstream = !!oldHead.upstream
					? newHead.upstream && oldHead.upstream.name === newHead.upstream.name && oldHead.upstream.remote === newHead.upstream.remote
					: !newHead.upstream;
			}

			const sameHead = sameUpstream // falsy if oldHead or newHead is undefined.
				&& oldHead.ahead === newHead.ahead
				&& oldHead.behind === newHead.behind
				&& oldHead.commit === newHead.commit
				&& oldHead.name === newHead.name
				&& oldHead.remote === newHead.remote
				&& oldHead.type === newHead.type;

			let remotes = parseRepositoryRemotes(this._repository);
			const sameRemotes = this._previousRepositoryState.remotes.length === remotes.length
				&& this._previousRepositoryState.remotes.every(remote => remotes.some(r => remote.equals(r)));

			if (!sameHead || !sameRemotes) {
				this._previousRepositoryState = {
					HEAD: this._repository.state.HEAD,
					remotes: remotes
				};

				if (sameHead && !sameRemotes) {
					let oldHeadRemote = this._previousRepositoryState.remotes.find(remote => remote.remoteName === oldHead.remote);
					let newHeadRemote = remotes.find(remote => remote.remoteName === oldHead.remote);
					if ((!oldHeadRemote && !newHeadRemote) || (oldHeadRemote && newHeadRemote && oldHeadRemote.equals(newHeadRemote))
					) {
						return;
					}
				}

				this.updateState();
			}
		}));

		this._disposables.push(vscode.commands.registerCommand('pr.refreshChanges', _ => {
			this.updateComments();
			PullRequestOverviewPanel.refresh();
			this.prFileChangesProvider.refresh();
		}));

		this._disposables.push(vscode.commands.registerCommand('pr.refreshPullRequest', (prNode: PRNode) => {
			if (prNode.pullRequestModel.equals(this._prManager.activePullRequest)) {
				this.updateComments();
			}

			PullRequestOverviewPanel.refresh();
			this._prsTreeDataProvider.refresh(prNode);
		}));

		this._prsTreeDataProvider = new PullRequestsTreeDataProvider(onShouldReload, _prManager, this._telemetry);
		this._disposables.push(this._prsTreeDataProvider);
		this._disposables.push(vscode.window.registerDecorationProvider(this));

		this._previousRepositoryState = {
			HEAD: _repository.state.HEAD,
			remotes: parseRepositoryRemotes(this._repository)
		};

		this.updateState();
		this.pollForStatusChange();
	}

	static get instance() {
		return ReviewManager._instance;
	}

	get prFileChangesProvider() {
		if (!this._prFileChangesProvider) {
			this._prFileChangesProvider = new PullRequestChangesTreeDataProvider(this._context);
			this._disposables.push(this._prFileChangesProvider);
		}

		return this._prFileChangesProvider;
	}

	get statusBarItem() {
		if (!this._statusBarItem) {
			this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
		}

		return this._statusBarItem;
	}

	set repository(repository: Repository) {
		this._repository = repository;
		this.updateState();
	}

	private pollForStatusChange() {
		setTimeout(async () => {
			if (!this._validateStatusInProgress) {
				await this.updateComments();
			}
			this.pollForStatusChange();
		}, 1000 * 30);
	}

	private async updateState() {
		if (this.switchingToReviewMode) {
			return;
		}
		if (!this._validateStatusInProgress) {
			this._validateStatusInProgress = this.validateState();
			return this._validateStatusInProgress;
		} else {
			return this._validateStatusInProgress.then(_ => this._validateStatusInProgress = this.validateState());
		}
	}

	private async validateState() {
		await this._prManager.updateRepositories();

		let branch = this._repository.state.HEAD;
		if (!branch) {
			this.clear(true);
			return;
		}

		let matchingPullRequestMetadata = await this._prManager.getMatchingPullRequestMetadataForBranch();

		if (!matchingPullRequestMetadata) {
			Logger.appendLine(`Review> no matching pull request metadata found for current branch ${this._repository.state.HEAD.name}`);
			this.clear(true);
			return;
		}

		const hasPushedChanges = branch.commit !== this._lastCommitSha && branch.ahead === 0 && branch.behind === 0;
		if (this._prNumber === matchingPullRequestMetadata.prNumber && !hasPushedChanges) {
			return;
		}

		let remote = branch.upstream ? branch.upstream.remote : null;
		if (!remote) {
			Logger.appendLine(`Review> current branch ${this._repository.state.HEAD.name} hasn't setup remote yet`);
			this.clear(true);
			return;
		}

		// we switch to another PR, let's clean up first.
		Logger.appendLine(`Review> current branch ${this._repository.state.HEAD.name} is associated with pull request #${matchingPullRequestMetadata.prNumber}`);
		this.clear(false);
		this._prNumber = matchingPullRequestMetadata.prNumber;
		this._lastCommitSha = null;

		const { owner, repositoryName } = matchingPullRequestMetadata;
		const pr = await this._prManager.resolvePullRequest(owner, repositoryName, this._prNumber);
		if (!pr) {
			this._prNumber = null;
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}

		this._prManager.activePullRequest = pr;
		this._lastCommitSha = pr.head.sha;

		await this.getPullRequestData(pr);
		await this.prFileChangesProvider.showPullRequestFileChanges(this._prManager, pr, this._localFileChanges, this._comments);

		this._onDidChangeDecorations.fire();
		Logger.appendLine(`Review> register comments provider`);
		this.registerCommentProvider();

		this.statusBarItem.text = '$(git-branch) Pull Request #' + this._prNumber;
		this.statusBarItem.command = 'pr.openDescription';
		Logger.appendLine(`Review> display pull request status bar indicator and refresh pull request tree view.`);
		this.statusBarItem.show();
		vscode.commands.executeCommand('pr.refreshList');
		this._validateStatusInProgress = null;
	}

	private findMatchedFileByUri(document: vscode.TextDocument): GitFileChangeNode {
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
			fileName = fromPRUri(uri).fileName;
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

	private async replyToCommentThread(document: vscode.TextDocument, range: vscode.Range, thread: vscode.CommentThread, text: string) {
		try {
			const matchedFile = this.findMatchedFileByUri(document);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			const commentFromThread = this._comments.find(c => c.id.toString() === thread.threadId);
			if (!commentFromThread) {
				throw new Error('Unable to find thread to respond to.');
			}

			const comment = await this._prManager.createCommentReply(this._prManager.activePullRequest, text, commentFromThread);
			thread.comments.push({
				commentId: comment.id.toString(),
				body: new vscode.MarkdownString(comment.body),
				userName: comment.user.login,
				gravatar: comment.user.avatarUrl,
				canEdit: comment.canEdit,
				canDelete: comment.canDelete,
				isDraft: comment.isDraft
			});

			matchedFile.comments.push(comment);
			this._comments.push(comment);

			const workspaceThread = Object.assign({}, thread, { resource: vscode.Uri.file(thread.resource.fsPath) });
			this._onDidChangeWorkspaceCommentThreads.fire({
				added: [],
				changed: [workspaceThread],
				removed: []
			});

			return thread;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	private async createNewCommentThread(document: vscode.TextDocument, range: vscode.Range, text: string) {
		try {
			const uri = document.uri;
			const matchedFile = this.findMatchedFileByUri(document);
			const query = uri.query === '' ? undefined : fromReviewUri(uri);
			const isBase = query && query.base;

			// git diff sha -- fileName
			const contentDiff = await this._repository.diffWith(this._lastCommitSha, matchedFile.fileName);
			const position = mapHeadLineToDiffHunkPosition(matchedFile.diffHunks, contentDiff, range.start.line + 1, isBase);

			if (position < 0) {
				throw new Error('Comment position cannot be negative');
			}

			// there is no thread Id, which means it's a new thread
			let rawComment = await this._prManager.createComment(this._prManager.activePullRequest, text, matchedFile.fileName, position);

			let comment = {
				commentId: rawComment.id.toString(),
				body: new vscode.MarkdownString(rawComment.body),
				userName: rawComment.user.login,
				gravatar: rawComment.user.avatarUrl,
				canEdit: rawComment.canEdit,
				canDelete: rawComment.canDelete,
				isDraft: rawComment.isDraft
			};

			let commentThread: vscode.CommentThread = {
				threadId: comment.commentId.toString(),
				resource: vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, rawComment.path)),
				range: range,
				comments: [comment]
			};

			matchedFile.comments.push(rawComment);
			this._comments.push(rawComment);

			const workspaceThread = Object.assign({}, commentThread, { resource: vscode.Uri.file(commentThread.resource.fsPath) });
			this._onDidChangeWorkspaceCommentThreads.fire({
				added: [workspaceThread],
				changed: [],
				removed: []
			});

			return commentThread;
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	private async editComment(document: vscode.TextDocument, comment: vscode.Comment, text: string): Promise<void> {
		try {
			const matchedFile = this.findMatchedFileByUri(document);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			const editedComment = await this._prManager.editReviewComment(this._prManager.activePullRequest, comment.commentId, text);

			// Update the cached comments of the file
			const matchingCommentIndex = matchedFile.comments.findIndex(c => c.id.toString() === comment.commentId);
			if (matchingCommentIndex > -1) {
				matchedFile.comments.splice(matchingCommentIndex, 1, editedComment);
				const changedThreads = this.fileCommentsToCommentThreads(matchedFile, matchedFile.comments.filter(c => c.position === editedComment.position), vscode.CommentThreadCollapsibleState.Expanded);

				this._onDidChangeWorkspaceCommentThreads.fire({
					added: [],
					changed: changedThreads,
					removed: []
				});
			}

			// Also update this._comments
			const indexInAllComments = this._comments.findIndex(c => c.id.toString() === comment.commentId);
			if (indexInAllComments > -1) {
				this._comments.splice(indexInAllComments, 1, editedComment);
			}
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	private async deleteComment(document: vscode.TextDocument, comment: vscode.Comment): Promise<void> {
		try {
			const matchedFile = this.findMatchedFileByUri(document);
			if (!matchedFile) {
				throw new Error('Unable to find matching file');
			}

			await this._prManager.deleteReviewComment(this._prManager.activePullRequest, comment.commentId);
			const matchingCommentIndex = matchedFile.comments.findIndex(c => c.id.toString() === comment.commentId);
			if (matchingCommentIndex > -1) {
				const [ deletedComment ] = matchedFile.comments.splice(matchingCommentIndex, 1);
				const updatedThreadComments = matchedFile.comments.filter(c => c.position === deletedComment.position);

				// If the deleted comment was the last in its thread, remove the thread
				if (updatedThreadComments.length) {
					const changedThreads = this.fileCommentsToCommentThreads(matchedFile, updatedThreadComments, vscode.CommentThreadCollapsibleState.Expanded);
					this._onDidChangeWorkspaceCommentThreads.fire({
						added: [],
						changed: changedThreads,
						removed: []
					});
				} else {
					this._onDidChangeWorkspaceCommentThreads.fire({
						added: [],
						changed: [],
						removed: [{
							threadId: deletedComment.id.toString(),
							resource: vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, deletedComment.path)),
							comments: [],
							range: null
						}]
					});
				}

				this._onDidChangeDocumentCommentThreads.fire({
					added: [],
					changed: [],
					removed: [],
					inDraftMode: await this._prManager.inDraftMode(this._prManager.activePullRequest)
				});
			}

			const indexInAllComments = this._comments.findIndex(c => c.id.toString() === comment.commentId);
			if (indexInAllComments > -1) {
				this._comments.splice(indexInAllComments, 1);
			}
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	private async updateComments(): Promise<void> {
		const branch = this._repository.state.HEAD;
		if (!branch) { return; }

		const matchingPullRequestMetadata = await this._prManager.getMatchingPullRequestMetadataForBranch();
		if (!matchingPullRequestMetadata) { return; }

		const remote = branch.upstream ? branch.upstream.remote : null;
		if (!remote) { return; }

		const pr = await this._prManager.resolvePullRequest(matchingPullRequestMetadata.owner, matchingPullRequestMetadata.repositoryName, this._prNumber);

		if (!pr) {
			Logger.appendLine('Review> This PR is no longer valid');
			return;
		}

		if ((pr.head.sha !== this._lastCommitSha || (branch.behind !== undefined && branch.behind > 0)) && !this._updateMessageShown) {
			this._updateMessageShown = true;
			let result = await vscode.window.showInformationMessage('There are updates available for this branch.', {}, 'Pull');

			if (result === 'Pull') {
				await vscode.commands.executeCommand('git.pull');
				this._updateMessageShown = false;
			}
		}

		const comments = await this._prManager.getPullRequestComments(this._prManager.activePullRequest);

		let added: vscode.CommentThread[] = [];
		let removed: vscode.CommentThread[] = [];
		let changed: vscode.CommentThread[] = [];

		const oldCommentThreads = this.allCommentsToCommentThreads(this._comments, vscode.CommentThreadCollapsibleState.Expanded);
		const newCommentThreads = this.allCommentsToCommentThreads(comments, vscode.CommentThreadCollapsibleState.Expanded);

		oldCommentThreads.forEach(thread => {
			// No current threads match old thread, it has been removed
			const matchingThreads = newCommentThreads.filter(newThread => newThread.threadId === thread.threadId);
			if (matchingThreads.length === 0) {
				removed.push(thread);
			}
		});

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

		if (added.length || removed.length || changed.length) {
			this._onDidChangeDocumentCommentThreads.fire({
				added: added,
				removed: removed,
				changed: changed,
				inDraftMode: await this._prManager.inDraftMode(this._prManager.activePullRequest)
			});

			this._onDidChangeWorkspaceCommentThreads.fire({
				added: added,
				removed: removed,
				changed: changed
			});

			this._comments = comments;
			this._localFileChanges.forEach(change => {
				if (change instanceof GitFileChangeNode) {
					change.comments = this._comments.filter(comment => change.fileName === comment.path && comment.position !== null);
				}
			});
			this._onDidChangeDecorations.fire();
		}

		return Promise.resolve(null);
	}

	private async getPullRequestData(pr: PullRequestModel): Promise<void> {
		try {
			this._comments = await this._prManager.getPullRequestComments(pr);
			let activeComments = this._comments.filter(comment => comment.position);
			let outdatedComments = this._comments.filter(comment => !comment.position);

			const data = await this._prManager.getPullRequestFileChangesInfo(pr);
			const headSha = pr.head.sha;
			const mergeBase = pr.mergeBase;

			const contentChanges = await parseDiff(data, this._repository, mergeBase);
			this._localFileChanges = [];
			for (let i = 0; i < contentChanges.length; i++) {
				let change = contentChanges[i];
				let isPartial = false;
				let diffHunks = [];

				if (change instanceof InMemFileChange) {
					isPartial = change.isPartial;
					diffHunks = change.diffHunks;
				} else {
					try {
						const patch = await this._repository.diffBetween(pr.base.sha, pr.head.sha, change.fileName);
						diffHunks = parsePatch(patch);
					} catch (e) {
						Logger.appendLine(`Failed to parse patch for outdated comments: ${e}`);
					}
				}

				const uri = vscode.Uri.parse(change.fileName);
				let changedItem = new GitFileChangeNode(
					this.prFileChangesProvider.view,
					pr,
					change.status,
					change.fileName,
					change.blobUrl,
					toReviewUri(uri, null, null, change.status === GitChangeType.DELETE ? '' : pr.head.sha, false, { base: false }),
					toReviewUri(uri, null, null, change.status === GitChangeType.ADD ? '' : pr.base.sha, false, { base: true }),
					isPartial,
					diffHunks,
					activeComments.filter(comment => comment.path === change.fileName),
					headSha
				);
				this._localFileChanges.push(changedItem);
			}

			let commitsGroup = groupBy(outdatedComments, comment => comment.originalCommitId);
			this._obsoleteFileChanges = [];
			for (let commit in commitsGroup) {
				let commentsForCommit = commitsGroup[commit];
				let commentsForFile = groupBy(commentsForCommit, comment => comment.path);

				for (let fileName in commentsForFile) {

					let diffHunks = [];
					try {
						const patch = await this._repository.diffBetween(pr.base.sha, commit, fileName);
						diffHunks = parsePatch(patch);
					} catch (e) {
						Logger.appendLine(`Failed to parse patch for outdated comments: ${e}`);
					}

					const oldComments = commentsForFile[fileName];
					const uri = vscode.Uri.parse(nodePath.join(`commit~${commit.substr(0, 8)}`, fileName));
					const obsoleteFileChange = new GitFileChangeNode(
						this.prFileChangesProvider.view,
						pr,
						GitChangeType.MODIFY,
						fileName,
						null,
						toReviewUri(uri, fileName, null, oldComments[0].originalCommitId, true, { base: false }),
						toReviewUri(uri, fileName, null, oldComments[0].originalCommitId, true, { base: true }),
						false,
						diffHunks,
						oldComments,
						commit
					);

					this._obsoleteFileChanges.push(obsoleteFileChange);
				}
			}

			return Promise.resolve(null);
		} catch (e) {
			Logger.appendLine(`Review> ${e}`);
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
			let diffLine = getDiffLineByPosition(firstComment.diffHunks, firstComment.originalPosition);

			if (diffLine) {
				firstComment.absolutePosition = diffLine.newLineNumber;
			}

			const pos = new vscode.Position(getZeroBased(firstComment.absolutePosition), 0);
			const range = new vscode.Range(pos, pos);

			ret.push({
				threadId: firstComment.id.toString(),
				resource: fileChange.filePath,
				range,
				comments: comments.map(comment => {
					return {
						commentId: comment.id.toString(),
						body: new vscode.MarkdownString(comment.body),
						userName: comment.user.login,
						gravatar: comment.user.avatarUrl,
						command: {
							title: 'View Changes',
							command: 'pr.viewChanges',
							arguments: [
								fileChange
							]
						},
						canEdit: comment.canEdit,
						canDelete: comment.canDelete,
						isDraft: comment.isDraft
					};
				}),
				collapsibleState: collapsibleState
			});
		}

		return ret;
	}

	private fileCommentsToCommentThreads(fileChange: GitFileChangeNode, fileComments: Comment[], collapsibleState: vscode.CommentThreadCollapsibleState): vscode.CommentThread[] {
		if (!fileChange) {
			return [];
		}

		if (!fileComments || !fileComments.length) {
			return [];
		}

		let ret: vscode.CommentThread[] = [];
		let sections = groupBy(fileComments, comment => String(comment.position));

		let command: vscode.Command = null;
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
			let comments = sections[i];

			const firstComment = comments[0];
			const pos = new vscode.Position(getZeroBased(firstComment.absolutePosition), 0);
			const range = new vscode.Range(pos, pos);

			ret.push({
				threadId: firstComment.id.toString(),
				resource: vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, firstComment.path)),
				range,
				comments: comments.map(comment => {
					return {
						commentId: comment.id.toString(),
						body: new vscode.MarkdownString(comment.body),
						userName: comment.user.login,
						gravatar: comment.user.avatarUrl,
						command: command,
						canEdit: comment.canEdit,
						canDelete: comment.canDelete,
						isDraft: comment.isDraft
					};
				}),
				collapsibleState: collapsibleState
			});
		}

		return ret;
	}

	private allCommentsToCommentThreads(comments: Comment[], collapsibleState: vscode.CommentThreadCollapsibleState): vscode.CommentThread[] {
		if (!comments || !comments.length) {
			return [];
		}

		let fileCommentGroups = groupBy(comments, comment => comment.path);
		let ret: vscode.CommentThread[] = [];

		for (let file in fileCommentGroups) {
			let fileComments: Comment[] = fileCommentGroups[file];

			let matchedFiles = gitFileChangeNodeFilter(this._localFileChanges).filter(fileChange => fileChange.fileName === file);

			if (matchedFiles && matchedFiles.length) {
				ret = [...ret, ...this.fileCommentsToCommentThreads(matchedFiles[0], fileComments, collapsibleState)];
			}
		}
		return ret;
	}

	_onDidChangeDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[]> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
	onDidChangeDecorations: vscode.Event<vscode.Uri | vscode.Uri[]> = this._onDidChangeDecorations.event;
	provideDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.DecorationData> {
		let fileName = uri.path;
		let matchingComments = this._comments.filter(comment => nodePath.resolve(this._repository.rootUri.fsPath, comment.path) === fileName && comment.position !== null);
		if (matchingComments && matchingComments.length) {
			return {
				bubble: false,
				title: 'Commented',
				letter: '◆',
				priority: 2
			};
		}

		return undefined;
	}

	private updateCommentPendingState(submittedComments: Comment[]) {
		this._comments.forEach(comment => {
			comment.isDraft = false;
		});

		const commentsByFile = groupBy(submittedComments, comment => comment.path);
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
		let i = changed.length; while (i --> 0) {
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

	private registerCommentProvider() {
		const supportsGraphQL = this._prManager.activePullRequest && (this._prManager.activePullRequest as PullRequestModel).githubRepository.supportsGraphQl();
		if (supportsGraphQL) {
			this._localToDispose.push(onDidSubmitReview(submittedComments => {
				this.updateCommentPendingState(submittedComments);
			}));
		}

		this._localToDispose.push(vscode.workspace.registerDocumentCommentProvider({
			onDidChangeCommentThreads: this._onDidChangeDocumentCommentThreads.event,
			provideDocumentComments: async (document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CommentInfo> => {
				let ranges: vscode.Range[] = [];
				let matchingComments: Comment[];

				if (document.uri.scheme === 'file') {
					// local file, we only provide active comments
					// TODO. for comments in deleted ranges, they should show on top of the first line.
					const fileName = document.uri.fsPath;
					const matchedFiles = gitFileChangeNodeFilter(this._localFileChanges).filter(fileChange => nodePath.resolve(this._repository.rootUri.fsPath, fileChange.fileName) === fileName);
					let matchedFile: GitFileChangeNode;
					if (matchedFiles && matchedFiles.length) {
						matchedFile = matchedFiles[0];

						let contentDiff: string;
						if (document.isDirty) {
							const documentText = document.getText();
							const details = await this._repository.getObjectDetails(this._lastCommitSha, matchedFile.fileName);
							const idAtLastCommit = details.object;
							const idOfCurrentText = await this._repository.hashObject(documentText);

							// git diff <blobid> <blobid>
							contentDiff = await this._repository.diffBlobs(idAtLastCommit, idOfCurrentText);
						} else {
							// git diff sha -- fileName
							contentDiff = await this._repository.diffWith(this._lastCommitSha, matchedFile.fileName);
						}

						matchingComments = this._comments.filter(comment => nodePath.resolve(this._repository.rootUri.fsPath, comment.path) === fileName);
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
					}

					return {
						threads: this.fileCommentsToCommentThreads(matchedFile, matchingComments, vscode.CommentThreadCollapsibleState.Collapsed),
						commentingRanges: ranges,
						inDraftMode: await this._prManager.inDraftMode(this._prManager.activePullRequest)
					};
				}

				if (document.uri.scheme === 'pr') {
					const inDraftMode = await this._prManager.inDraftMode(this._prManager.activePullRequest);
					return providePRDocumentComments(document, this._prNumber, this._localFileChanges, inDraftMode);
				}

				if (document.uri.scheme === 'review') {
					// we should check whehter the docuemnt is original or modified.
					let query = fromReviewUri(document.uri);
					let isBase = query.base;

					let matchedFile = this.findMatchedFileChange(this._localFileChanges, document.uri);

					if (matchedFile) {
						matchingComments = matchedFile.comments;
						matchingComments.forEach(comment => { comment.absolutePosition = getAbsolutePosition(comment, matchedFile.diffHunks, isBase); });

						let diffHunks = matchedFile.diffHunks;

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

							ranges.push(new vscode.Range(startingLine, 1, startingLine + length, 1));
						}

						return {
							threads: this.fileCommentsToCommentThreads(matchedFile, matchingComments.filter(comment => comment.absolutePosition > 0), vscode.CommentThreadCollapsibleState.Expanded),
							commentingRanges: ranges,
						};
					}

					// comments are outdated
					matchedFile = this.findMatchedFileChange(this._obsoleteFileChanges, document.uri);
					let comments: Comment[] = [];
					if (!matchedFile) {
						// The file may be a change from a specific commit, check the comments themselves to see if they match it, as obsolete file changs
						// may not contain it
						try {
							query = fromReviewUri(document.uri);
							comments = this._comments.filter(comment => comment.path === query.path && `${comment.originalCommitId}^` === query.commit);
						} catch (_) {
							// Do nothing
						}

						if (!comments.length) {
							return null;
						}
					} else {
						comments = matchedFile.comments;
					}

					let sections = groupBy(comments, comment => String(comment.originalPosition)); // comment.position is null in this case.
					let ret: vscode.CommentThread[] = [];
					for (let i in sections) {
						let commentGroup = sections[i];
						const firstComment = commentGroup[0];
						let diffLine = getLastDiffLine(firstComment.diffHunk);
						const lineNumber = isBase
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
							resource: vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, firstComment.path)),
							range,
							comments: commentGroup.map(comment => {
								return {
									commentId: String(comment.id),
									body: new vscode.MarkdownString(comment.body),
									userName: comment.user.login,
									gravatar: comment.user.avatarUrl,
									canEdit: comment.canEdit,
									canDelete: comment.canDelete,
									isDraft: comment.isDraft
								};
							}),
							collapsibleState: vscode.CommentThreadCollapsibleState.Expanded
						});

						return {
							threads: ret,
							inDraftMode: await this._prManager.inDraftMode(this._prManager.activePullRequest)
						};
					}
				}
			},
			createNewCommentThread: this.createNewCommentThread.bind(this),
			replyToCommentThread: this.replyToCommentThread.bind(this),
			editComment: this.editComment.bind(this),
			deleteComment: this.deleteComment.bind(this),
			startDraft: supportsGraphQL ? this.startDraft.bind(this) : undefined,
			deleteDraft: supportsGraphQL ? this.deleteDraft.bind(this) : undefined,
			finishDraft: supportsGraphQL ? this.finishDraft.bind(this) : undefined,
			startDraftLabel: 'Start Review',
			deleteDraftLabel: 'Delete Review',
			finishDraftLabel: 'Submit Review'
		}));

		this._localToDispose.push(vscode.workspace.registerWorkspaceCommentProvider({
			onDidChangeCommentThreads: this._onDidChangeWorkspaceCommentThreads.event,
			provideWorkspaceComments: async (token: vscode.CancellationToken) => {
				const comments = await Promise.all(gitFileChangeNodeFilter(this._localFileChanges).map(async fileChange => {
					return this.fileCommentsToCommentThreads(fileChange, fileChange.comments, vscode.CommentThreadCollapsibleState.Expanded);
				}));
				const outdatedComments = gitFileChangeNodeFilter(this._obsoleteFileChanges).map(fileChange => {
					return this.outdatedCommentsToCommentThreads(fileChange, fileChange.comments, vscode.CommentThreadCollapsibleState.Expanded);
				});
				return [...comments, ...outdatedComments].reduce((prev, curr) => prev.concat(curr), []);
			}
		}));
	}

	private async startDraft(_document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<void> {
		await this._prManager.startReview(this._prManager.activePullRequest);
		this._onDidChangeDocumentCommentThreads.fire({
			added: [],
			changed: [],
			removed: [],
			inDraftMode: true
		});
	}

	private async deleteDraft(_document: vscode.TextDocument, _token: vscode.CancellationToken) {
		const deletedReviewComments = await this._prManager.deleteReview(this._prManager.activePullRequest);

		const removed = [];
		const changed = [];

		const oldCommentThreads = this.allCommentsToCommentThreads(this._comments, vscode.CommentThreadCollapsibleState.Expanded);
		oldCommentThreads.forEach(thread => {
			thread.comments = thread.comments.filter(comment => !deletedReviewComments.some(deletedComment => deletedComment.id.toString() === comment.commentId));
			if (!thread.comments.length) {
				removed.push(thread);
			} else {
				changed.push(thread);
			}
		});

		const commentsByFile = groupBy(deletedReviewComments, comment => comment.path);
		for (let filePath in commentsByFile) {
			const matchedFile = this._localFileChanges.find(fileChange => fileChange.fileName === filePath);
			if (matchedFile) {
				const deletedFileComments = commentsByFile[filePath];
				matchedFile.comments = matchedFile.comments.filter(comment => !deletedFileComments.some(deletedComment => deletedComment.id === comment.id));
			}
		}

		this._comments = this._comments.filter(comment => !deletedReviewComments.some(deletedComment => deletedComment.id === comment.id));

		this._onDidChangeDocumentCommentThreads.fire({
			added: [],
			changed,
			removed,
			inDraftMode: false
		});

		this._onDidChangeWorkspaceCommentThreads.fire({
			added: [],
			changed,
			removed,
			inDraftMode: false
		});
	}

	private async finishDraft(document: vscode.TextDocument, _token: vscode.CancellationToken) {
		try {
			await this._prManager.submitReview(this._prManager.activePullRequest);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to submit the review: ${e}`);
		}
	}

	private findMatchedFileChange(fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[], uri: vscode.Uri): GitFileChangeNode {
		let query = fromReviewUri(uri);
		let matchedFiles = fileChanges.filter(fileChange => {
			if (fileChange instanceof RemoteFileChangeNode) {
				return false;
			}

			if (fileChange.fileName !== query.path) {
				return false;
			}

			let q = JSON.parse(fileChange.filePath.query);

			if (q.commit === query.commit) {
				return true;
			}

			q = JSON.parse(fileChange.parentFilePath.query);

			if (q.commit === query.commit) {
				return true;
			}
			return false;
		});

		if (matchedFiles && matchedFiles.length) {
			return matchedFiles[0] as GitFileChangeNode;
		}

		return null;
	}

	public async switch(pr: PullRequestModel): Promise<void> {
		Logger.appendLine(`Review> switch to Pull Request #${pr.prNumber} - start`);
		this.switchingToReviewMode = true;
		await this._prManager.fullfillPullRequestMissingInfo(pr);

		this.statusBarItem.text = '$(sync~spin) Switching to Review Mode';
		this.statusBarItem.command = null;
		this.statusBarItem.show();

		try {
			const didLocalCheckout = await this._prManager.checkoutExistingPullRequestBranch(pr);

			if (!didLocalCheckout) {
				await this._prManager.fetchAndCheckout(pr);
			}
		} catch (e) {
			Logger.appendLine(`Review> checkout failed #${JSON.stringify(e)}`);
			this.switchingToReviewMode = false;

			if (e.gitErrorCode) {
				// for known git errors, we should provide actions for users to continue.
				if (e.gitErrorCode === GitErrorCodes.LocalChangesOverwritten || e.gitErrorCode === GitErrorCodes.DirtyWorkTree) {
					vscode.window.showErrorMessage('Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches');
					return;
				}
			}

			vscode.window.showErrorMessage(formatError(e));
			// todo, we should try to recover, for example, git checkout succeeds but set config fails.
			return;
		}

		this._telemetry.on('pr.checkout');
		Logger.appendLine(`Review> switch to Pull Request #${pr.prNumber} - done`, ReviewManager.ID);
		this.switchingToReviewMode = false;
		await this._repository.status();
	}

	public async publishBranch(branch: Branch): Promise<Branch> {
		const potentialTargetRemotes = this._prManager.getGitHubRemotes();
		const selectedRemote = (await this.getRemote(potentialTargetRemotes, `Pick a remote to publish the branch '${branch.name}' to:`)).remote;

		if (!selectedRemote) {
			return;
		}

		return new Promise<Branch>(async (resolve) => {
			let inputBox = vscode.window.createInputBox();
			inputBox.value = branch.name;
			inputBox.ignoreFocusOut = true;
			inputBox.prompt = potentialTargetRemotes.length === 1 ? `The branch '${branch.name}' is not published yet, pick a name for the upstream branch` : 'Pick a name for the upstream branch';
			let validate = async function (value) {
				try {
					inputBox.busy = true;
					let remoteBranch = await this._prManager.getBranch(selectedRemote, value);
					if (remoteBranch) {
						inputBox.validationMessage = `Branch ${value} already exists in ${selectedRemote.owner}/${selectedRemote.repositoryName}`;
					} else {
						inputBox.validationMessage = null;
					}
				} catch (e) {
					inputBox.validationMessage = null;
				}

				inputBox.busy = false;
			};
			await validate(branch.name);
			inputBox.onDidChangeValue(validate.bind(this));
			inputBox.onDidAccept(async () => {
				inputBox.validationMessage = null;
				inputBox.hide();
				try {
					// since we are probably pushing a remote branch with a different name, we use the complete synatx
					// git push -u origin local_branch:remote_branch
					await this._repository.push(selectedRemote.remoteName, `${branch.name}:${inputBox.value}`, true);
				} catch (err) {
					if (err.gitErrorCode === GitErrorCodes.PushRejected) {
						vscode.window.showWarningMessage(`Can't push refs to remote, try running 'git pull' first to integrate with your change`, {
							modal: true
						});

						resolve(null);
					}

					// we can't handle the error
					throw err;
				}

				// we don't want to wait for repository status update
				let latestBranch = await this._repository.getBranch(branch.name);
				if (!latestBranch || !latestBranch.upstream) {
					resolve(null);
				}

				resolve(latestBranch);
			});

			inputBox.show();
		});
	}

	private async getRemote(potentialTargetRemotes: Remote[], placeHolder: string, defaultUpstream?: RemoteQuickPickItem): Promise<RemoteQuickPickItem> {
		if (!potentialTargetRemotes.length) {
			vscode.window.showWarningMessage(`No GitHub remotes found. Add a remote and try again.`);
			return null;
		}

		if (potentialTargetRemotes.length === 1 && !defaultUpstream) {
			return RemoteQuickPickItem.fromRemote(potentialTargetRemotes[0]);
		}

		if (potentialTargetRemotes.length === 1
			&& defaultUpstream
			&& defaultUpstream.owner === potentialTargetRemotes[0].owner
			&& defaultUpstream.name === potentialTargetRemotes[0].repositoryName) {
			return defaultUpstream;
		}

		let defaultUpstreamWasARemote = false;
		const picks: RemoteQuickPickItem[] = potentialTargetRemotes.map(remote => {
			const remoteQuickPick = RemoteQuickPickItem.fromRemote(remote);
			if (defaultUpstream) {
				const { owner, name } = defaultUpstream;
				remoteQuickPick.picked = remoteQuickPick.owner === owner && remoteQuickPick.name === name;
				if (remoteQuickPick.picked) {
					defaultUpstreamWasARemote = true;
				}
			}
			return remoteQuickPick;
		});
		if (!defaultUpstreamWasARemote && defaultUpstream) {
			picks.unshift(defaultUpstream);
		}

		const selected: RemoteQuickPickItem = await vscode.window.showQuickPick<RemoteQuickPickItem>(picks, {
			ignoreFocusOut: true,
			placeHolder: placeHolder
		});

		if (!selected) {
			return null;
		}

		return selected;
	}

	public async createPullRequest(): Promise<void> {
		const pullRequestDefaults = await this._prManager.getPullRequestDefaults();
		const githubRemotes = this._prManager.getGitHubRemotes();
		let targetRemote = await this.getRemote(githubRemotes, 'Choose a remote which you want to send a pull request to',
			new RemoteQuickPickItem(pullRequestDefaults.owner, pullRequestDefaults.repo, 'Parent Fork')
		);

		if (!targetRemote) {
			return;
		}

		const base: string = targetRemote.remote
			? (await this._prManager.getMetadata(targetRemote.remote.remoteName)).default_branch
			: pullRequestDefaults.base;
		const target = await vscode.window.showInputBox({
			value: base,
			ignoreFocusOut: true,
			prompt: `Choose target branch for ${targetRemote.owner}/${targetRemote.name}`,
		});

		if (!target) {
			return;
		}

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Creating Pull Request',
			cancellable: false
		}, async (progress) => {
			progress.report({ increment: 10 });
			let HEAD = this._repository.state.HEAD;
			const branchName = HEAD.name;

			if (!HEAD.upstream) {
				progress.report({ increment: 10, message: `Start publishing branch ${branchName}` });
				HEAD = await this.publishBranch(HEAD);
				if (!HEAD) {
					return;
				}
				progress.report({ increment: 20, message: `Branch ${branchName} published` });
			} else {
				progress.report({ increment: 30, message: `Start creating pull request.` });

			}

			const headRemote = githubRemotes.find(remote => remote.remoteName === HEAD.upstream.remote);
			if (!headRemote) {
				return;
			}

			pullRequestDefaults.base = target;
			// For cross-repository pull requests, the owner must be listed. Always list to be safe. See https://developer.github.com/v3/pulls/#create-a-pull-request.
			pullRequestDefaults.head = `${headRemote.owner}:${branchName}`;
			pullRequestDefaults.owner = targetRemote.owner;
			pullRequestDefaults.repo = targetRemote.name;
			const pullRequestModel = await this._prManager.createPullRequest(pullRequestDefaults);

			if (pullRequestModel) {
				progress.report({ increment: 30, message: `Pull Request #${pullRequestModel.prNumber} Created` });
				await this.updateState();
				await vscode.commands.executeCommand('pr.openDescription', pullRequestModel);
				progress.report({ increment: 30 });
			} else {
				// error: Unhandled Rejection at: Promise [object Promise]. Reason: {"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for rebornix:tree-sitter."}],"documentation_url":"https://developer.github.com/v3/pulls/#create-a-pull-request"}.
				progress.report({ increment: 90, message: `Failed to create pull request for ${pullRequestDefaults.head}` });
			}
		});
	}

	private clear(quitReviewMode: boolean) {
		this._updateMessageShown = false;

		this._localToDispose.forEach(disposeable => disposeable.dispose());

		if (quitReviewMode) {
			this._prNumber = null;
			this._prManager.activePullRequest = null;

			if (this._statusBarItem) {
				this._statusBarItem.hide();
			}

			if (this._prFileChangesProvider) {
				this.prFileChangesProvider.hide();
			}

			// Ensure file explorer decorations are removed. When switching to a different PR branch,
			// comments are recalculated when getting the data and the change decoration fired then,
			// so comments only needs to be emptied in this case.
			this._comments = [];
			this._onDidChangeDecorations.fire();

			vscode.commands.executeCommand('pr.refreshList');
		}
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		let { path, commit } = fromReviewUri(uri);
		let changedItems = gitFileChangeNodeFilter(this._localFileChanges)
			.filter(change => change.fileName === path)
			.filter(fileChange => fileChange.sha === commit || (fileChange.parentSha ? fileChange.parentSha : `${fileChange.sha}^`) === commit);

		if (changedItems.length) {
			let changedItem = changedItems[0];
			let diffChangeTypeFilter = commit === changedItem.sha ? DiffChangeType.Delete : DiffChangeType.Add;
			let ret = changedItem.diffHunks.map(diffHunk => diffHunk.diffLines.filter(diffLine => diffLine.type !== diffChangeTypeFilter).map(diffLine => diffLine.text));
			return ret.reduce((prev, curr) => prev.concat(...curr), []).join('\n');
		}

		changedItems = gitFileChangeNodeFilter(this._obsoleteFileChanges)
			.filter(change => change.fileName === path)
			.filter(fileChange => fileChange.sha === commit || (fileChange.parentSha ? fileChange.parentSha : `${fileChange.sha}^`) === commit);

		if (changedItems.length) {
			// it's from obsolete file changes, which means the content is in complete.
			let changedItem = changedItems[0];
			let diffChangeTypeFilter = commit === changedItem.sha ? DiffChangeType.Delete : DiffChangeType.Add;
			let ret = [];
			let commentGroups = groupBy(changedItem.comments, comment => String(comment.originalPosition));

			for (let comment_position in commentGroups) {
				let lines = commentGroups[comment_position][0].diffHunks
					.map(diffHunk =>
						diffHunk.diffLines.filter(diffLine => diffLine.type !== diffChangeTypeFilter)
							.map(diffLine => diffLine.text)
					).reduce((prev, curr) => prev.concat(...curr), []);
				ret.push(...lines);
			}

			return ret.join('\n');
		}

		return null;
	}

	dispose() {
		this.clear(true);
		this._disposables.forEach(d => {
			d.dispose();
		});
	}
}
