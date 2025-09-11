/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nodePath from 'path';
import { v4 as uuid } from 'uuid';
import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { GitApiImpl } from '../api/api1';
import { CommentHandler, registerCommentHandler, unregisterCommentHandler } from '../commentHandlerResolver';
import { DiffSide, IReviewThread, SubjectType } from '../common/comment';
import { getCommentingRanges } from '../common/commentingRanges';
import { mapNewPositionToOld, mapOldPositionToNew } from '../common/diffPositionMapping';
import { commands, contexts } from '../common/executeCommands';
import { GitChangeType, InMemFileChange } from '../common/file';
import { disposeAll } from '../common/lifecycle';
import Logger from '../common/logger';
import { PR_SETTINGS_NAMESPACE, PULL_BRANCH, PULL_PR_BRANCH_BEFORE_CHECKOUT, PullPRBranchVariants } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { fromReviewUri, ReviewUriParams, Schemes, toReviewUri } from '../common/uri';
import { formatError, groupBy, uniqBy } from '../common/utils';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../github/prComment';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import {
	CommentReactionHandler,
	createVSCodeCommentThreadForReviewThread,
	getRepositoryForFile,
	isFileInRepo,
	setReplyAuthor,
	threadRange,
	updateCommentReviewState,
	updateCommentThreadLabel,
	updateThread,
	updateThreadWithRange,
} from '../github/utils';
import { CommentControllerBase } from './commentControllBase';
import { RemoteFileChangeModel } from './fileChangeModel';
import { ReviewManager } from './reviewManager';
import { ReviewModel } from './reviewModel';
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';

export interface SuggestionInformation {
	originalStartLine: number;
	originalLineLength: number;
	suggestionContent: string;
}

export class ReviewCommentController extends CommentControllerBase implements CommentHandler, vscode.CommentingRangeProvider2, CommentReactionHandler {
	private static readonly _ID = 'ReviewCommentController';
	private static readonly _PREFIX = 'github-review';
	private _commentHandlerId: string;

