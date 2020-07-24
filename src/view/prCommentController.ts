/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { fromPRUri } from '../common/uri';
import { GHPRCommentThread, GHPRComment } from '../github/prComment';
import { CommentReactionHandler } from '../github/utils';

export class PRCommentController implements vscode.CommentingRangeProvider, CommentReactionHandler, vscode.Disposable {
	private _prCommentControllers: { [key: number]: vscode.CommentingRangeProvider & CommentReactionHandler } = {};
	private _prDocumentCommentThreadMap: { [key: number]: { [key: string]: GHPRCommentThread[] } } = {};

	constructor(
		public commentsController: vscode.CommentController
	) {
		this.commentsController.commentingRangeProvider = this;
		this.commentsController.reactionHandler = this.toggleReaction.bind(this);
	}

	async provideCommentingRanges(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.Range[] | undefined> {
		const uri = document.uri;
		const params = fromPRUri(uri);

		if (!params || !this._prCommentControllers[params.prNumber]) {
			return;
		}

		const provideCommentingRanges = this._prCommentControllers[params.prNumber].provideCommentingRanges.bind(this._prCommentControllers[params.prNumber]);

		return provideCommentingRanges(document, token);
	}

	async toggleReaction(comment: GHPRComment, reaction: vscode.CommentReaction): Promise<void> {
		const uri = comment.parent!.uri;
		const params = fromPRUri(uri);

		if (!params || !this._prCommentControllers[params.prNumber] || !this._prCommentControllers[params.prNumber].toggleReaction) {
			return;
		}

		const toggleReaction = this._prCommentControllers[params.prNumber].toggleReaction!.bind(this._prCommentControllers[params.prNumber]);

		return toggleReaction(comment, reaction);
	}

	public registerCommentController(prNumber: number, provider: vscode.CommentingRangeProvider & CommentReactionHandler) {
		this._prCommentControllers[prNumber] = provider;
		if (!this._prDocumentCommentThreadMap[prNumber]) {
			this._prDocumentCommentThreadMap[prNumber] = {};
		}

		const commentThreadCache = this._prDocumentCommentThreadMap[prNumber];

		return {
			commentThreadCache: commentThreadCache,
			dispose: () => {
				delete this._prCommentControllers[prNumber];
			}
		};
	}

	public clearCommentThreadCache(prNumber: number) {
		if (this._prDocumentCommentThreadMap[prNumber]) {
			for (const fileName in this._prDocumentCommentThreadMap[prNumber]) {
				this._prDocumentCommentThreadMap[prNumber][fileName].forEach(thread => thread.dispose!());
			}

			this._prDocumentCommentThreadMap[prNumber] = {};
		}
	}

	dispose() {
		this._prCommentControllers = {};
		this._prDocumentCommentThreadMap = {};
	}
}