/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { API } from '../api/api';
import { LiveShareManager } from './vsls';
import { CredentialStore } from '../github/credentials';
import { BuiltinGitProvider } from './builtinGit';

export function registerLiveShareGitProvider(apiImpl: API): LiveShareManager {
	const liveShareManager = new LiveShareManager(apiImpl);
	return liveShareManager;
}

export function registerBuiltinGitProvider(_credentialStore: CredentialStore, apiImpl: API): vscode.Disposable | undefined {
	const builtInGitProvider = BuiltinGitProvider.createProvider();
	if (builtInGitProvider) {
		apiImpl.registerGitProvider(builtInGitProvider);
		return builtInGitProvider;
	}
}