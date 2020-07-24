/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { fromPRUri } from '../common/uri';

export class InMemPRContentProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	get onDidChange(): vscode.Event<vscode.Uri> { return this._onDidChange.event; }

	fireDidChange(uri: vscode.Uri) {
		this._onDidChange.fire(uri);
	}

	private _prFileChangeContentProviders: { [key: number]: (uri: vscode.Uri) => Promise<string> } = {};

	constructor() { }

	async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
		const prUriParams = fromPRUri(uri);
		if (prUriParams && prUriParams.prNumber) {
			const provider = this._prFileChangeContentProviders[prUriParams.prNumber];

			if (provider) {
				return await provider(uri);
			}
		}

		return '';
	}

	registerTextDocumentContentProvider(prNumber: number, provider: (uri: vscode.Uri) => Promise<string>): vscode.Disposable {
		this._prFileChangeContentProviders[prNumber] = provider;

		return {
			dispose: () => {
				delete this._prFileChangeContentProviders[prNumber];
			}
		};
	}
}

const inMemPRContentProvider = new InMemPRContentProvider();

export function getInMemPRContentProvider(): InMemPRContentProvider {
	return inMemPRContentProvider;
}