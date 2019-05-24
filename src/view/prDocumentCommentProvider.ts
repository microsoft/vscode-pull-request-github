/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { fromPRUri } from '../common/uri';
import { getReactionGroup } from '../github/utils';
import { GHPRCommentThread } from '../github/prComment';

export class PRDocumentCommentProvider implements vscode.CommentingRangeProvider, vscode.CommentReactionProvider, vscode.Disposable {
	availableReactions: vscode.CommentReaction[] = getReactionGroup();
	private _prDocumentCommentProviders: {[key: number]: vscode.CommentingRangeProvider & vscode.CommentReactionProvider } = {};
	private _prDocumentCommentThreadMap: {[key: number]: { [key: string]: GHPRCommentThread[] } } = {};

	constructor(
		public commentsController: vscode.CommentController
	) {
		this.commentsController.commentingRangeProvider = this;
		this.commentsController.reactionProvider = this;
	}

	async provideCommentingRanges(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.Range[] | undefined> {
		let uri = document.uri;
		let params = fromPRUri(uri);

		if (!params || !this._prDocumentCommentProviders[params.prNumber]) {
			return;
		}

		let provideCommentingRanges = this._prDocumentCommentProviders[params.prNumber].provideCommentingRanges.bind(this._prDocumentCommentProviders[params.prNumber]);

		return provideCommentingRanges(document, token);
	}

	async toggleReaction(document: vscode.TextDocument, comment: vscode.Comment, reaction: vscode.CommentReaction): Promise<void> {
		let uri = document.uri;
		let params = fromPRUri(uri);

		if (!params || !this._prDocumentCommentProviders[params.prNumber] || !this._prDocumentCommentProviders[params.prNumber].toggleReaction) {
			return;
		}

		let toggleReaction = this._prDocumentCommentProviders[params.prNumber].toggleReaction!.bind(this._prDocumentCommentProviders[params.prNumber]);

		return toggleReaction(document, comment, reaction);
	}

	public registerDocumentCommentProvider(prNumber: number, provider: vscode.CommentingRangeProvider & vscode.CommentReactionProvider) {
		this._prDocumentCommentProviders[prNumber] = provider;
		if (!this._prDocumentCommentThreadMap[prNumber]) {
			this._prDocumentCommentThreadMap[prNumber] = {};
		}

		let commentThreadCache = this._prDocumentCommentThreadMap[prNumber];

		return {
			commentThreadCache: commentThreadCache,
			dispose: () => {
				delete this._prDocumentCommentProviders[prNumber];
			}
		};
	}

	public clearCommentThreadCache(prNumber: number) {
		if (this._prDocumentCommentThreadMap[prNumber]) {
			for (let fileName in this._prDocumentCommentThreadMap[prNumber]) {
				this._prDocumentCommentThreadMap[prNumber][fileName].forEach(thread => thread.dispose!());
			}

			this._prDocumentCommentThreadMap[prNumber] = {};
		}
	}

	dispose() {
		this._prDocumentCommentProviders = {};
		this._prDocumentCommentThreadMap = {};
	}
}