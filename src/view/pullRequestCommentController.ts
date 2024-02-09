/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { v4 as uuid } from 'uuid';
import * as vscode from 'vscode';
import { CommentHandler, registerCommentHandler, unregisterCommentHandler } from '../commentHandlerResolver';
import { DiffSide, IComment, SubjectType } from '../common/comment';
import { fromPRUri, Schemes } from '../common/uri';
import { dispose, groupBy } from '../common/utils';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubRepository } from '../github/githubRepository';
import { GHPRComment, GHPRCommentThread, TemporaryComment } from '../github/prComment';
import { PullRequestModel, ReviewThreadChangeEvent } from '../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../github/pullRequestOverview';
import {
	CommentReactionHandler,
	createVSCodeCommentThreadForReviewThread,
	threadRange,
	updateCommentReviewState,
	updateCommentThreadLabel,
	updateThread,
	updateThreadWithRange,
} from '../github/utils';
import { CommentControllerBase } from './commentControllBase';

export class PullRequestCommentController extends CommentControllerBase implements CommentHandler, CommentReactionHandler {
	private _pendingCommentThreadAdds: GHPRCommentThread[] = [];
	private _commentHandlerId: string;
	private _commentThreadCache: { [key: string]: GHPRCommentThread[] } = {};
	private _disposables: vscode.Disposable[] = [];
	private readonly _context: vscode.ExtensionContext;
	private readonly _githubRepositories: GitHubRepository[];

	constructor(
		private readonly pullRequestModel: PullRequestModel,
		folderRepoManager: FolderRepositoryManager,
		commentController: vscode.CommentController,
	) {
		super(folderRepoManager);
		this._commentController = commentController;
		this._context = folderRepoManager.context;
		this._commentHandlerId = uuid();
		registerCommentHandler(this._commentHandlerId, this);

		if (this.pullRequestModel.reviewThreadsCacheReady) {
			this.initializeThreadsInOpenEditors().then(() => {
				this.registerListeners();
			});
		} else {
			const reviewThreadsDisposable = this.pullRequestModel.onDidChangeReviewThreads(async () => {
				reviewThreadsDisposable.dispose();
				await this.initializeThreadsInOpenEditors();
				this.registerListeners();
			});
		}
		this._githubRepositories = this.githubReposForPullRequest(pullRequestModel);
	}

