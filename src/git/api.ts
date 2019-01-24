/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
export { API, Repository, InputBox, RepositoryState, RepositoryUIState, Commit, Branch, Git, RefType, UpstreamRef, GitErrorCodes } from '../typings/git';
import { API, Repository, Git } from '../typings/git';
import { LiveShare } from 'vsls/vscode.js';
import { VSLSGuest } from './vslsguest';
import { VSLSHost } from './vslshost';
import { Model } from './model';

/**
 * Should be removed once we fix the webpack bundling issue.
 */
async function getVSLSApi() {
	const liveshareExtension = vscode.extensions.getExtension('ms-vsliveshare.vsliveshare');
	if (!liveshareExtension) {
		// The extension is not installed.
		return null;
	}
	const extensionApi = liveshareExtension.isActive ?
		liveshareExtension.exports : await liveshareExtension.activate();
	if (!extensionApi) {
		// The extensibility API is not enabled.
		return null;
	}
	const liveShareApiVersion = liveshareExtension.packageJSON.version;
	// Support deprecated function name to preserve compatibility with older versions of VSLS.
	if (!extensionApi.getApi) {
		return extensionApi.getApiAsync(liveShareApiVersion);
	}
	return extensionApi.getApi(liveShareApiVersion);
}

class CommonGitAPI implements API, vscode.Disposable {
	git: Git;
	private _onDidOpenRepository = new vscode.EventEmitter<Repository>();
	readonly onDidOpenRepository: vscode.Event<Repository> = this._onDidOpenRepository.event;
	private _onDidCloseRepository = new vscode.EventEmitter<Repository>();
	readonly onDidCloseRepository: vscode.Event<Repository> = this._onDidCloseRepository.event;
	private _api?: LiveShare;
	private _host?: VSLSHost;
	private _guest?: VSLSGuest;
	get repositories(): Repository[] {
		return this._model.repositories;
	}
	private _disposables: vscode.Disposable[];

	constructor(
		private _model: Model
	) {
		this._disposables = [];
		this._disposables.push(this._model.onDidCloseRepository(e => this._onDidCloseRepository.fire(e)));
		this._disposables.push(this._model.onDidOpenRepository(e => this._onDidOpenRepository.fire(e)));
		this.initilize();
	}

	public async initilize() {
		if (!this._api) {
			this._api = await getVSLSApi();
		}

		this._disposables.push(this._api!.onDidChangeSession(e => this._onDidChangeSession(e.session), this));
		if (this._api!.session) {
			this._onDidChangeSession(this._api!.session);
		}
	}

	private async _onDidChangeSession(session: any) {
		if (this._host) {
			this._host.dispose();
		}

		if (this._guest) {
			this._guest.dispose();
		}

		if (session.role === 1 /* Role.Host */) {
			this._host = new VSLSHost(this._api!, this._model);
			await this._host.initialize();
			return;
		}

		if (session.role === 2 /* Role.Guest */) {
			this._guest = new VSLSGuest(this._api!, this._model);
			await this._guest.initialize();
		}
	}

	public dispose() {
		this._api = undefined;
		if (this._model) {
			this._model.dispose();
		}

		if (this._host) {
			this._host.dispose();
		}

		if (this._guest) {
			this._guest.dispose();
		}

		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}
}

const api = new CommonGitAPI(new Model());

export function getAPI(): CommonGitAPI {
	return api;
}