/*---------------------------------------------------------------------------------------------
*  Copyright (c) Microsoft Corporation. All rights reserved.
*  Licensed under the MIT License. See License.txt in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { GHPRCommentThread } from '../github/prComment';
import * as vscode from 'vscode';

export class CommentThreadCache {
	private _data: { [key: string]: { original?: GHPRCommentThread[], modified?: GHPRCommentThread[] } } = {};

	public setDocumentThreads(fileName: string, isBase: boolean, threads: GHPRCommentThread[] | undefined) {
		if (!this._data[fileName]) {
			this._data[fileName] = {};
		}

		if (isBase) {
			this._data[fileName].original = threads;
		} else {
			this._data[fileName].modified = threads;
		}
	}

	public getDocuments(): string[] {
		return Object.keys(this._data);
	}

	public getThreadsForDocument(fileName: string, isBase: boolean): GHPRCommentThread[] | undefined {
		const documentData = this._data[fileName];
		return isBase ? documentData && documentData.original : documentData && documentData.modified;
	}

	public getAllThreadsForDocument(fileName: string): GHPRCommentThread[] | undefined {
		return this._data[fileName] && (this._data[fileName].original || []).concat(this._data[fileName].modified || []);
	}

	public maybeDisposeThreads(visibleEditors: vscode.TextEditor[], matchEditor: (editor: vscode.TextEditor, fileName: string, isBase: boolean) => boolean) {
		for (const fileName in this._data) {
			const threads = this._data[fileName];

			const originalEditor = visibleEditors.find(editor => matchEditor(editor, fileName, true));

			if (!originalEditor && threads.original) {
				threads.original.forEach(thread => thread.dispose!());
				this._data[fileName].original = undefined;
			}

			const modifiedEditor = visibleEditors.find(editor => matchEditor(editor, fileName, false));

			if (!modifiedEditor && threads.modified) {
				threads.modified.forEach(thread => thread.dispose!());
				this._data[fileName].modified = undefined;
			}

			if (!this._data[fileName].original && !this._data[fileName].modified) {
				delete this._data[fileName];
			}
		}
	}
}