	private registerListeners(): void {
		this._disposables.push(this.pullRequestModel.onDidChangeReviewThreads(e => this.onDidChangeReviewThreads(e)));

		this._disposables.push(
			vscode.window.tabGroups.onDidChangeTabs(async e => {
				return this.onDidChangeOpenTabs(e);
			})
		);

		this._disposables.push(
			this.pullRequestModel.onDidChangePendingReviewState(newDraftMode => {
				for (const key in this._commentThreadCache) {
					this._commentThreadCache[key].forEach(thread => {
						updateCommentReviewState(thread, newDraftMode);
					});
				}
			}),
		);

		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor(e => {
				this.refreshContextKey(e);
			}),
		);
	}

	private refreshContextKey(editor: vscode.TextEditor | undefined): void {
		if (!editor) {
			return;
		}

		const editorUri = editor.document.uri;
		if (editorUri.scheme !== Schemes.Pr) {
			return;
		}

		const params = fromPRUri(editorUri);
		if (!params || params.prNumber !== this.pullRequestModel.number) {
			return;
		}

		this.setContextKey(this.pullRequestModel.hasPendingReview);
	}

	private async getPREditors(editors: readonly vscode.TextEditor[] | readonly (vscode.TabInputText | vscode.TabInputTextDiff)[]): Promise<vscode.TextDocument[]> {
		const prDocuments: Promise<vscode.TextDocument>[] = [];
		const isPrEditor = (potentialEditor: { uri: vscode.Uri, editor?: vscode.TextEditor }): Thenable<vscode.TextDocument> | undefined => {
			const params = fromPRUri(potentialEditor.uri);
			if (params && params.prNumber === this.pullRequestModel.number) {
				if (potentialEditor.editor) {
					return Promise.resolve(potentialEditor.editor.document);
				} else {
					return vscode.workspace.openTextDocument(potentialEditor.uri);
				}
			}
		};
		for (const editor of editors) {
			const testUris: { uri: vscode.Uri, editor?: vscode.TextEditor }[] = [];
			if (editor instanceof vscode.TabInputText) {
				testUris.push({ uri: editor.uri });
			} else if (editor instanceof vscode.TabInputTextDiff) {
				testUris.push({ uri: editor.original }, { uri: editor.modified });
			} else {
				testUris.push({ uri: editor.document.uri, editor });
			}
			prDocuments.push(...testUris.map(isPrEditor).filter<Promise<vscode.TextDocument>>((doc): doc is Promise<vscode.TextDocument> => !!doc));
		}
		return Promise.all(prDocuments);
	}

	private getCommentThreadCacheKey(fileName: string, isBase: boolean): string {
		return `${fileName}-${isBase ? 'original' : 'modified'}`;
	}

	private async addThreadsForEditors(documents: vscode.TextDocument[]): Promise<void> {
		const reviewThreads = this.pullRequestModel.reviewThreadsCache;
		const threadsByPath = groupBy(reviewThreads, thread => thread.path);
		const currentUser = await this._folderRepoManager.getCurrentUser();
		for (const document of documents) {
			const { fileName, isBase } = fromPRUri(document.uri)!;
			const cacheKey = this.getCommentThreadCacheKey(fileName, isBase);
			if (this._commentThreadCache[cacheKey]) {
				continue;
			}
			if (threadsByPath[fileName]) {
				this._commentThreadCache[cacheKey] = threadsByPath[fileName]
					.filter(
						thread =>
							((thread.diffSide === DiffSide.LEFT && isBase) ||
								(thread.diffSide === DiffSide.RIGHT && !isBase))
							&& (thread.endLine !== null),
					)
					.map(thread => {
						const endLine = thread.endLine - 1;
						const range = thread.subjectType === SubjectType.FILE ? undefined : threadRange(thread.startLine - 1, endLine, document.lineAt(endLine).range.end.character);

						return createVSCodeCommentThreadForReviewThread(
							this._context,
							document.uri,
							range,
							thread,
							this._commentController,
							currentUser.login,
							this._githubRepositories
						);
					});
			}
		}
	}

	private async initializeThreadsInOpenEditors(): Promise<void> {
		const prEditors = await this.getPREditors(vscode.window.visibleTextEditors);
		return this.addThreadsForEditors(prEditors);
	}

	private allTabs(): (vscode.TabInputText | vscode.TabInputTextDiff)[] {
		return this.filterTabsToPrTabs(vscode.window.tabGroups.all.map(group => group.tabs).flat());
	}

	private filterTabsToPrTabs(tabs: readonly vscode.Tab[]): (vscode.TabInputText | vscode.TabInputTextDiff)[] {
		return tabs.filter(tab => tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputTextDiff).map(tab => tab.input as vscode.TabInputText | vscode.TabInputTextDiff);
	}

	private async cleanClosedPrs() {
		// Remove comments for which no editors belonging to the same PR are open
		const allPrEditors = await this.getPREditors(this.allTabs());
		if (allPrEditors.length === 0) {
			this.removeAllCommentsThreads();
		}
	}

	private async onDidChangeOpenTabs(e: vscode.TabChangeEvent): Promise<void> {
		const added = await this.getPREditors(this.filterTabsToPrTabs(e.opened));
		if (added.length) {
			await this.addThreadsForEditors(added);
		}
		if (e.closed.length > 0) {
			// Delay cleaning closed editors to handle the case where a preview tab is replaced
			await new Promise(resolve => setTimeout(resolve, 100));
			await this.cleanClosedPrs();
		}
	}

	private onDidChangeReviewThreads(e: ReviewThreadChangeEvent): void {
		e.added.forEach(async (thread) => {
			const fileName = thread.path;
			const index = this._pendingCommentThreadAdds.findIndex(t => {
				const samePath = this.gitRelativeRootPath(t.uri.path) === thread.path;
				const sameLine = (t.range === undefined && thread.subjectType === SubjectType.FILE) || (t.range && t.range.end.line + 1 === thread.endLine);
				return samePath && sameLine;
			});

			let newThread: GHPRCommentThread | undefined = undefined;
			if (index > -1) {
				newThread = this._pendingCommentThreadAdds[index];
				newThread.gitHubThreadId = thread.id;
				newThread.comments = thread.comments.map(c => new GHPRComment(this._context, c, newThread!, this._githubRepositories));
				updateThreadWithRange(this._context, newThread, thread, this._githubRepositories);
				this._pendingCommentThreadAdds.splice(index, 1);
			} else {
				const openPREditors = await this.getPREditors(vscode.window.visibleTextEditors);
				const matchingEditor = openPREditors.find(editor => {
					const query = fromPRUri(editor.uri);
					const sameSide =
						(thread.diffSide === DiffSide.RIGHT && !query?.isBase) ||
						(thread.diffSide === DiffSide.LEFT && query?.isBase);
					return query?.fileName === fileName && sameSide;
				});

				if (matchingEditor) {
					const endLine = thread.endLine - 1;
					const range = thread.subjectType === SubjectType.FILE ? undefined : threadRange(thread.startLine - 1, endLine, matchingEditor.lineAt(endLine).range.end.character);

					newThread = createVSCodeCommentThreadForReviewThread(
						this._context,
						matchingEditor.uri,
						range,
						thread,
						this._commentController,
						(await this._folderRepoManager.getCurrentUser()).login,
						this._githubRepositories
					);
				}
			}

			if (!newThread) {
				return;
			}
			const key = this.getCommentThreadCacheKey(thread.path, thread.diffSide === DiffSide.LEFT);
			if (this._commentThreadCache[key]) {
				this._commentThreadCache[key].push(newThread);
			} else {
				this._commentThreadCache[key] = [newThread];
			}
		});

		e.changed.forEach(thread => {
			const key = this.getCommentThreadCacheKey(thread.path, thread.diffSide === DiffSide.LEFT);
			const index = this._commentThreadCache[key] ? this._commentThreadCache[key].findIndex(t => t.gitHubThreadId === thread.id) : -1;
			if (index > -1) {
				const matchingThread = this._commentThreadCache[key][index];
				updateThread(this._context, matchingThread, thread, this._githubRepositories);
			}
		});

		e.removed.forEach(async thread => {
			const key = this.getCommentThreadCacheKey(thread.path, thread.diffSide === DiffSide.LEFT);
			const index = this._commentThreadCache[key].findIndex(t => t.gitHubThreadId === thread.id);
			if (index > -1) {
				const matchingThread = this._commentThreadCache[key][index];
				this._commentThreadCache[key].splice(index, 1);
				matchingThread.dispose();
			}
		});
	}

	hasCommentThread(thread: GHPRCommentThread): boolean {
		if (thread.uri.scheme !== Schemes.Pr) {
			return false;
		}

		const params = fromPRUri(thread.uri);

		if (!params || params.prNumber !== this.pullRequestModel.number) {
			return false;
		}

		return true;
	}

	private getCommentSide(thread: GHPRCommentThread): DiffSide {
		const query = fromPRUri(thread.uri);
		return query?.isBase ? DiffSide.LEFT : DiffSide.RIGHT;
	}

	public async createOrReplyComment(
		thread: GHPRCommentThread,
		input: string,
		isSingleComment: boolean,
		inDraft?: boolean,
	): Promise<void> {
		const hasExistingComments = thread.comments.length;
		const isDraft = isSingleComment
			? false
			: inDraft !== undefined
				? inDraft
				: this.pullRequestModel.hasPendingReview;
		const temporaryCommentId = await this.optimisticallyAddComment(thread, input, isDraft);

		try {
			if (hasExistingComments) {
				await this.reply(thread, input, isSingleComment);
			} else {
				const fileName = this.gitRelativeRootPath(thread.uri.path);
				const side = this.getCommentSide(thread);
				this._pendingCommentThreadAdds.push(thread);
				await this.pullRequestModel.createReviewThread(
					input,
					fileName,
					thread.range ? (thread.range.start.line + 1) : undefined,
					thread.range ? (thread.range.end.line + 1) : undefined,
					side,
					isSingleComment,
				);
			}

			if (isSingleComment) {
				await this.pullRequestModel.submitReview();
			}
		} catch (e) {
			if (e.graphQLErrors?.length && e.graphQLErrors[0].type === 'NOT_FOUND') {
				vscode.window.showWarningMessage('The comment that you\'re replying to was deleted. Refresh to update.', 'Refresh').then(result => {
					if (result === 'Refresh') {
						this.pullRequestModel.invalidate();
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

	private reply(thread: GHPRCommentThread, input: string, isSingleComment: boolean): Promise<IComment | undefined> {
		const replyingTo = thread.comments[0];
		if (replyingTo instanceof GHPRComment) {
			return this.pullRequestModel.createCommentReply(input, replyingTo.rawComment.graphNodeId, isSingleComment);
		} else {
			// TODO can we do better?
			throw new Error('Cannot respond to temporary comment');
		}
	}

	private async optimisticallyEditComment(thread: GHPRCommentThread, comment: GHPRComment): Promise<number> {
		const currentUser = await this._folderRepoManager.getCurrentUser(this.pullRequestModel.githubRepository);
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

	public async editComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			const temporaryCommentId = await this.optimisticallyEditComment(thread, comment);
			try {
				await this.pullRequestModel.editReviewComment(
					comment.rawComment,
					comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body,
				);
			} catch (e) {
				vscode.window.showErrorMessage(`Editing comment failed ${e}`);

				thread.comments = thread.comments.map(c => {
					if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
						return new GHPRComment(this._context, comment.rawComment, thread);
					}

					return c;
				});
			}
		} else {
			this.createOrReplyComment(
				thread,
				comment.body instanceof vscode.MarkdownString ? comment.body.value : comment.body,
				false,
			);
		}
	}

	public async deleteComment(thread: GHPRCommentThread, comment: GHPRComment | TemporaryComment): Promise<void> {
		if (comment instanceof GHPRComment) {
			await this.pullRequestModel.deleteReviewComment(comment.commentId);
		} else {
			thread.comments = thread.comments.filter(c => !(c instanceof TemporaryComment && c.id === comment.id));
		}

		await this.pullRequestModel.validateDraftMode();
	}
	// #endregion

	private gitRelativeRootPath(comparePath: string) {
		// get path relative to git root directory. Handles windows path by converting it to unix path.
		return path.relative(this._folderRepoManager.repository.rootUri.path, comparePath).replace(/\\/g, '/');
	}

	// #region Review
	public async startReview(thread: GHPRCommentThread, input: string): Promise<void> {
		const hasExistingComments = thread.comments.length;
		const temporaryCommentId = await this.optimisticallyAddComment(thread, input, true);

		try {
			if (!hasExistingComments) {
				const fileName = this.gitRelativeRootPath(thread.uri.path);
				const side = this.getCommentSide(thread);
				this._pendingCommentThreadAdds.push(thread);
				await this.pullRequestModel.createReviewThread(input, fileName, thread.range ? (thread.range.start.line + 1) : undefined, thread.range ? (thread.range.end.line + 1) : undefined, side);
			} else {
				await this.reply(thread, input, false);
			}

			this.setContextKey(true);
		} catch (e) {
			vscode.window.showErrorMessage(`Starting a review failed: ${e}`);

			thread.comments = thread.comments.map(c => {
				if (c instanceof TemporaryComment && c.id === temporaryCommentId) {
					c.mode = vscode.CommentMode.Editing;
				}

				return c;
			});
		}
	}


	public async openReview(): Promise<void> {
		await PullRequestOverviewPanel.createOrShow(this._folderRepoManager.context.extensionUri, this._folderRepoManager, this.pullRequestModel);
		PullRequestOverviewPanel.scrollToReview();

		/* __GDPR__
			"pr.openDescription" : {}
		*/
		this._folderRepoManager.telemetry.sendTelemetryEvent('pr.openDescription');
	}

	private async optimisticallyAddComment(thread: GHPRCommentThread, input: string, inDraft: boolean): Promise<number> {
		const currentUser = await this._folderRepoManager.getCurrentUser(this.pullRequestModel.githubRepository);
		const comment = new TemporaryComment(thread, input, inDraft, currentUser);
		this.updateCommentThreadComments(thread, [...thread.comments, comment]);
		return comment.id;
	}

	private updateCommentThreadComments(thread: GHPRCommentThread, newComments: (GHPRComment | TemporaryComment)[]) {
		thread.comments = newComments;
		updateCommentThreadLabel(thread);
	}

	private async createCommentOnResolve(thread: GHPRCommentThread, input: string): Promise<void> {
		const pendingReviewId = await this.pullRequestModel.getPendingReviewId();
		await this.createOrReplyComment(thread, input, !pendingReviewId);
	}

	public async resolveReviewThread(thread: GHPRCommentThread, input?: string): Promise<void> {
		try {
			if (input) {
				await this.createCommentOnResolve(thread, input);
			}

			await this.pullRequestModel.resolveReviewThread(thread.gitHubThreadId);
		} catch (e) {
			vscode.window.showErrorMessage(`Resolving conversation failed: ${e}`);
		}
	}

	public async unresolveReviewThread(thread: GHPRCommentThread, input?: string): Promise<void> {
		try {
			if (input) {
				await this.createCommentOnResolve(thread, input);
			}

			await this.pullRequestModel.unresolveReviewThread(thread.gitHubThreadId);
		} catch (e) {
			vscode.window.showErrorMessage(`Unresolving conversation failed: ${e}`);
		}
	}

	public async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		if (comment.parent!.uri.scheme !== Schemes.Pr) {
			return;
		}

		if (
			comment.reactions &&
			!comment.reactions.find(ret => ret.label === reaction.label && !!ret.authorHasReacted)
		) {
			// add reaction
			await this.pullRequestModel.addCommentReaction(comment.rawComment.graphNodeId, reaction);
		} else {
			await this.pullRequestModel.deleteCommentReaction(comment.rawComment.graphNodeId, reaction);
		}
	}

	private setContextKey(inDraftMode: boolean): void {
		vscode.commands.executeCommand('setContext', 'prInDraft', inDraftMode);
	}

	private removeAllCommentsThreads(): void {
		Object.keys(this._commentThreadCache).forEach(key => {
			dispose(this._commentThreadCache[key]);
		});
	}

	dispose() {
		this.removeAllCommentsThreads();
		unregisterCommentHandler(this._commentHandlerId);

		this._disposables.forEach(d => d.dispose());
	}
}
