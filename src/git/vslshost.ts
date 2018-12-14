/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LiveShare, SharedService } from 'vsls/vscode.js';
import { Model } from './model';
import { VSLS_GIT_PR_SESSION_NAME, VSLS_REQUEST_NAME, VSLS_REPOSITORY_INITIALIZATION_NAME, VSLS_STATE_CHANGE_NOFITY_NAME } from '../constants';
export class VSLSHost implements vscode.Disposable {
	private _sharedService: SharedService;
	private _disposables: vscode.Disposable[];
	constructor(private _api: LiveShare, private _model: Model) {
		this._sharedService = null;
		this._disposables = [];
	}

	async initialize() {
		this._sharedService = await this._api.shareService(VSLS_GIT_PR_SESSION_NAME);
		this._sharedService.onRequest(VSLS_REQUEST_NAME, this._gitHandler.bind(this));
	}

	private async _gitHandler(args: any[]) {
		let type = args[0];
		let workspaceFolderUri = args[1];
		let localWorkSpaceFolderUri = this._api.convertSharedUriToLocal(vscode.Uri.parse(workspaceFolderUri));
		let localRepository = this._model.repositories.filter(repository => repository.rootUri.toString() === localWorkSpaceFolderUri.toString())[0];
		if (localRepository) {
			let commandArgs = args.slice(2);
			if (type === VSLS_REPOSITORY_INITIALIZATION_NAME) {
				this._disposables.push(localRepository.state.onDidChange(e => {
					this._sharedService.notify(VSLS_STATE_CHANGE_NOFITY_NAME, {
						HEAD: localRepository.state.HEAD,
						remotes: localRepository.state.remotes,
						refs: localRepository.state.refs
					});
				}));
				return {
					HEAD: localRepository.state.HEAD,
					remotes: localRepository.state.remotes,
					refs: localRepository.state.refs,
					rootUri: localRepository.rootUri.toString()
				};
			}
			if (localRepository[type]) {
				return localRepository[type](...commandArgs);
			}
		} else {
			return null;
		}
	}
	public dispose() {
		this._disposables.forEach(d => d.dispose());
		this._sharedService = null;
		this._disposables = [];
		this._api = null;
		this._model = null;
	}
}
