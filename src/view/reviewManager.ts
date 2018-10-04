/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import * as vscode from 'vscode';
import { parseDiff, parsePatch } from '../common/diffHunk';
import { getDiffLineByPosition, getLastDiffLine, mapCommentsToHead, mapHeadLineToDiffHunkPosition, mapOldPositionToNew, getZeroBased, getAbsolutePosition } from '../common/diffPositionMapping';
import { toReviewUri, fromReviewUri, fromPRUri } from '../common/uri';
import { groupBy, formatError } from '../common/utils';
import { Comment } from '../common/comment';
import { GitChangeType, SlimFileChange } from '../common/file';
import { IPullRequestModel, IPullRequestManager, ITelemetry } from '../github/interface';
import { Repository, GitErrorCodes, Branch } from '../typings/git';
import { PullRequestChangesTreeDataProvider } from './prChangesTreeDataProvider';
import { GitContentProvider } from './gitContentProvider';
import { DiffChangeType } from '../common/diffHunk';
import { GitFileChangeNode, RemoteFileChangeNode, gitFileChangeNodeFilter } from './treeNodes/fileChangeNode';
import Logger from '../common/logger';
import { PullRequestsTreeDataProvider } from './prsTreeDataProvider';
import { IConfiguration } from '../authentication/configuration';
import { providePRDocumentComments, PRNode } from './treeNodes/pullRequestNode';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import { Remote, parseRepositoryRemotes } from '../common/remote';

export class ReviewManager implements vscode.DecorationProvider {
	private static _instance: ReviewManager;
	private _documentCommentProvider: vscode.Disposable;
	private _workspaceCommentProvider: vscode.Disposable;
	private _disposables: vscode.Disposable[];

	private _comments: Comment[] = [];
	private _localFileChanges: (GitFileChangeNode | RemoteFileChangeNode)[] = [];
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

