/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitApiImpl } from '../api/api1';
import Logger from '../common/logger';
import { CredentialStore } from '../github/credentials';
import { ReadonlyFileSystemProvider } from './readonlyFileSystemProvider';

export abstract class RepositoryFileSystemProvider extends ReadonlyFileSystemProvider {
	constructor(protected gitAPI: GitApiImpl, protected credentialStore: CredentialStore) {
		super();
	}

	protected async waitForRepos(milliseconds: number): Promise<void> {
		Logger.appendLine('Waiting for repositories.', 'RepositoryFileSystemProvider');
		let eventDisposable: vscode.Disposable | undefined = undefined;
		const openPromise = new Promise<void>(resolve => {
			eventDisposable = this.gitAPI.onDidOpenRepository(() => {
				Logger.appendLine('Found at least one repository.', 'RepositoryFileSystemProvider');
				eventDisposable?.dispose();
				eventDisposable = undefined;
				resolve();
			});
		});
		let timeout: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<void>(resolve => {
			timeout = setTimeout(() => {
				Logger.appendLine('Timed out while waiting for repositories.', 'RepositoryFileSystemProvider');
				resolve();
			}, milliseconds);
		});
		await Promise.race([openPromise, timeoutPromise]);
		if (timeout) {
			clearTimeout(timeout);
		}
		if (eventDisposable) {
			(eventDisposable as vscode.Disposable).dispose();
		}
	}

	protected async waitForAuth(): Promise<void> {
		if (this.credentialStore.isAnyAuthenticated()) {
			return;
		}
		return new Promise(resolve => this.credentialStore.onDidGetSession(() => resolve()));
	}
}