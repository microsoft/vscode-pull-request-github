/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { fromPRUri } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GHPRComment } from '../github/prComment';
import { PullRequestModel } from '../github/pullRequestModel';
import { CommentReactionHandler } from '../github/utils';
import { PullRequestCommentController } from './pullRequestCommentController';

interface PullRequestCommentHandlerInfo {
	handler: PullRequestCommentController & CommentReactionHandler;
	refCount: number;
	dispose: () => void;
}

export class PRCommentControllerRegistry implements vscode.CommentingRangeProvider, CommentReactionHandler, vscode.Disposable {
	private _prCommentHandlers: { [key: number]: PullRequestCommentHandlerInfo } = {};
	private _prCommentingRangeProviders: { [key: number]: vscode.CommentingRangeProvider2 } = {};
	private _activeChangeListeners: Map<FolderRepositoryManager, vscode.Disposable> = new Map();

	constructor(public commentsController: vscode.CommentController) {
		this.commentsController.commentingRangeProvider = this;
		this.commentsController.reactionHandler = this.toggleReaction.bind(this);
	}

	async provideCommentingRanges(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.Range[] | undefined> {
		const uri = document.uri;
		const params = fromPRUri(uri);

		if (!params || !this._prCommentingRangeProviders[params.prNumber]) {
			return;
		}

		const provideCommentingRanges = this._prCommentingRangeProviders[params.prNumber].provideCommentingRanges.bind(
			this._prCommentingRangeProviders[params.prNumber],
		);

		return provideCommentingRanges(document, token);
	}

	async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		const uri = comment.parent!.uri;
		const params = fromPRUri(uri);

		if (
			!params ||
			!this._prCommentHandlers[params.prNumber] ||
			!this._prCommentHandlers[params.prNumber].handler.toggleReaction
		) {
			return;
		}

		const toggleReaction = this._prCommentHandlers[params.prNumber].handler.toggleReaction!.bind(
			this._prCommentHandlers[params.prNumber].handler,
		);

		return toggleReaction(comment, reaction);
	}

	public unregisterCommentController(prNumber: number): void {
		if (this._prCommentHandlers[prNumber]) {
			this._prCommentHandlers[prNumber].dispose();
			delete this._prCommentHandlers[prNumber];
		}
	}

	public registerCommentController(prNumber: number, pullRequestModel: PullRequestModel, folderRepositoryManager: FolderRepositoryManager): vscode.Disposable {
		if (this._prCommentHandlers[prNumber]) {
			this._prCommentHandlers[prNumber].refCount += 1;
			return this._prCommentHandlers[prNumber];
		}

		if (!this._activeChangeListeners.has(folderRepositoryManager)) {
			this._activeChangeListeners.set(folderRepositoryManager, folderRepositoryManager.onDidChangeActivePullRequest(e => {
				if (e.old) {
					this._prCommentHandlers[e.old]?.dispose();
				}
			}));
		}

		const handler = new PullRequestCommentController(pullRequestModel, folderRepositoryManager, this.commentsController);
		this._prCommentHandlers[prNumber] = {
			handler,
			refCount: 1,
			dispose: () => {
				if (!this._prCommentHandlers[prNumber]) {
					return;
				}

				this._prCommentHandlers[prNumber].refCount -= 1;
				if (this._prCommentHandlers[prNumber].refCount === 0) {
					this._prCommentHandlers[prNumber].handler.dispose();
					delete this._prCommentHandlers[prNumber];
				}
			}
		};

		return this._prCommentHandlers[prNumber];
	}

	public registerCommentingRangeProvider(prNumber: number, provider: vscode.CommentingRangeProvider2): vscode.Disposable {
		this._prCommentingRangeProviders[prNumber] = provider;

		return {
			dispose: () => {
				delete this._prCommentingRangeProviders[prNumber];
			}
		};
	}

	dispose() {
		Object.keys(this._prCommentHandlers).forEach(key => {
			this._prCommentHandlers[key].handler.dispose();
		});

		this._prCommentingRangeProviders = {};
		this._prCommentHandlers = {};
	}
}
