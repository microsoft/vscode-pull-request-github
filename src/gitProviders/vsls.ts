/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LiveShare } from 'vsls/vscode.js';
import { VSLSGuest } from './vslsguest';
import { VSLSHost } from './vslshost';
import { IGit, Repository, API } from '../api/api';

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
	const liveShareApiVersion = '0.3.967';
	// Support deprecated function name to preserve compatibility with older versions of VSLS.
	if (!extensionApi.getApi) {
		return extensionApi.getApiAsync(liveShareApiVersion);
	}
	return extensionApi.getApi(liveShareApiVersion);
}

export class LiveShareGitProvider implements IGit, vscode.Disposable {
	private _onDidOpenRepository = new vscode.EventEmitter<Repository>();
	readonly onDidOpenRepository: vscode.Event<Repository> = this._onDidOpenRepository.event;
	private _onDidCloseRepository = new vscode.EventEmitter<Repository>();
	readonly onDidCloseRepository: vscode.Event<Repository> = this._onDidCloseRepository.event;
	private _api?: LiveShare;
	private _host?: VSLSHost;
	private _guest?: VSLSGuest;
	private _openRepositories: Repository[] = [];

	get repositories(): Repository[] {
		return this._openRepositories;
	}
	private _disposables: vscode.Disposable[];

	constructor(
		private _apiImpl: API
	) {
		this._disposables = [];
		this.initilize();
	}

	public async initilize() {
		if (!this._api) {
			this._api = await getVSLSApi();
		}

		if (!this._api) {
			return;
		}

		this._disposables.push(this._api.onDidChangeSession(e => this._onDidChangeSession(e.session), this));
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
			this._host = new VSLSHost(this._api!, this._apiImpl);
			await this._host.initialize();
			return;
		}

		if (session.role === 2 /* Role.Guest */) {
			this._guest = new VSLSGuest(this._api!);
			await this._guest.initialize();
			this._apiImpl.registerGitProvider(this._guest);
		}
	}

	public dispose() {
		this._api = undefined;

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