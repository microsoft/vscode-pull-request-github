/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { API } from '../../../api/api';
import { BuiltinGitProvider } from '../../../gitProviders/builtinGit';
import { CredentialStore } from '../../../github/credentials';

export function registerBuiltinGitProvider(_credentialStore: CredentialStore, apiImpl: API): vscode.Disposable {
	const builtInGitProvider = new BuiltinGitProvider();
	apiImpl.registerGitProvider(builtInGitProvider);
	return builtInGitProvider;
}