	// Note: marked as protected so that tests can verify caches have been updated correctly without breaking type safety
	protected _workspaceFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};
	protected _reviewSchemeFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};
	protected _obsoleteFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};

	protected _visibleNormalTextEditors: vscode.TextEditor[] = [];

	private _pendingCommentThreadAdds: GHPRCommentThread[] = [];
	private readonly _context: vscode.ExtensionContext;
	public readonly resourceHints = { schemes: [Schemes.Review] };

	constructor(
		private _reviewManager: ReviewManager,
		folderRepoManager: FolderRepositoryManager,
		private _repository: Repository,
		private _reviewModel: ReviewModel,
		private _gitApi: GitApiImpl,
		telemetry: ITelemetry
	) {
		super(folderRepoManager, telemetry);
		this._context = this._folderRepoManager.context;
		this._commentController = this._register(vscode.comments.createCommentController(
			`${ReviewCommentController.PREFIX}-${folderRepoManager.activePullRequest?.remote.owner}-${folderRepoManager.activePullRequest?.remote.owner}-${folderRepoManager.activePullRequest!.number}`,
			vscode.l10n.t('Pull Request ({0})', folderRepoManager.activePullRequest!.title),
		));
		this._commentController.commentingRangeProvider = this as vscode.CommentingRangeProvider;
		this._commentController.reactionHandler = this.toggleReaction.bind(this);
		this.updateResourcesWithCommentingRanges();
		this._register(this._folderRepoManager.onDidChangeActivePullRequest(() => this.updateResourcesWithCommentingRanges()));
		this._commentHandlerId = uuid();
		registerCommentHandler(this._commentHandlerId, this, _repository);
	}

	// #region initialize
	async initialize(): Promise<void> {
		this._visibleNormalTextEditors = vscode.window.visibleTextEditors.filter(
			ed => ed.document.uri.scheme !== 'comment',
		);
		await this._folderRepoManager.activePullRequest!.validateDraftMode();
		await this.initializeCommentThreads();
		await this.registerListeners();
	}

	/**
	 * Creates a comment thread for a thread that is not on the latest changes.
	 * @param path The path to the file the comment thread is on.
	 * @param thread The comment thread information from GitHub.
	 * @returns A GHPRCommentThread that has been created on an editor.
	 */
	private async _createOutdatedCommentThread(path: string, thread: IReviewThread): Promise<GHPRCommentThread> {
		const commit = thread.comments[0].originalCommitId!;
		const uri = vscode.Uri.file(nodePath.join(`commit~${commit.substr(0, 8)}`, path));
		const reviewUri = toReviewUri(
			uri,
			path,
			undefined,
			commit,
			true,
			{ base: thread.diffSide === DiffSide.LEFT },
			this._repository.rootUri,
		);

		const range = thread.subjectType === SubjectType.FILE ? undefined : threadRange(thread.originalStartLine - 1, thread.originalEndLine - 1);
		return createVSCodeCommentThreadForReviewThread(this._context, reviewUri, range, thread, this._commentController, (await this._folderRepoManager.getCurrentUser()), this.githubReposForPullRequest(this._folderRepoManager.activePullRequest));
	}

	/**
	 * Creates a comment thread for a thread that appears on the right-hand side, which is a
	 * document that has a scheme matching the workspace uri scheme, typically 'file'.
	 * @param uri The uri to the file the comment thread is on.
	 * @param path The path to the file the comment thread is on.
	 * @param thread The comment thread information from GitHub.
	 * @returns A GHPRCommentThread that has been created on an editor.
	 */
	private async _createWorkspaceCommentThread(
		uri: vscode.Uri,
		path: string,
		thread: IReviewThread,
	): Promise<GHPRCommentThread> {
		let startLine = thread.startLine;
		let endLine = thread.endLine;
		const localDiff = await this._repository.diffWithHEAD(path);
		if (localDiff) {
			startLine = mapOldPositionToNew(localDiff, startLine);
			endLine = mapOldPositionToNew(localDiff, endLine);
		}

		let range: vscode.Range | undefined;
		if (thread.subjectType !== SubjectType.FILE) {
			const adjustedStartLine = startLine - 1;
			const adjustedEndLine = endLine - 1;
			if (adjustedStartLine < 0 || adjustedEndLine < 0) {
				Logger.error(`Mapped new position for workspace comment thread is invalid. Original: (${thread.startLine}, ${thread.endLine}) New: (${adjustedStartLine}, ${adjustedEndLine})`, ReviewCommentController.ID);
			}
			range = threadRange(adjustedStartLine, adjustedEndLine);
		}
		return createVSCodeCommentThreadForReviewThread(this._context, uri, range, thread, this._commentController, (await this._folderRepoManager.getCurrentUser()), this.githubReposForPullRequest(this._folderRepoManager.activePullRequest));
	}

	/**
	 * Creates a comment thread for a thread that appears on the left-hand side, which is a
	 * document that has a 'review' scheme whose content is created by the extension.
	 * @param uri The uri to the file the comment thread is on.
	 * @param path The path to the file the comment thread is on.
	 * @param thread The comment thread information from GitHub.
	 * @returns A GHPRCommentThread that has been created on an editor.
	 */
	private async _createReviewCommentThread(uri: vscode.Uri, path: string, thread: IReviewThread): Promise<GHPRCommentThread> {
		if (!this._folderRepoManager.activePullRequest?.mergeBase) {
			throw new Error('Cannot create review comment thread without an active pull request base.');
		}
		const reviewUri = toReviewUri(
			uri,
			path,
			undefined,
			this._folderRepoManager.activePullRequest.mergeBase,
			false,
			{ base: true },
			this._repository.rootUri,
		);

		const range = thread.subjectType === SubjectType.FILE ? undefined : threadRange(thread.startLine - 1, thread.endLine - 1);
		return createVSCodeCommentThreadForReviewThread(this._context, reviewUri, range, thread, this._commentController, (await this._folderRepoManager.getCurrentUser()), this.githubReposForPullRequest(this._folderRepoManager.activePullRequest));
	}

	private async _doInitializeCommentThreads(reviewThreads: IReviewThread[]): Promise<void> {
		// First clean up all the old comments.
		for (const key in this._workspaceFileChangeCommentThreads) {
			disposeAll(this._workspaceFileChangeCommentThreads[key]);
		}
		this._workspaceFileChangeCommentThreads = {};
		for (const key in this._reviewSchemeFileChangeCommentThreads) {
			disposeAll(this._reviewSchemeFileChangeCommentThreads[key]);
		}
		this._reviewSchemeFileChangeCommentThreads = {};
		for (const key in this._obsoleteFileChangeCommentThreads) {
			disposeAll(this._obsoleteFileChangeCommentThreads[key]);
		}
		this._obsoleteFileChangeCommentThreads = {};

		const threadsByPath = groupBy(reviewThreads, thread => thread.path);

		Object.keys(threadsByPath).forEach(path => {
			const threads = threadsByPath[path];
			const firstThread = threads[0];
			if (firstThread) {
				const fullPath = nodePath.join(this._repository.rootUri.path, firstThread.path).replace(/\\/g, '/');
				const uri = this._repository.rootUri.with({ path: fullPath });

				let rightSideCommentThreads: GHPRCommentThread[] = [];
				let leftSideThreads: GHPRCommentThread[] = [];
				let outdatedCommentThreads: GHPRCommentThread[] = [];

				const threadPromises = threads.map(async thread => {
					if (thread.isOutdated) {
						outdatedCommentThreads.push(await this.createOutdatedCommentThread(path, thread));
					} else {
						if (thread.diffSide === DiffSide.RIGHT) {
							rightSideCommentThreads.push(await this.createWorkspaceCommentThread(uri, path, thread));
						} else {
							leftSideThreads.push(await this.createReviewCommentThread(uri, path, thread));
						}
					}
				});

				Promise.all(threadPromises);

				this._workspaceFileChangeCommentThreads[path] = rightSideCommentThreads;
				this._reviewSchemeFileChangeCommentThreads[path] = leftSideThreads;
				this._obsoleteFileChangeCommentThreads[path] = outdatedCommentThreads;
			}
		});
		this.updateResourcesWithCommentingRanges();
	}

	/**
	 * Causes pre-fetching of commenting ranges to occur for all files in the active PR
	 */
	private _updateResourcesWithCommentingRanges(): void {
		// only prefetch for small PRs
		if (this._folderRepoManager.activePullRequest && this._folderRepoManager.activePullRequest.fileChanges.size < 30) {
			for (const [file, change] of (this._folderRepoManager.activePullRequest?.fileChanges.entries() ?? [])) {
				if (change.status !== GitChangeType.DELETE) {
					const uri = vscode.Uri.joinPath(this._folderRepoManager.repository.rootUri, file);
					Logger.trace(`Prefetching commenting ranges for ${uri.toString()}`, ReviewCommentController.ID);
					vscode.workspace.openTextDocument(uri);
				}
			}
		}
	}

	private async _initializeCommentThreads(): Promise<void> {
		const activePullRequest = this._folderRepoManager.activePullRequest;
		if (!activePullRequest || !activePullRequest.isResolved()) {
			return;
		}
		return this.doInitializeCommentThreads(activePullRequest.reviewThreadsCache);
	}

	private async _registerListeners(): Promise<void> {
		const activePullRequest = this._folderRepoManager.activePullRequest;
		if (!activePullRequest) {
			return;
		}

		this._register(
			activePullRequest.onDidChangePendingReviewState(newDraftMode => {
				[
					this._workspaceFileChangeCommentThreads,
					this._obsoleteFileChangeCommentThreads,
					this._reviewSchemeFileChangeCommentThreads,
				].forEach(commentThreadMap => {
					for (const fileName in commentThreadMap) {
						commentThreadMap[fileName].forEach(thread => {
							updateCommentReviewState(thread, newDraftMode);
							updateCommentThreadLabel(thread);
						});
					}
				});
			}),
		);

		this._register(
			activePullRequest.onDidChangeReviewThreads(e => {
				const githubRepositories = this.githubReposForPullRequest(this._folderRepoManager.activePullRequest);
				e.added.forEach(async thread => {
					const { path } = thread;

					const index = this._pendingCommentThreadAdds.findIndex(async t => {
						const fileName = this._folderRepoManager.gitRelativeRootPath(t.uri.path);
						if (fileName !== thread.path) {
							return false;
						}

						const diff = await this.getContentDiff(t.uri, fileName);
						const line = t.range ? mapNewPositionToOld(diff, t.range.end.line) : 0;
						const sameLine = line + 1 === thread.endLine;
						return sameLine;
					});

					let newThread: GHPRCommentThread;
					if (index > -1) {
						newThread = this._pendingCommentThreadAdds[index];
						newThread.gitHubThreadId = thread.id;
						newThread.comments = thread.comments.map(c => new GHPRComment(this._context, c, newThread, githubRepositories));
						updateThreadWithRange(this._context, newThread, thread, githubRepositories);
						this._pendingCommentThreadAdds.splice(index, 1);
					} else {
						const fullPath = nodePath.join(this._repository.rootUri.path, path).replace(/\\/g, '/');
						const uri = this._repository.rootUri.with({ path: fullPath });
						if (thread.isOutdated) {
							newThread = await this.createOutdatedCommentThread(path, thread);
						} else {
							if (thread.diffSide === DiffSide.RIGHT) {
								newThread = await this.createWorkspaceCommentThread(uri, path, thread);
							} else {
								newThread = await this.createReviewCommentThread(uri, path, thread);
							}
						}
					}

					const threadMap = thread.isOutdated
						? this._obsoleteFileChangeCommentThreads
						: thread.diffSide === DiffSide.RIGHT
							? this._workspaceFileChangeCommentThreads
							: this._reviewSchemeFileChangeCommentThreads;

					if (threadMap[path]) {
						threadMap[path].push(newThread);
					} else {
						threadMap[path] = [newThread];
					}
				});

				e.changed.forEach(thread => {
					const match = this._findMatchingThread(thread);
					if (match.index > -1) {
						const matchingThread = match.threadMap[thread.path][match.index];
						updateThread(this._context, matchingThread, thread, githubRepositories);
					}
				});

				e.removed.forEach(thread => {
					const match = this._findMatchingThread(thread);
					if (match.index > -1) {
						const matchingThread = match.threadMap[thread.path][match.index];
						match.threadMap[thread.path].splice(match.index, 1);
						matchingThread.dispose();
					}
				});

				this.updateResourcesWithCommentingRanges();
			}),
		);
	}

	private _findMatchingThread(thread: IReviewThread): { threadMap: { [key: string]: GHPRCommentThread[] }, index: number } {
		const threadMap = thread.isOutdated
			? this._obsoleteFileChangeCommentThreads
			: thread.diffSide === DiffSide.RIGHT
				? this._workspaceFileChangeCommentThreads
				: this._reviewSchemeFileChangeCommentThreads;

		let index = threadMap[thread.path]?.findIndex(t => t.gitHubThreadId === thread.id) ?? -1;
		if ((index === -1) && thread.isOutdated) {
			// The thread has become outdated and needs to be moved to the obsolete threads.
			index = this._workspaceFileChangeCommentThreads[thread.path]?.findIndex(t => t.gitHubThreadId === thread.id) ?? -1;
			if (index > -1) {
				const matchingThread = this._workspaceFileChangeCommentThreads[thread.path]!.splice(index, 1)[0];
				if (!this._obsoleteFileChangeCommentThreads[thread.path]) {
					this._obsoleteFileChangeCommentThreads[thread.path] = [];
				}
				this._obsoleteFileChangeCommentThreads[thread.path]!.push(matchingThread);
			}
		}
		return { threadMap, index };
	}

	private _commentContentChangedListener: vscode.Disposable | undefined;
	protected onDidChangeActiveTextEditor(editor: vscode.TextEditor | undefined) {
		this._commentContentChangedListener?.dispose();
		this._commentContentChangedListener = undefined;

		const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const activeUri = activeTab?.input instanceof vscode.TabInputText ? activeTab.input.uri : (activeTab?.input instanceof vscode.TabInputTextDiff ? activeTab.input.modified : undefined);

		if (editor && activeUri && editor.document.uri.authority.startsWith(ReviewCommentController.PREFIX) && (activeUri.scheme === Schemes.File)) {
			if (this._folderRepoManager.activePullRequest && activeUri.toString().startsWith(this._repository.rootUri.toString())) {
				this.tryAddCopilotMention(editor, this._folderRepoManager.activePullRequest);
			}
		}

		if (editor?.document.uri.scheme !== Schemes.Comment) {
			return;
		}
		const updateHasSuggestion = () => {
			if (editor.document.getText().includes('```suggestion')) {
				commands.setContext(contexts.ACTIVE_COMMENT_HAS_SUGGESTION, true);
			} else {
				commands.setContext(contexts.ACTIVE_COMMENT_HAS_SUGGESTION, false);
			}
		};
		this._commentContentChangedListener = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() !== editor.document.uri.toString()) {
				return;
			}
			updateHasSuggestion();
		});
		updateHasSuggestion();
	}

	public updateCommentExpandState(expand: boolean) {
		const activePullRequest = this._folderRepoManager.activePullRequest;
		if (!activePullRequest) {
			return undefined;
		}
		const githubRepositories = this.githubReposForPullRequest(activePullRequest);
		function updateThreads(threads: { [key: string]: GHPRCommentThread[] }, reviewThreads: Map<string, Map<string, IReviewThread>>) {
			if (reviewThreads.size === 0) {
				return;
			}
			for (const path of reviewThreads.keys()) {
				const reviewThreadsForPath = reviewThreads.get(path)!;
				const commentThreads = threads[path];
				for (const commentThread of commentThreads) {
					const reviewThread = reviewThreadsForPath.get(commentThread.gitHubThreadId)!;
					updateThread(this._context, commentThread, reviewThread, githubRepositories, expand);
				}
			}
		}

		const obsoleteReviewThreads: Map<string, Map<string, IReviewThread>> = new Map();
		const reviewSchemeReviewThreads: Map<string, Map<string, IReviewThread>> = new Map();
		const workspaceFileReviewThreads: Map<string, Map<string, IReviewThread>> = new Map();
		for (const reviewThread of activePullRequest.reviewThreadsCache) {
			let mapToUse: Map<string, Map<string, IReviewThread>>;
			if (reviewThread.isOutdated) {
				mapToUse = obsoleteReviewThreads;
			} else {
				if (reviewThread.diffSide === DiffSide.RIGHT) {
					mapToUse = workspaceFileReviewThreads;
				} else {
					mapToUse = reviewSchemeReviewThreads;
				}
			}
			if (!mapToUse.has(reviewThread.path)) {
				mapToUse.set(reviewThread.path, new Map());
			}
			mapToUse.get(reviewThread.path)!.set(reviewThread.id, reviewThread);
		}
		updateThreads(this._obsoleteFileChangeCommentThreads, obsoleteReviewThreads);
		updateThreads(this._reviewSchemeFileChangeCommentThreads, reviewSchemeReviewThreads);
		updateThreads(this._workspaceFileChangeCommentThreads, workspaceFileReviewThreads);
	}

	private _visibleEditorsEqual(a: vscode.TextEditor[], b: vscode.TextEditor[]): boolean {
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

	hasCommentThread(thread: vscode.CommentThread2): boolean {
		if (thread.uri.scheme === Schemes.Review) {
			return true;
		}


		if (!isFileInRepo(this._repository, thread.uri)) {
			return false;
		}

		if (thread.uri.scheme === this._repository.rootUri.scheme) {
			return true;
		}

		return false;
	}

	async provideCommentingRanges(document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<vscode.Range[] | { enableFileComments: boolean; ranges?: vscode.Range[] } | undefined> {
		let query: ReviewUriParams | undefined =
			(document.uri.query && document.uri.query !== '') ? fromReviewUri(document.uri.query) : undefined;

		if (query) {
			const matchedFile = this.findMatchedFileChangeForReviewDiffView(this._reviewModel.localFileChanges, document.uri);

			if (matchedFile) {
				Logger.debug('Found matched file for commenting ranges.', ReviewCommentController.ID);
				return { ranges: getCommentingRanges(await matchedFile.changeModel.diffHunks(), query.base, ReviewCommentController.ID), enableFileComments: true };
			}
		}

		const bestRepoForFile = getRepositoryForFile(this._gitApi, document.uri);
		if (bestRepoForFile?.rootUri.toString() !== this._repository.rootUri.toString()) {
			if (document.uri.scheme !== 'output') {
				Logger.debug('No commenting ranges: File is not in the current repository.', ReviewCommentController.ID);
			}
			return;
		}

		if (document.uri.scheme === this._repository.rootUri.scheme) {
			if (!this._folderRepoManager.activePullRequest!.isResolved()) {
				Logger.debug('No commenting ranges: Active PR has not been resolved.', ReviewCommentController.ID);
				return;
			}

			const fileName = this._folderRepoManager.gitRelativeRootPath(document.uri.path);
			const matchedFile = gitFileChangeNodeFilter(this._reviewModel.localFileChanges).find(
				fileChange => fileChange.fileName === fileName,
			);
			const ranges: vscode.Range[] = [];

			if (matchedFile) {
				const diffHunks = await matchedFile.changeModel.diffHunks();
				if ((matchedFile.status === GitChangeType.RENAME) && (diffHunks.length === 0)) {
					Logger.debug('No commenting ranges: File was renamed with no diffs.', ReviewCommentController.ID);
					return { ranges: [], enableFileComments: true };
				}

				const contentDiff = await this.getContentDiff(document.uri, matchedFile.fileName);

				for (let i = 0; i < diffHunks.length; i++) {
					const diffHunk = diffHunks[i];
					const start = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber, document.lineCount);
					const end = mapOldPositionToNew(contentDiff, diffHunk.newLineNumber + diffHunk.newLength - 1, document.lineCount);
					if (start > 0 && end > 0) {
						ranges.push(new vscode.Range(start - 1, 0, end - 1, 0));
					}
				}

				if (ranges.length === 0) {
					Logger.debug('No commenting ranges: File has diffs, but they could not be mapped to current lines.', ReviewCommentController.ID);
				}
			} else {
				Logger.debug('No commenting ranges: File does not match any of the files in the review.', ReviewCommentController.ID);
			}

			Logger.debug(`Providing ${ranges.length} commenting ranges for ${nodePath.basename(document.uri.fsPath)}.`, ReviewCommentController.ID);
			return { ranges, enableFileComments: ranges.length > 0 };
		} else {
			Logger.debug('No commenting ranges: File scheme differs from repository scheme.', ReviewCommentController.ID);
		}

		return;
	}

	// #endregion

	private async _getContentDiff(uri: vscode.Uri, fileName: string, retry: boolean = true): Promise<string> {
		const matchedEditor = vscode.window.visibleTextEditors.find(
			editor => editor.document.uri.toString() === uri.toString(),
		);
		if (!this._folderRepoManager.activePullRequest?.head) {
			Logger.error('Failed to get content diff. Cannot get content diff without an active pull request head.', ReviewCommentController.ID);
			throw new Error('Cannot get content diff without an active pull request head.');
		}

		try {
			if (matchedEditor && matchedEditor.document.isDirty && vscode.workspace.getConfiguration('files', matchedEditor.document.uri).get('autoSave') !== 'afterDelay') {
				const documentText = matchedEditor.document.getText();
				const details = await this._repository.getObjectDetails(
					this._folderRepoManager.activePullRequest.head.sha,
					fileName,
				);
				const idAtLastCommit = details.object;
				const idOfCurrentText = await this._repository.hashObject(documentText);

				// git diff <blobid> <blobid>
				return await this._repository.diffBlobs(idAtLastCommit, idOfCurrentText);
			} else {
				return await this._repository.diffWith(this._folderRepoManager.activePullRequest.head.sha, fileName);
			}
		} catch (e) {
			Logger.error(`Failed to get content diff. ${formatError(e)}`, ReviewCommentController.ID);
			if ((e.stderr as string | undefined)?.includes('bad object')) {
				if (this._repository.state.HEAD?.upstream && retry) {
					const pullBeforeCheckoutSetting = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<PullPRBranchVariants>(PULL_PR_BRANCH_BEFORE_CHECKOUT, 'pull');
					const pullSetting = (pullBeforeCheckoutSetting === 'pull' || pullBeforeCheckoutSetting === 'pullAndMergeBase' || pullBeforeCheckoutSetting === 'pullAndUpdateBase' || pullBeforeCheckoutSetting === true)
						&& (vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'never' | 'prompt' | 'always'>(PULL_BRANCH, 'prompt') === 'always');
					if (pullSetting) {
						try {
							await this._repository.pull();
							return this.getContentDiff(uri, fileName, false);
						} catch (e) {
							// No remote branch
						}
					} else if (this._repository.state.HEAD?.commit) {
						return this._repository.diffWith(this._repository.state.HEAD.commit, fileName);
					}
				}
				if (this._folderRepoManager.activePullRequest.isOpen) {
					vscode.window.showErrorMessage(vscode.l10n.t('Unable to get comment locations for commit {0}. This commit is not available locally and there is no remote branch.', this._folderRepoManager.activePullRequest.head.sha));
				}
				Logger.warn(`Unable to get comment locations for commit ${this._folderRepoManager.activePullRequest.head.sha}. This commit is not available locally and there is no remote branch.`, ReviewCommentController.ID);
			}
			throw e;
		}
	}

	private _findMatchedFileChangeForReviewDiffView(
		fileChanges: (GitFileChangeNode | RemoteFileChangeNode)[],
		uri: vscode.Uri,
	): GitFileChangeNode | undefined {
		const query = fromReviewUri(uri.query);
		const matchedFiles = fileChanges.filter(fileChangeNode => {
			const fileChange = fileChangeNode.changeModel;
			if (fileChange instanceof RemoteFileChangeModel) {
				return false;
			}

			if (fileChange.fileName !== query.path) {
				if (!((fileChange.change instanceof InMemFileChange) && fileChange.change.previousFileName === query.path)) {
					return false;
				}
			}

			if (fileChange.filePath.scheme !== 'review') {
				// local file

				if (fileChange.sha === query.commit) {
					return true;
				}
			}

			const q = fileChange.filePath.query ? JSON.parse(fileChange.filePath.query) : undefined;

			if (q && (q.commit === query.commit)) {
				return true;
			}

			const parentQ = fileChange.parentFilePath.query ? JSON.parse(fileChange.parentFilePath.query) : undefined;

			if (parentQ && (parentQ.commit === query.commit)) {
				return true;
			}

			return false;
		});

		if (matchedFiles && matchedFiles.length) {
			return matchedFiles[0] as GitFileChangeNode;
		}
		return undefined;
	}

	// #endregion

	// #region Review
	private _getCommentSide(thread: GHPRCommentThread): DiffSide {
		if (thread.uri.scheme === Schemes.Review) {
			const query = fromReviewUri(thread.uri.query);
			return query.base ? DiffSide.LEFT : DiffSide.RIGHT;
		}

		return DiffSide.RIGHT;
	}

	public async startReview(thread: GHPRCommentThread, input: string): Promise<void> {
		const hasExistingComments = thread.comments.length;
		let temporaryCommentId: number | undefined = undefined;
		try {
			temporaryCommentId = await this.optimisticallyAddComment(thread, input, true);
			if (!hasExistingComments) {
				const fileName = this._folderRepoManager.gitRelativeRootPath(thread.uri.path);
				const side = this.getCommentSide(thread);
				this._pendingCommentThreadAdds.push(thread);

				// If the thread is on the workspace file, make sure the position
				// is properly adjusted to account for any local changes.
				let startLine: number | undefined = undefined;
				let endLine: number | undefined = undefined;
				if (thread.range) {
					if (side === DiffSide.RIGHT) {
						const diff = await this.getContentDiff(thread.uri, fileName);
						startLine = mapNewPositionToOld(diff, thread.range.start.line);
						endLine = mapNewPositionToOld(diff, thread.range.end.line);
					} else {
						startLine = thread.range.start.line;
						endLine = thread.range.end.line;
					}
					startLine++;
					endLine++;
				}

				await Promise.all([this._folderRepoManager.activePullRequest!.createReviewThread(input, fileName, startLine, endLine, side),
				setReplyAuthor(thread, await this._folderRepoManager.getCurrentUser(this._folderRepoManager.activePullRequest!.githubRepository), this._context)
				]);
			} else {
				const comment = thread.comments[0];
				if (comment instanceof GHPRComment) {
					await this._folderRepoManager.activePullRequest!.createCommentReply(
						input,
						comment.rawComment.graphNodeId,
						false,
					);
				} else {
					throw new Error('Cannot reply to temporary comment');
				}
			}
		} catch (e) {
			vscode.window.showErrorMessage(`Starting review failed. Any review comments may be lost.`, { modal: true, detail: e?.message ?? e });

			thread.comments = thread.comments.map(c => {
				if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
					c.mode = vscode.CommentMode.Editing;
				}

				return c;
			});
		}
	}

	public async openReview(): Promise<void> {
		await this._reviewManager.openDescription();
		PullRequestOverviewPanel.scrollToReview();
	}

	// #endregion
	private async _optimisticallyAddComment(thread: GHPRCommentThread, input: string, inDraft: boolean): Promise<number> {
		const currentUser = await this._folderRepoManager.getCurrentUser();
		const comment = new TemporaryComment(thread, input, inDraft, currentUser);
		this.updateCommentThreadComments(thread, [...thread.comments, comment]);
		return comment.id;
	}

	private _updateCommentThreadComments(thread: GHPRCommentThread, newComments: (GHPRComment | TemporaryComment)[]) {
		thread.comments = newComments;
		updateCommentThreadLabel(thread);
	}

	private async _optimisticallyEditComment(thread: GHPRCommentThread, comment: GHPRComment): Promise<number> {
		const currentUser = await this._folderRepoManager.getCurrentUser();
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

	// #region Comment
	async createOrReplyComment(
		thread: GHPRCommentThread,
		input: string,
		isSingleComment: boolean,
		inDraft?: boolean,
	): Promise<void> {
		if (!this._folderRepoManager.activePullRequest) {
			throw new Error('Cannot create comment without an active pull request.');
		}

		const hasExistingComments = thread.comments.length;
		const isDraft = isSingleComment
			? false
			: inDraft !== undefined
				? inDraft
				: this._folderRepoManager.activePullRequest.hasPendingReview;
		const temporaryCommentId = await this.optimisticallyAddComment(thread, input, isDraft);

		try {
			if (!hasExistingComments) {
				const fileName = this._folderRepoManager.gitRelativeRootPath(thread.uri.path);
				this._pendingCommentThreadAdds.push(thread);
				const side = this.getCommentSide(thread);

				// If the thread is on the workspace file, make sure the position
				// is properly adjusted to account for any local changes.
				let startLine: number | undefined = undefined;
				let endLine: number | undefined = undefined;
				if (thread.range) {
					if (side === DiffSide.RIGHT) {
						const diff = await this.getContentDiff(thread.uri, fileName);
						startLine = mapNewPositionToOld(diff, thread.range.start.line);
						endLine = mapNewPositionToOld(diff, thread.range.end.line);
					} else {
						startLine = thread.range.start.line;
						endLine = thread.range.end.line;
					}
					startLine++;
					endLine++;
				}
				await Promise.all([
					this._folderRepoManager.activePullRequest.createReviewThread(
						input,
						fileName,
						startLine,
						endLine,
						side,
						isSingleComment,
					),
					setReplyAuthor(thread, await this._folderRepoManager.getCurrentUser(this._folderRepoManager.activePullRequest.githubRepository), this._context)
				]);
			} else {
				const comment = thread.comments[0];
				if (comment instanceof GHPRComment) {
					await this._folderRepoManager.activePullRequest.createCommentReply(
						input,
						comment.rawComment.graphNodeId,
						isSingleComment,
					);
				} else {
					throw new Error('Cannot reply to temporary comment');
				}
			}

			if (isSingleComment) {
				await this._folderRepoManager.activePullRequest.submitReview();
			}
		} catch (e) {
			if (e.graphQLErrors?.length && e.graphQLErrors[0].type === 'NOT_FOUND') {
				vscode.window.showWarningMessage('The comment that you\'re replying to was deleted. Refresh to update.', 'Refresh').then(result => {
					if (result === 'Refresh') {
						this._reviewManager.updateComments();
					}
				});
			} else {
				vscode.window.showErrorMessage(`Creating comment failed: ${e}`);
			}

			thread.comments = thread.comments.map(c => {
				if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
					c.mode = vscode.CommentMode.Editing;
				}

				return c;
			});
		}
	}

	async createSuggestionsFromChanges(file: vscode.Uri, suggestionInformation: SuggestionInformation): Promise<void> {
		const activePr = this._folderRepoManager.activePullRequest;
		if (!activePr) {
			return;
		}

		const path = this._folderRepoManager.gitRelativeRootPath(file.path);
		const body = `\`\`\`suggestion
${suggestionInformation.suggestionContent}
\`\`\``;
		await activePr.createReviewThread(
			body,
			path,
			suggestionInformation.originalStartLine,
			suggestionInformation.originalStartLine + suggestionInformation.originalLineLength - 1,
			DiffSide.RIGHT,
			false,
		);
	}

	private async _createCommentOnResolve(thread: GHPRCommentThread, input: string): Promise<void> {
		if (!this._folderRepoManager.activePullRequest) {
			throw new Error('Cannot create comment on resolve without an active pull request.');
		}
		const pendingReviewId = await this._folderRepoManager.activePullRequest.getPendingReviewId();
		await this.createOrReplyComment(thread, input, !pendingReviewId);
	}

	async resolveReviewThread(thread: GHPRCommentThread, input?: string): Promise<void> {
		try {
			if (input) {
				await this.createCommentOnResolve(thread, input);
			}

			await this._folderRepoManager.activePullRequest!.resolveReviewThread(thread.gitHubThreadId);
		} catch (e) {
			vscode.window.showErrorMessage(`Resolving conversation failed: ${e}`);
		}
	}

	async unresolveReviewThread(thread: GHPRCommentThread, input?: string): Promise<void> {
		try {
			if (input) {
				await this.createCommentOnResolve(thread, input);
			}

			await this._folderRepoManager.activePullRequest!.unresolveReviewThread(thread.gitHubThreadId);
		} catch (e) {
			vscode.window.showErrorMessage(`Unresolving conversation failed: ${e}`);
		}
	}

	async editComment(thread: GHPRCommentThread, comment: GHPRComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			const temporaryCommentId = await this.optimisticallyEditComment(thread, comment);
			try {
				if (!this._folderRepoManager.activePullRequest) {
					throw new Error('Unable to find active pull request');
				}

				await this._folderRepoManager.activePullRequest.editReviewComment(
					comment.rawComment,
					comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body,
				);
			} catch (e) {
				vscode.window.showErrorMessage(formatError(e));

				thread.comments = thread.comments.map(c => {
					if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
						return new GHPRComment(this._context, comment.rawComment, thread);
					}

					return c;
				});
			}
		}
	}

	async deleteComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		try {
			if (!this._folderRepoManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			if (comment instanceof GHPRComment) {
				await this._folderRepoManager.activePullRequest.deleteReviewComment(comment.commentId);
			} else {
				thread.comments = thread.comments.filter(c => !(c instanceof TemporaryComment && c.id === comment.id));
			}

			if (thread.comments.length === 0) {
				thread.dispose();
			} else {
				updateCommentThreadLabel(thread);
			}

			const inDraftMode = await this._folderRepoManager.activePullRequest.validateDraftMode();
			if (inDraftMode !== this._folderRepoManager.activePullRequest.hasPendingReview) {
				this._folderRepoManager.activePullRequest.hasPendingReview = inDraftMode;
			}

			this.update();
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	// #endregion

	// #region Incremental update comments
	public async update(): Promise<void> {
		await this._folderRepoManager.activePullRequest!.validateDraftMode();
	}
	// #endregion

	// #region Reactions
	async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		try {
			if (!this._folderRepoManager.activePullRequest) {
				throw new Error('Unable to find active pull request');
			}

			if (
				comment.reactions &&
				!comment.reactions.find(ret => ret.label === reaction.label && !!ret.authorHasReacted)
			) {
				await this._folderRepoManager.activePullRequest.addCommentReaction(
					comment.rawComment.graphNodeId,
					reaction,
				);
			} else {
				await this._folderRepoManager.activePullRequest.deleteCommentReaction(
					comment.rawComment.graphNodeId,
					reaction,
				);
			}
		} catch (e) {
			throw new Error(formatError(e));
		}
	}

	// #endregion

	async applySuggestion(comment: GHPRComment) {
		const range = comment.parent.range;
		const suggestion = comment.suggestion;
		if ((suggestion === undefined) || !range) {
			throw new Error('Comment doesn\'t contain a suggestion');
		}

		const editor = vscode.window.visibleTextEditors.find(editor => comment.parent.uri.toString() === editor.document.uri.toString());
		if (!editor) {
			throw new Error('Cannot find the editor to apply the suggestion to.');
		}
		await editor.edit(builder => {
			builder.replace(range.with(undefined, editor.document.lineAt(range.end.line).range.end), suggestion);
		});
	}

	public override dispose() {
		super.dispose();
		unregisterCommentHandler(this._commentHandlerId);
	}
}
