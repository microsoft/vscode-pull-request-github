/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { fromPRUri } from '../common/uri';
import { PullRequestModel } from '../github/pullRequestModel';

export class PRDocumentCommentProvider implements vscode.DocumentCommentProvider {
	private _onDidChangeCommentThreads: vscode.EventEmitter<vscode.CommentThreadChangedEvent> = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();
	public onDidChangeCommentThreads: vscode.Event<vscode.CommentThreadChangedEvent> = this._onDidChangeCommentThreads.event;

	private _prDocumentCommentProviders: {[key: number]: vscode.DocumentCommentProvider} = {};

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

	async provideDocumentComments(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CommentInfo | null> {
		let uri = document.uri;
		if (uri.scheme === 'pr') {
			let params = fromPRUri(uri);

			if (!params) {
				return null;
			}

			if (!this._prDocumentCommentProviders[params.prNumber]) {
				return null;
			}

			return await this._prDocumentCommentProviders[params.prNumber].provideDocumentComments(document, token);
		}

		return null;
	}

	async createNewCommentThread(document: vscode.TextDocument, range: vscode.Range, text: string, token: vscode.CancellationToken): Promise<vscode.CommentThread | null> {
		let uri = document.uri;
		let params = fromPRUri(uri);

		if (!params) {
			return null;
		}

		if (!this._prDocumentCommentProviders[params.prNumber]) {
			return null;
		}

		return await this._prDocumentCommentProviders[params.prNumber].createNewCommentThread(document, range, text, token);
	}
	async replyToCommentThread(document: vscode.TextDocument, range: vscode.Range, commentThread: vscode.CommentThread, text: string, token: vscode.CancellationToken): Promise<vscode.CommentThread | null> {
		let uri = document.uri;
		let params = fromPRUri(uri);

		if (!params) {
			return null;
		}

		if (!this._prDocumentCommentProviders[params.prNumber]) {
			return null;
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

const prDocumentCommentProvider = new PRDocumentCommentProvider();

export function getPRDocumentCommentProvider(): PRDocumentCommentProvider {
	return prDocumentCommentProvider;
}