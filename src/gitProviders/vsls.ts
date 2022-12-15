/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LiveShare } from 'vsls/vscode.js';
import { API } from '../api/api';
import { VSLSGuest } from './vslsguest';
import { VSLSHost } from './vslshost';

/**
 * Should be removed once we fix the webpack bundling issue.
 */
async function getVSLSApi() {
	const liveshareExtension = vscode.extensions.getExtension('ms-vsliveshare.vsliveshare');
	if (!liveshareExtension) {
		// The extension is not installed.
		return null;
	}
	const extensionApi = liveshareExtension.isActive ? liveshareExtension.exports : await liveshareExtension.activate();
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

export class LiveShareManager implements vscode.Disposable {
	private _liveShareAPI?: LiveShare;
	private _host?: VSLSHost;
	private _guest?: VSLSGuest;
	private _localDisposables: vscode.Disposable[];
	private _globalDisposables: vscode.Disposable[];

	constructor(private _api: API) {
		this._localDisposables = [];
		this._globalDisposables = [];
	}

	/**
	 * return the liveshare api if available
	 */
	public async initialize(): Promise<LiveShare | undefined> {
		if (!this._liveShareAPI) {
			this._liveShareAPI = await getVSLSApi();
		}

		if (!this._liveShareAPI) {
			return;
		}

		this._globalDisposables.push(
			this._liveShareAPI.onDidChangeSession(e => this._onDidChangeSession(e.session), this),
		);
		if (this._liveShareAPI!.session) {
			this._onDidChangeSession(this._liveShareAPI!.session);
		}

		return this._liveShareAPI;
	}

	private async _onDidChangeSession(session: any) {
		this._localDisposables.forEach(disposable => disposable.dispose());

		if (session.role === 1 /* Role.Host */) {
			this._host = new VSLSHost(this._liveShareAPI!, this._api);
			this._localDisposables.push(this._host);
			await this._host.initialize();
			return;
		}

		if (session.role === 2 /* Role.Guest */) {
			this._guest = new VSLSGuest(this._liveShareAPI!);
			this._localDisposables.push(this._guest);
			await this._guest.initialize();
			this._localDisposables.push(this._api.registerGitProvider(this._guest));
		}
	}

	public dispose() {
		this._liveShareAPI = undefined;
		this._localDisposables.forEach(d => d.dispose());
		this._globalDisposables.forEach(d => d.dispose());
	}
}
