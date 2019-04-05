/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LiveShare, SharedService } from 'vsls/vscode.js';
import { VSLS_GIT_PR_SESSION_NAME, VSLS_REQUEST_NAME, VSLS_REPOSITORY_INITIALIZATION_NAME, VSLS_STATE_CHANGE_NOFITY_NAME } from '../constants';
import { API } from '../api/api';
export class VSLSHost implements vscode.Disposable {
	private _sharedService?: SharedService;
	private _disposables: vscode.Disposable[];
	constructor(private _liveShareAPI: LiveShare, private _api: API) {
		this._disposables = [];
	}

	public async initialize() {
		this._sharedService = await this._liveShareAPI!.shareService(VSLS_GIT_PR_SESSION_NAME) || undefined;

		if (this._sharedService) {
			this._sharedService.onRequest(VSLS_REQUEST_NAME, this._gitHandler.bind(this));
		}
	}

	private async _gitHandler(args: any[]) {
		let type = args[0];
		let workspaceFolderPath = args[1];
		let workspaceFolderUri = vscode.Uri.parse(workspaceFolderPath);
		let localWorkSpaceFolderUri = this._liveShareAPI.convertSharedUriToLocal(workspaceFolderUri);
		let gitProvider = this._api.getGitProvider(localWorkSpaceFolderUri);

		if (!gitProvider) {
			return;
		}

		let localRepository: any = gitProvider.repositories.filter(repository => repository.rootUri.toString() === localWorkSpaceFolderUri.toString())[0];
		if (localRepository) {
			let commandArgs = args.slice(2);
			if (type === VSLS_REPOSITORY_INITIALIZATION_NAME) {
				this._disposables.push(localRepository.state.onDidChange((e: any) => {
					this._sharedService!.notify(VSLS_STATE_CHANGE_NOFITY_NAME, {
						HEAD: localRepository.state.HEAD,
						remotes: localRepository.state.remotes,
						refs: localRepository.state.refs
					});
				}));
				return {
					HEAD: localRepository.state.HEAD,
					remotes: localRepository.state.remotes,
					refs: localRepository.state.refs,
					rootUri: workspaceFolderUri.toString() // file: --> vsls:/
				};
			}

			if (type === 'show') {
				let path = commandArgs[1];
				let vslsFileUri = workspaceFolderUri.with({path: path});
				let localFileUri = this._liveShareAPI.convertSharedUriToLocal(vslsFileUri);
				commandArgs[1] = localFileUri.fsPath;

				return localRepository[type](...commandArgs);
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
		this._sharedService = undefined;
		this._disposables = [];
	}
}
