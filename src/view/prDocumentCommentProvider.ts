/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { fromPRUri } from '../common/uri';
import { PullRequestModel } from '../github/pullRequestModel';
import { getReactionGroup } from '../github/utils';

export class PRDocumentCommentProvider implements vscode.DocumentCommentProvider {
	private _onDidChangeCommentThreads: vscode.EventEmitter<vscode.CommentThreadChangedEvent> = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();
	public onDidChangeCommentThreads: vscode.Event<vscode.CommentThreadChangedEvent> = this._onDidChangeCommentThreads.event;

	protected _prDocumentCommentProviders: {[key: number]: vscode.DocumentCommentProvider} = {};

	constructor() {}

	public registerDocumentCommentProvider(pullRequestModel: PullRequestModel, provider: vscode.DocumentCommentProvider) {
		this._prDocumentCommentProviders[pullRequestModel.prNumber] = provider;
		const changeListener = provider.onDidChangeCommentThreads(e => {
			this._onDidChangeCommentThreads.fire(e);
		});

		return {
			dispose: () => {
				changeListener.dispose();
				delete this._prDocumentCommentProviders[pullRequestModel.prNumber];
			}
		};

	}

	async provideDocumentComments(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CommentInfo | undefined> {
		let uri = document.uri;
		if (uri.scheme === 'pr') {
			let params = fromPRUri(uri);

			if (!params || !this._prDocumentCommentProviders[params.prNumber]) {
				return;
			}

			return await this._prDocumentCommentProviders[params.prNumber].provideDocumentComments(document, token);
		}
	}

	async createNewCommentThread(document: vscode.TextDocument, range: vscode.Range, text: string, token: vscode.CancellationToken): Promise<vscode.CommentThread | undefined> {
		let uri = document.uri;
		let params = fromPRUri(uri);

		if (!params || !this._prDocumentCommentProviders[params.prNumber]) {
			return;
		}

		return await this._prDocumentCommentProviders[params.prNumber].createNewCommentThread(document, range, text, token);
	}
	async replyToCommentThread(document: vscode.TextDocument, range: vscode.Range, commentThread: vscode.CommentThread, text: string, token: vscode.CancellationToken): Promise<vscode.CommentThread | undefined> {
		let uri = document.uri;
		let params = fromPRUri(uri);

		if (!params || !this._prDocumentCommentProviders[params.prNumber]) {
			return;
		}

		return await this._prDocumentCommentProviders[params.prNumber].replyToCommentThread(document, range, commentThread, text, token);
	}

	async editComment(document: vscode.TextDocument, comment: vscode.Comment, text: string, token: vscode.CancellationToken): Promise<void> {
		const params = fromPRUri(document.uri);
		if (!params) {
			throw new Error(`Current document ${document.uri.toString()} is not valid PR document`);
		}

		const commentProvider = this._prDocumentCommentProviders[params.prNumber];

		if (!commentProvider) {
			throw new Error(`Couldn't find document provider`);
		}

		if (!commentProvider.editComment) {
			throw new Error(`Document provider doesn't support editing comment.`);
		}

		await commentProvider.editComment(document, comment, text, token);
		return;
	}

	async deleteComment(document: vscode.TextDocument, comment: vscode.Comment, token: vscode.CancellationToken): Promise<void> {
		const params = fromPRUri(document.uri);

		if (!params) {
			throw new Error(`Current document ${document.uri.toString()} is not valid PR document`);
		}

		const commentProvider = this._prDocumentCommentProviders[params.prNumber];

		if (!commentProvider) {
			throw new Error(`Couldn't find document provider`);
		}

		if (!commentProvider.deleteComment) {
			throw new Error(`Document provider doesn't support deleting comment.`);
		}

		return await commentProvider.deleteComment(document, comment, token);
	}
}

export class PRDocumentCommentProviderGraphQL extends PRDocumentCommentProvider implements vscode.DocumentCommentProvider {
	constructor() {
		super();
	}

	startDraftLabel = 'Start Review';
	deleteDraftLabel = 'Delete Review';
	finishDraftLabel = 'Finish Review';
	reactionGroup = getReactionGroup();

	async startDraft(document: vscode.TextDocument, token: vscode.CancellationToken) {
		const params = fromPRUri(document.uri);
		if (!params) {
			throw new Error(`Document ${document.uri.toString()} does not support draft`);
		}
		const commentProvider = this._prDocumentCommentProviders[params.prNumber];

		if (!commentProvider) {
			throw new Error(`Couldn't find document provider`);
		}

		return await commentProvider.startDraft!(document, token);
	}

	async finishDraft(document: vscode.TextDocument, token: vscode.CancellationToken) {
		const params = fromPRUri(document.uri);
		if (!params) {
			throw new Error(`Document ${document.uri.toString()} does not support draft`);
		}

		const commentProvider = this._prDocumentCommentProviders[params.prNumber];

		if (!commentProvider) {
			throw new Error(`Couldn't find document provider`);
		}

		return await commentProvider.finishDraft!(document, token);
	}

	async deleteDraft(document: vscode.TextDocument, token: vscode.CancellationToken) {
		const params = fromPRUri(document.uri);
		if (!params) {
			throw new Error(`Document ${document.uri.toString()} does not support draft`);
		}

		const commentProvider = this._prDocumentCommentProviders[params.prNumber];

		if (!commentProvider) {
			throw new Error(`Couldn't find document provider`);
		}

		return await commentProvider.deleteDraft!(document, token);
	}

	async addReaction(document: vscode.TextDocument, comment: vscode.Comment, reaction: vscode.CommentReaction) {
		const params = fromPRUri(document.uri);

		if (!params) {
			throw new Error(`Document ${document.uri.toString()} does not support reactions`);
		}
		const commentProvider = this._prDocumentCommentProviders[params.prNumber];

		if (!commentProvider) {
			throw new Error(`Couldn't find document provider`);
		}

		return await commentProvider.addReaction!(document, comment, reaction);
	}

	async deleteReaction(document: vscode.TextDocument, comment: vscode.Comment, reaction: vscode.CommentReaction) {
		const params = fromPRUri(document.uri);

		if (!params) {
			throw new Error(`Document ${document.uri.toString()} does not support reactions`);
		}
		const commentProvider = this._prDocumentCommentProviders[params.prNumber];

		if (!commentProvider) {
			throw new Error(`Couldn't find document provider`);
		}

		return await commentProvider.deleteReaction!(document, comment, reaction);
	}
}