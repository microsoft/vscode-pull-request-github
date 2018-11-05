/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { IPullRequestModel } from '../github/interface';
import { fromPRUri } from '../common/uri';

export class PRDocumentCommentProvider implements vscode.DocumentCommentProvider {
	private _onDidChangeCommentThreads: vscode.EventEmitter<vscode.CommentThreadChangedEvent> = new vscode.EventEmitter<vscode.CommentThreadChangedEvent>();
	public onDidChangeCommentThreads: vscode.Event<vscode.CommentThreadChangedEvent> = this._onDidChangeCommentThreads.event;

	private _prDocumentCommentProviders: {[key: number]: vscode.DocumentCommentProvider} = {};

	constructor() {}

	public registerDocumentCommentProvider(pullRequestModel: IPullRequestModel, provider: vscode.DocumentCommentProvider) {
		this._prDocumentCommentProviders[pullRequestModel.prNumber] = provider;
		const changeListener = provider.onDidChangeCommentThreads(e => {
			this._onDidChangeCommentThreads.fire(e);
		});

		return {
			dispose: () => {
				changeListener.dispose();
				this._prDocumentCommentProviders[pullRequestModel.prNumber] = null;
			}
		};

	}

	async provideDocumentComments(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CommentInfo> {
		let uri = document.uri;
		if (uri.scheme === 'pr') {
			let params = fromPRUri(uri);

			if (!this._prDocumentCommentProviders[params.prNumber]) {
				return null;
			}

			return await this._prDocumentCommentProviders[params.prNumber].provideDocumentComments(document, token);
		}
	}

	async createNewCommentThread(document: vscode.TextDocument, range: vscode.Range, text: string, token: vscode.CancellationToken): Promise<vscode.CommentThread> {
		let uri = document.uri;
		let params = fromPRUri(uri);

		if (!this._prDocumentCommentProviders[params.prNumber]) {
			return null;
		}

		return await this._prDocumentCommentProviders[params.prNumber].createNewCommentThread(document, range, text, token);
	}
	async replyToCommentThread(document: vscode.TextDocument, range: vscode.Range, commentThread: vscode.CommentThread, text: string, token: vscode.CancellationToken): Promise<vscode.CommentThread> {
		let uri = document.uri;
		let params = fromPRUri(uri);

		if (!this._prDocumentCommentProviders[params.prNumber]) {
			return null;
		}

		return await this._prDocumentCommentProviders[params.prNumber].replyToCommentThread(document, range, commentThread, text, token);
	}

	async editComment(document: vscode.TextDocument, comment: vscode.Comment, text: string, token: vscode.CancellationToken): Promise<void> {
		const params = fromPRUri(document.uri);
		const commentProvider = this._prDocumentCommentProviders[params.prNumber];

		if (!commentProvider) {
			throw new Error(`Couldn't find document provider`);
		}

		return await commentProvider.editComment(document, comment, text, token);
	}

	async deleteComment(document: vscode.TextDocument, comment: vscode.Comment, token: vscode.CancellationToken): Promise<void> {
		const params = fromPRUri(document.uri);
		const commentProvider = this._prDocumentCommentProviders[params.prNumber];

		if (!commentProvider) {
			throw new Error(`Couldn't find document provider`);
		}

		return await commentProvider.deleteComment(document, comment, token);
	}
}

const prDocumentCommentProvider = new PRDocumentCommentProvider();

export function getPRDocumentCommentProvider(): PRDocumentCommentProvider {
	return prDocumentCommentProvider;
}