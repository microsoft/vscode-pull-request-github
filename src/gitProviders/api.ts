/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { API } from '../api/api';
import { LiveShareManager } from './vsls';
import { BuiltinGitProvider } from './builtinGit';

export function registerBuiltinGitProvider(apiImpl: API): vscode.Disposable {
	let builtInGitProvider = new BuiltinGitProvider();
	apiImpl.registerGitProvider(builtInGitProvider);
	return builtInGitProvider;
}

export function registerLiveShareGitProvider(apiImpl: API): vscode.Disposable {
	let liveShareGitProvider = new LiveShareManager(apiImpl);
	return liveShareGitProvider;
}