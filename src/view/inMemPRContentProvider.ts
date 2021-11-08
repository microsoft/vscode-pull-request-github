/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { fromPRUri } from '../common/uri';
import { ReadonlyFileSystemProvider } from './readonlyFileSystemProvider';

export class InMemPRFileSystemProvider extends ReadonlyFileSystemProvider {
	private _prFileChangeContentProviders: { [key: number]: (uri: vscode.Uri) => Promise<string> } = {};

	registerTextDocumentContentProvider(
		prNumber: number,
		provider: (uri: vscode.Uri) => Promise<string>,
	): vscode.Disposable {
		this._prFileChangeContentProviders[prNumber] = provider;

		return {
			dispose: () => {
				delete this._prFileChangeContentProviders[prNumber];
			},
		};
	}

	async readFile(uri: any): Promise<Uint8Array> {
		const prUriParams = fromPRUri(uri);
		if (prUriParams && prUriParams.prNumber) {
			const provider = this._prFileChangeContentProviders[prUriParams.prNumber];

			if (provider) {
				const content = await provider(uri);
				return new TextEncoder().encode(content);
			}
		}

		return new TextEncoder().encode('');
	}
}

const inMemPRFileSystemProvider = new InMemPRFileSystemProvider();

export function getInMemPRFileSystemProvider(): InMemPRFileSystemProvider {
	return inMemPRFileSystemProvider;
}