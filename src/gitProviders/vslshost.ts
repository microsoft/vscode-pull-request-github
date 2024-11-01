/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LiveShare, SharedService } from 'vsls/vscode.js';
import { API } from '../api/api';
import { Disposable } from '../common/lifecycle';
import {
	VSLS_GIT_PR_SESSION_NAME,
	VSLS_REPOSITORY_INITIALIZATION_NAME,
	VSLS_REQUEST_NAME,
	VSLS_STATE_CHANGE_NOTIFY_NAME,
} from '../constants';

export class VSLSHost extends Disposable {
	private _sharedService?: SharedService;
	constructor(private readonly _liveShareAPI: LiveShare, private _api: API) {
		super();
	}

	public async initialize() {
		this._sharedService = (await this._liveShareAPI!.shareService(VSLS_GIT_PR_SESSION_NAME)) || undefined;

		if (this._sharedService) {
			this._sharedService.onRequest(VSLS_REQUEST_NAME, this._gitHandler.bind(this));
		}
	}

	private async _gitHandler(args: any[]) {
		const type = args[0];
		const workspaceFolderPath = args[1];
		const workspaceFolderUri = vscode.Uri.parse(workspaceFolderPath);
		const localWorkSpaceFolderUri = this._liveShareAPI.convertSharedUriToLocal(workspaceFolderUri);
		const gitProvider = this._api.getGitProvider(localWorkSpaceFolderUri);

		if (!gitProvider) {
			return;
		}

		const localRepository: any = gitProvider.repositories.filter(
			repository => repository.rootUri.toString() === localWorkSpaceFolderUri.toString(),
		)[0];
		if (localRepository) {
			const commandArgs = args.slice(2);
			if (type === VSLS_REPOSITORY_INITIALIZATION_NAME) {

				this._register(localRepository.state.onDidChange(_ => {
					this._sharedService!.notify(VSLS_STATE_CHANGE_NOTIFY_NAME, {
						HEAD: localRepository.state.HEAD,
						remotes: localRepository.state.remotes,
						refs: localRepository.state.refs,
					});
				}));

				return {
					HEAD: localRepository.state.HEAD,
					remotes: localRepository.state.remotes,
					refs: localRepository.state.refs,
					rootUri: workspaceFolderUri.toString(), // file: --> vsls:/
				};
			}

			if (type === 'show') {
				const path = commandArgs[1];
				const vslsFileUri = workspaceFolderUri.with({ path: path });
				const localFileUri = this._liveShareAPI.convertSharedUriToLocal(vslsFileUri);
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
}