	constructor(
		private _context: vscode.ExtensionContext,
		private _configuration: IConfiguration,
		private _repository: Repository,
		private _prManager: IPullRequestManager,
		private _telemetry: ITelemetry
	) {
		this._documentCommentProvider = null;
		this._workspaceCommentProvider = null;
		this._disposables = [];
		let gitContentProvider = new GitContentProvider(_repository);
		gitContentProvider.registerTextDocumentContentFallback(this.provideTextDocumentContent.bind(this));
		this._disposables.push(vscode.workspace.registerTextDocumentContentProvider('review', gitContentProvider));
		this._disposables.push(vscode.commands.registerCommand('review.openFile', (uri: vscode.Uri) => {
			let params = JSON.parse(uri.query);

			const activeTextEditor = vscode.window.activeTextEditor;
			const opts: vscode.TextDocumentShowOptions = {
				preserveFocus: false,
				viewColumn: vscode.ViewColumn.Active
			};

			// Check if active text editor has same path as other editor. we cannot compare via
			// URI.toString() here because the schemas can be different. Instead we just go by path.
			if (activeTextEditor && activeTextEditor.document.uri.path === uri.path) {
				opts.selection = activeTextEditor.selection;
			}

			vscode.commands.executeCommand('vscode.open', vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, params.path)), opts);
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

		this._prsTreeDataProvider = new PullRequestsTreeDataProvider(this._configuration, _prManager, this._telemetry);
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
		if (!this._validateStatusInProgress) {
			this._validateStatusInProgress = this.validateState();
		} else {
			this._validateStatusInProgress.then(_ => this._validateStatusInProgress = this.validateState());
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

			const comment = await this._prManager.createCommentReply(this._prManager.activePullRequest, text, thread.threadId);
			thread.comments.push({
				commentId: comment.id,
				body: new vscode.MarkdownString(comment.body),
				userName: comment.user.login,
				gravatar: comment.user.avatar_url
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
			const query = uri.query === '' ? undefined : JSON.parse(uri.query);
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
				commentId: rawComment.id,
				body: new vscode.MarkdownString(rawComment.body),
				userName: rawComment.user.login,
				gravatar: rawComment.user.avatar_url
			};

			let commentThread: vscode.CommentThread = {
				threadId: comment.commentId,
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
				changed: changed
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

	private async getPullRequestData(pr: IPullRequestModel): Promise<void> {
		try {
			this._comments = await this._prManager.getPullRequestComments(pr);
			let activeComments = this._comments.filter(comment => comment.position);
			let outdatedComments = this._comments.filter(comment => !comment.position);

			const data = await this._prManager.getPullRequestChangedFiles(pr);
			await this._prManager.fullfillPullRequestMissingInfo(pr);
			let headSha = pr.head.sha;
			let mergeBase = pr.mergeBase;

			const contentChanges = await parseDiff(data, this._repository, mergeBase);
			this._localFileChanges = contentChanges.map(change => {
				if (change instanceof SlimFileChange) {
					return new RemoteFileChangeNode(
						pr,
						change.status,
						change.fileName,
						change.blobUrl
					);
				}

				const uri = vscode.Uri.parse(change.fileName);
				let changedItem = new GitFileChangeNode(
					pr,
					change.status,
					change.fileName,
					change.blobUrl,
					toReviewUri(uri, null, null, change.status === GitChangeType.DELETE ? '' : pr.head.sha, false, { base: false }),
					toReviewUri(uri, null, null, change.status === GitChangeType.ADD ? '' : pr.base.sha, false, { base: true }),
					change.isPartial,
					change.diffHunks,
					activeComments.filter(comment => comment.path === change.fileName),
					headSha
				);
				return changedItem;
			});

			let commitsGroup = groupBy(outdatedComments, comment => comment.original_commit_id);
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
						pr,
						GitChangeType.MODIFY,
						fileName,
						null,
						toReviewUri(uri, fileName, null, oldComments[0].original_commit_id, true, { base: false }),
						toReviewUri(uri, fileName, null, oldComments[0].original_commit_id, true, { base: true }),
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
			let diffLine = getDiffLineByPosition(firstComment.diff_hunks, firstComment.original_position);

			if (diffLine) {
				firstComment.absolutePosition = diffLine.newLineNumber;
			}

			const pos = new vscode.Position(getZeroBased(firstComment.absolutePosition), 0);
			const range = new vscode.Range(pos, pos);

			ret.push({
				threadId: firstComment.id,
				resource: fileChange.filePath,
				range,
				comments: comments.map(comment => {
					return {
						commentId: comment.id,
						body: new vscode.MarkdownString(comment.body),
						userName: comment.user.login,
						gravatar: comment.user.avatar_url,
						command: {
							title: 'View Changes',
							command: 'pr.viewChanges',
							arguments: [
								fileChange
							]
						}
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
				threadId: firstComment.id,
				resource: vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, firstComment.path)),
				range,
				comments: comments.map(comment => {
					return {
						commentId: comment.id,
						body: new vscode.MarkdownString(comment.body),
						userName: comment.user.login,
						gravatar: comment.user.avatar_url,
						command: command
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
			let fileComments = fileCommentGroups[file];

			let matchedFiles = gitFileChangeNodeFilter(this._localFileChanges).filter(fileChange => fileChange.fileName === file);

			if (matchedFiles && matchedFiles.length) {
				return this.fileCommentsToCommentThreads(matchedFiles[0], fileComments, collapsibleState);
			} else {
				return [];
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
				letter: '◆'
			};
		}

		return undefined;
	}

	private registerCommentProvider() {
		this._documentCommentProvider = vscode.workspace.registerDocumentCommentProvider({
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
					};
				}

				if (document.uri.scheme === 'pr') {
					return providePRDocumentComments(document, this._prNumber, this._localFileChanges);
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
					let comments = [];
					if (!matchedFile) {
						// The file may be a change from a specific commit, check the comments themselves to see if they match it, as obsolete file changs
						// may not contain it
						try {
							query = JSON.parse(document.uri.query);
							comments = this._comments.filter(comment => comment.path === query.path && `${comment.original_commit_id}^` === query.commit);
						} catch (_) {
							// Do nothing
						}

						if (!comments.length) {
							return null;
						}
					} else {
						comments = matchedFile.comments;
					}

					let sections = groupBy(comments, comment => String(comment.original_position)); // comment.position is null in this case.
					let ret: vscode.CommentThread[] = [];
					for (let i in sections) {
						let commentGroup = sections[i];
						const firstComment = commentGroup[0];
						let diffLine = getLastDiffLine(firstComment.diff_hunk);
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
							threadId: firstComment.id,
							resource: vscode.Uri.file(nodePath.resolve(this._repository.rootUri.fsPath, firstComment.path)),
							range,
							comments: commentGroup.map(comment => {
								return {
									commentId: comment.id,
									body: new vscode.MarkdownString(comment.body),
									userName: comment.user.login,
									gravatar: comment.user.avatar_url
								};
							}),
							collapsibleState: vscode.CommentThreadCollapsibleState.Expanded
						});

						return {
							threads: ret
						};
					}
				}
			},
			createNewCommentThread: this.createNewCommentThread.bind(this),
			replyToCommentThread: this.replyToCommentThread.bind(this)
		});

		this._workspaceCommentProvider = vscode.workspace.registerWorkspaceCommentProvider({
			onDidChangeCommentThreads: this._onDidChangeWorkspaceCommentThreads.event,
			provideWorkspaceComments: async (token: vscode.CancellationToken) => {
				const comments = await Promise.all(gitFileChangeNodeFilter(this._localFileChanges).map(async fileChange => {
					return this.fileCommentsToCommentThreads(fileChange, fileChange.comments, vscode.CommentThreadCollapsibleState.Expanded);
				}));
				const outdatedComments = gitFileChangeNodeFilter(this._obsoleteFileChanges).map(fileChange => {
					return this.outdatedCommentsToCommentThreads(fileChange, fileChange.comments, vscode.CommentThreadCollapsibleState.Expanded);
				});
				return [...comments, ...outdatedComments].reduce((prev, curr) => prev.concat(curr), []);
			},
			createNewCommentThread: this.createNewCommentThread.bind(this), replyToCommentThread: this.replyToCommentThread.bind(this)
		});
	}

	private findMatchedFileChange(fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[], uri: vscode.Uri): GitFileChangeNode {
		let query = JSON.parse(uri.query);
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

	public async switch(pr: IPullRequestModel): Promise<void> {
		Logger.appendLine(`Review> switch to Pull Request #${pr.prNumber}`);
		await this._prManager.fullfillPullRequestMissingInfo(pr);

		if (this._repository.state.workingTreeChanges.length > 0) {
			vscode.window.showErrorMessage('Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches');
			throw new Error('Has local changes');
		}

		this.statusBarItem.text = '$(sync~spin) Switching to Review Mode';
		this.statusBarItem.command = null;
		this.statusBarItem.show();

		try {
			let localBranchInfo = await this._prManager.getBranchForPullRequestFromExistingRemotes(pr);

			if (localBranchInfo) {
				Logger.appendLine(`Review> there is already one local branch ${localBranchInfo.remote.remoteName}/${localBranchInfo.branch} associated with Pull Request #${pr.prNumber}`);
				await this._prManager.fetchAndCheckout(localBranchInfo.remote, localBranchInfo.branch, pr);
			} else {
				Logger.appendLine(`Review> there is no local branch associated with Pull Request #${pr.prNumber}, we will create a new branch.`);
				await this._prManager.createAndCheckout(pr);
			}
		} catch (e) {
			Logger.appendLine(`Review> checkout failed #${JSON.stringify(e)}`);

			if (e.gitErrorCode) {
				// for known git errors, we should provide actions for users to continue.
				if (e.gitErrorCode === GitErrorCodes.LocalChangesOverwritten) {
					vscode.window.showErrorMessage('Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches');
					return;
				}
			}

			vscode.window.showErrorMessage(formatError(e));
			// todo, we should try to recover, for example, git checkout succeeds but set config fails.
			return;
		}

		this._telemetry.on('pr.checkout');
		await this._repository.status();
	}

	private clear(quitReviewMode: boolean) {
		this._updateMessageShown = false;

		if (this._documentCommentProvider) {
			this._documentCommentProvider.dispose();
		}

		if (this._workspaceCommentProvider) {
			this._workspaceCommentProvider.dispose();
		}

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
			let commentGroups = groupBy(changedItem.comments, comment => String(comment.original_position));

			for (let comment_position in commentGroups) {
				let lines = commentGroups[comment_position][0].diff_hunks
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
		this._disposables.forEach(dispose => {
			dispose.dispose();
		});
	}
}