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
import { CommentControllerBase } from './commentControllBase';
import { RemoteFileChangeModel } from './fileChangeModel';
import { ReviewManager } from './reviewManager';
import { ReviewModel } from './reviewModel';
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
import { arrayFindIndexAsync, formatError, groupBy, uniqBy } from '../common/utils';
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
import { GitFileChangeNode, gitFileChangeNodeFilter, RemoteFileChangeNode } from './treeNodes/fileChangeNode';

export interface SuggestionInformation {
	originalStartLine: number;
	originalLineLength: number;
	suggestionContent: string;
}

export class ReviewCommentController extends CommentControllerBase implements CommentHandler, vscode.CommentingRangeProvider2, CommentReactionHandler {
	private static readonly ID = 'ReviewCommentController';
	private static readonly PREFIX = 'github-review';
	private _commentHandlerId: string;

	// Note: marked as protected so that tests can verify caches have been updated correctly without breaking type safety
	protected _workspaceFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};
	protected _reviewSchemeFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};
	protected _obsoleteFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};
	// Threads displayed in a per-commit diff view (the diff opened from the commits tree). Keyed by
	// `${path}@${originalCommitId}` so multiple commits' threads on the same file don't collide. Each
	// non-outdated thread with a known `originalCommitId` gets an entry here in addition to its
	// workspace/review-scheme entry.
	protected _commitFileChangeCommentThreads: { [key: string]: GHPRCommentThread[] } = {};

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
	 * Creates a comment thread on a per-commit review URI keyed by `originalCommitId`. Used both for
	 * threads that are already outdated (the line no longer exists at PR head) and to surface in-range
	 * threads in the per-commit diff view opened from the commits tree. The URI shape mirrors the one
	 * {@link CommitNode} produces so VS Code matches them. Returns undefined if the thread has no
	 * `originalCommitId` (only happens for malformed data — outdated threads always have one).
	 */
	private async createCommitAnchoredCommentThread(path: string, thread: IReviewThread): Promise<GHPRCommentThread | undefined> {
		const commit = thread.comments[0].originalCommitId;
		if (!commit) {
			return undefined;
		}
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

	private static commitThreadKey(path: string, commitId: string): string {
		return `${path}@${commitId}`;
	}

	/**
	 * Creates a comment thread for a thread that appears on the right-hand side, which is a
	 * document that has a scheme matching the workspace uri scheme, typically 'file'.
	 * @param uri The uri to the file the comment thread is on.
	 * @param path The path to the file the comment thread is on.
	 * @param thread The comment thread information from GitHub.
	 * @returns A GHPRCommentThread that has been created on an editor.
	 */
	private async createWorkspaceCommentThread(
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
	private async createReviewCommentThread(uri: vscode.Uri, path: string, thread: IReviewThread): Promise<GHPRCommentThread> {
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

	private async doInitializeCommentThreads(reviewThreads: IReviewThread[]): Promise<void> {
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
		for (const key in this._commitFileChangeCommentThreads) {
			disposeAll(this._commitFileChangeCommentThreads[key]);
		}
		this._commitFileChangeCommentThreads = {};

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
						const obsolete = await this.createCommitAnchoredCommentThread(path, thread);
						if (obsolete) {
							outdatedCommentThreads.push(obsolete);
						}
					} else {
						if (thread.diffSide === DiffSide.RIGHT) {
							rightSideCommentThreads.push(await this.createWorkspaceCommentThread(uri, path, thread));
						} else {
							leftSideThreads.push(await this.createReviewCommentThread(uri, path, thread));
						}
						// Also surface the thread on its per-commit diff URI so it appears when the user
						// opens that commit from the commits tree.
						const commitThread = await this.createCommitAnchoredCommentThread(path, thread);
						if (commitThread) {
							const key = ReviewCommentController.commitThreadKey(path, thread.comments[0].originalCommitId!);
							if (!this._commitFileChangeCommentThreads[key]) {
								this._commitFileChangeCommentThreads[key] = [];
							}
							this._commitFileChangeCommentThreads[key].push(commitThread);
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
	private updateResourcesWithCommentingRanges(): void {
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

	private async initializeCommentThreads(): Promise<void> {
		const activePullRequest = this._folderRepoManager.activePullRequest;
		if (!activePullRequest || !activePullRequest.isResolved()) {
			return;
		}
		return this.doInitializeCommentThreads(activePullRequest.reviewThreadsCache);
	}

	private async registerListeners(): Promise<void> {
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
					this._commitFileChangeCommentThreads,
				].forEach(commentThreadMap => {
					for (const key in commentThreadMap) {
						commentThreadMap[key].forEach(thread => {
							updateCommentReviewState(thread, newDraftMode);
							updateCommentThreadLabel(thread);
						});
					}
				});
			}),
		);

		this._register(
			activePullRequest.onDidChangeReviewThreads(async e => {
				const githubRepositories = this.githubReposForPullRequest(this._folderRepoManager.activePullRequest);
				for (const thread of e.added) {
					const { path } = thread;
					const fullPath = nodePath.join(this._repository.rootUri.path, path).replace(/\\/g, '/');
					const uri = this._repository.rootUri.with({ path: fullPath });

					// If the user just created this thread optimistically, find that pending instance and
					// adopt it instead of building a fresh one. Sort it into either the "commit-scoped" or
					// "workspace/review" slot based on which URI the optimistic thread was on; the other
					// slot will be built fresh below.
					const index = await arrayFindIndexAsync(this._pendingCommentThreadAdds, async t => {
						const fileName = this.getFileNameForThread(t);
						if (fileName !== thread.path) {
							return false;
						}

						// Commit/base review URIs already use file-coordinate lines, so compare directly.
						// Workspace URIs need remapping back to PR-head coordinates first.
						if (t.uri.scheme === Schemes.Review) {
							const line = (t.range?.end.line ?? -1) + 1;
							return line === thread.endLine || line === thread.originalEndLine;
						}

						const diff = await this.getContentDiff(t.uri, fileName);
						const line = t.range ? mapNewPositionToOld(diff, t.range.end.line) : 0;
						return line + 1 === thread.endLine;
					});

					let optimisticAsCommit: GHPRCommentThread | undefined;
					let optimisticAsWorkspaceOrReview: GHPRCommentThread | undefined;
					if (index > -1) {
						const t = this._pendingCommentThreadAdds[index];
						t.gitHubThreadId = thread.id;
						t.comments = thread.comments.map(c => new GHPRComment(this._context, c, t, githubRepositories));
						updateThreadWithRange(this._context, t, thread, githubRepositories, undefined, true);
						this._pendingCommentThreadAdds.splice(index, 1);

						let isCommitScoped = false;
						if (t.uri.scheme === Schemes.Review) {
							const q = fromReviewUri(t.uri.query);
							isCommitScoped = !!(q.isOutdated && q.commit);
						}
						if (isCommitScoped) {
							optimisticAsCommit = t;
						} else {
							optimisticAsWorkspaceOrReview = t;
						}
					}

					if (thread.isOutdated) {
						const t = optimisticAsWorkspaceOrReview ?? optimisticAsCommit ?? await this.createCommitAnchoredCommentThread(path, thread);
						if (t) {
							if (!this._obsoleteFileChangeCommentThreads[path]) {
								this._obsoleteFileChangeCommentThreads[path] = [];
							}
							this._obsoleteFileChangeCommentThreads[path].push(t);
						}
					} else {
						// Workspace/review variant — visible in the files view.
						const wOrR = optimisticAsWorkspaceOrReview ?? (thread.diffSide === DiffSide.RIGHT
							? await this.createWorkspaceCommentThread(uri, path, thread)
							: await this.createReviewCommentThread(uri, path, thread));
						const wOrRMap = thread.diffSide === DiffSide.RIGHT
							? this._workspaceFileChangeCommentThreads
							: this._reviewSchemeFileChangeCommentThreads;
						if (!wOrRMap[path]) {
							wOrRMap[path] = [];
						}
						wOrRMap[path].push(wOrR);

						// Commit-scoped variant — visible in the per-commit diff opened from the commits tree.
						const c = optimisticAsCommit ?? await this.createCommitAnchoredCommentThread(path, thread);
						if (c) {
							const key = ReviewCommentController.commitThreadKey(path, thread.comments[0].originalCommitId!);
							if (!this._commitFileChangeCommentThreads[key]) {
								this._commitFileChangeCommentThreads[key] = [];
							}
							this._commitFileChangeCommentThreads[key].push(c);
						}
					}
				}

				for (const thread of e.changed) {
					for (const matchingThread of this._findMatchingThreads(thread)) {
						updateThread(this._context, matchingThread, thread, githubRepositories);
					}
				}

				for (const thread of e.removed) {
					this._removeMatchingThreads(thread);
				}

				this.updateResourcesWithCommentingRanges();
			}),
		);
	}

	/**
	 * Finds every {@link GHPRCommentThread} that mirrors a given {@link IReviewThread}, across all four
	 * thread maps (workspace/review/obsolete/commit-scoped). A single review thread can have up to two
	 * mirrors: one in the files view and one in its commit's diff view.
	 */
	private _findMatchingThreads(thread: IReviewThread): GHPRCommentThread[] {
		const result: GHPRCommentThread[] = [];
		const candidateBuckets: GHPRCommentThread[][] = [];

		if (thread.isOutdated) {
			candidateBuckets.push(this._obsoleteFileChangeCommentThreads[thread.path] ?? []);
			// A thread that just turned outdated this session was originally added to the workspace or
			// review map and never got moved when its `isOutdated` flag flipped (we don't dispose-and-
			// recreate on transition). Search those maps too so the change still propagates to the
			// underlying VS Code thread instance.
			candidateBuckets.push(this._workspaceFileChangeCommentThreads[thread.path] ?? []);
			candidateBuckets.push(this._reviewSchemeFileChangeCommentThreads[thread.path] ?? []);
		} else {
			const primaryMap = thread.diffSide === DiffSide.RIGHT
				? this._workspaceFileChangeCommentThreads
				: this._reviewSchemeFileChangeCommentThreads;
			candidateBuckets.push(primaryMap[thread.path] ?? []);
			const originalCommitId = thread.comments[0]?.originalCommitId;
			if (originalCommitId) {
				const key = ReviewCommentController.commitThreadKey(thread.path, originalCommitId);
				candidateBuckets.push(this._commitFileChangeCommentThreads[key] ?? []);
			}
		}

		for (const bucket of candidateBuckets) {
			for (const t of bucket) {
				if (t.gitHubThreadId === thread.id) {
					result.push(t);
				}
			}
		}
		return result;
	}

	/**
	 * Removes every mirror of {@link thread} from its containing map(s) and disposes them.
	 */
	private _removeMatchingThreads(thread: IReviewThread): void {
		const removeFrom = (map: { [key: string]: GHPRCommentThread[] }, key: string) => {
			const bucket = map[key];
			if (!bucket) {
				return;
			}
			for (let i = bucket.length - 1; i >= 0; i--) {
				if (bucket[i].gitHubThreadId === thread.id) {
					const [removed] = bucket.splice(i, 1);
					removed.dispose();
				}
			}
		};

		removeFrom(this._workspaceFileChangeCommentThreads, thread.path);
		removeFrom(this._reviewSchemeFileChangeCommentThreads, thread.path);
		removeFrom(this._obsoleteFileChangeCommentThreads, thread.path);
		const originalCommitId = thread.comments[0]?.originalCommitId;
		if (originalCommitId) {
			removeFrom(this._commitFileChangeCommentThreads, ReviewCommentController.commitThreadKey(thread.path, originalCommitId));
		}
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
		const reviewThreadsById: Map<string, IReviewThread> = new Map(
			activePullRequest.reviewThreadsCache.map(t => [t.id, t]),
		);
		const updateAll = (map: { [key: string]: GHPRCommentThread[] }) => {
			for (const key in map) {
				for (const commentThread of map[key]) {
					const reviewThread = reviewThreadsById.get(commentThread.gitHubThreadId);
					if (reviewThread) {
						updateThread(this._context, commentThread, reviewThread, githubRepositories, expand);
					}
				}
			}
		};
		updateAll(this._obsoleteFileChangeCommentThreads);
		updateAll(this._reviewSchemeFileChangeCommentThreads);
		updateAll(this._workspaceFileChangeCommentThreads);
		updateAll(this._commitFileChangeCommentThreads);
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

			// Fallback for per-commit diff URIs created by `CommitNode`. These won't be found in
			// `localFileChanges` (which only tracks the PR head). Fetch the commit's patch on demand.
			if (query.isOutdated && query.commit && this._folderRepoManager.activePullRequest) {
				try {
					const hunks = await this._folderRepoManager.activePullRequest.getCommitFileDiffHunks(query.commit, query.path);
					if (hunks.length > 0) {
						Logger.debug('Computed commenting ranges from commit-scoped diff fetch.', ReviewCommentController.ID);
						return { ranges: getCommentingRanges(hunks, query.base, ReviewCommentController.ID), enableFileComments: true };
					}
				} catch (e) {
					Logger.warn(`Failed to fetch commit diff for commenting ranges: ${formatError(e)}`, ReviewCommentController.ID);
				}
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

	private async getContentDiff(uri: vscode.Uri, fileName: string, retry: boolean = true): Promise<string> {
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

	private findMatchedFileChangeForReviewDiffView(
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
	private getCommentSide(thread: GHPRCommentThread): DiffSide {
		if (thread.uri.scheme === Schemes.Review) {
			const query = fromReviewUri(thread.uri.query);
			return query.base ? DiffSide.LEFT : DiffSide.RIGHT;
		}

		return DiffSide.RIGHT;
	}

	/**
	 * Returns the commit a new comment on this thread should be anchored to. For commit-scoped diff
	 * URIs (created by {@link CommitNode}, marked with `isOutdated: true`), the commit comes from the
	 * URI itself. For files-view URIs (workspace files or merge-base review URIs), returns undefined,
	 * letting the model default to the PR head.
	 */
	private getCommitForThread(thread: GHPRCommentThread): string | undefined {
		if (thread.uri.scheme !== Schemes.Review) {
			return undefined;
		}
		const query = fromReviewUri(thread.uri.query);
		return query.isOutdated ? query.commit : undefined;
	}

	/**
	 * Returns the repo-relative file path for a thread. For review-scheme URIs (merge-base or
	 * commit-scoped) the actual file path lives in `query.path` because `uri.path` is a synthetic
	 * prefix like `commit~ec597364/foo/bar.ts`. For workspace URIs we strip the repo root from
	 * `uri.path` as before.
	 */
	private getFileNameForThread(thread: GHPRCommentThread): string {
		if (thread.uri.scheme === Schemes.Review) {
			return fromReviewUri(thread.uri.query).path;
		}
		return this._folderRepoManager.gitRelativeRootPath(thread.uri.path);
	}

	/**
	 * Resolves the {startLine, endLine} (1-based, in the PR-head/commit file's coordinates) for a new
	 * comment thread. For workspace-file threads, the editor's lines reflect any local edits, so we
	 * remap them back to the PR head via {@link getContentDiff}. For review-scheme threads (merge base
	 * or commit), the editor lines already match the file in that ref and are used directly.
	 */
	private async getCommentLinesForThread(thread: GHPRCommentThread, fileName: string, side: DiffSide): Promise<{ startLine: number | undefined; endLine: number | undefined }> {
		if (!thread.range) {
			return { startLine: undefined, endLine: undefined };
		}

		let startLine: number;
		let endLine: number;
		if (thread.uri.scheme !== Schemes.Review && side === DiffSide.RIGHT) {
			const diff = await this.getContentDiff(thread.uri, fileName);
			startLine = mapNewPositionToOld(diff, thread.range.start.line);
			endLine = mapNewPositionToOld(diff, thread.range.end.line);
		} else {
			startLine = thread.range.start.line;
			endLine = thread.range.end.line;
		}
		return { startLine: startLine + 1, endLine: endLine + 1 };
	}

	public async startReview(thread: GHPRCommentThread, input: string): Promise<void> {
		const hasExistingComments = thread.comments.length;
		let temporaryCommentId: number | undefined = undefined;
		try {
			temporaryCommentId = await this.optimisticallyAddComment(thread, input, true);
			if (!hasExistingComments) {
				const fileName = this.getFileNameForThread(thread);
				const side = this.getCommentSide(thread);
				const commitId = this.getCommitForThread(thread);
				this._pendingCommentThreadAdds.push(thread);

				const { startLine, endLine } = await this.getCommentLinesForThread(thread, fileName, side);

				await Promise.all([this._folderRepoManager.activePullRequest!.createReviewThread(input, fileName, startLine, endLine, side, undefined, commitId),
				setReplyAuthor(thread, await this._folderRepoManager.getCurrentUser(this._folderRepoManager.activePullRequest!.githubRepository), this._context)
				]);
			} else {
				const comment = thread.comments[0];
				if (comment instanceof GHPRComment) {
					await this._folderRepoManager.activePullRequest!.createCommentReply(
						input,
						comment.rawComment.graphNodeId,
						false,
						this.getCommitForThread(thread),
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
		const pr = this._folderRepoManager.activePullRequest;
		if (pr) {
			PullRequestOverviewPanel.scrollToReview(pr.remote.owner, pr.remote.repositoryName, pr.number);
		}
	}

	// #endregion
	private async optimisticallyAddComment(thread: GHPRCommentThread, input: string, inDraft: boolean): Promise<number> {
		const currentUser = await this._folderRepoManager.getCurrentUser();
		const comment = new TemporaryComment(thread, input, inDraft, currentUser);
		this.updateCommentThreadComments(thread, [...thread.comments, comment]);
		return comment.id;
	}

	private updateCommentThreadComments(thread: GHPRCommentThread, newComments: (GHPRComment | TemporaryComment)[]) {
		thread.comments = newComments;
		updateCommentThreadLabel(thread);
	}

	private async optimisticallyEditComment(thread: GHPRCommentThread, comment: GHPRComment): Promise<number> {
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
				const fileName = this.getFileNameForThread(thread);
				this._pendingCommentThreadAdds.push(thread);
				const side = this.getCommentSide(thread);
				const commitId = this.getCommitForThread(thread);

				const { startLine, endLine } = await this.getCommentLinesForThread(thread, fileName, side);
				await Promise.all([
					this._folderRepoManager.activePullRequest.createReviewThread(
						input,
						fileName,
						startLine,
						endLine,
						side,
						isSingleComment,
						commitId,
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
						this.getCommitForThread(thread),
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

	private async createCommentOnResolve(thread: GHPRCommentThread, input: string): Promise<void> {
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
			// Ignore permission errors when removing reactions due to race conditions
			// See: https://github.com/microsoft/vscode/issues/69321
			const errorMessage = formatError(e);
			if (errorMessage.includes('does not have the correct permissions to execute `RemoveReaction`')) {
				// Silently ignore this error - it occurs when quickly toggling reactions
				return;
			}
			throw new Error(errorMessage);
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
