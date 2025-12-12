/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../../common/lifecycle';
import { CreatePullRequestActionContext, GitLensApi } from './gitlens';

export class GitLensIntegration extends Disposable {
	private _extensionsDisposable: vscode.Disposable;

	constructor() {
		super();
		this._extensionsDisposable = this._register(vscode.extensions.onDidChange(this.onExtensionsChanged, this));
		this.onExtensionsChanged();
	}

	private register(api: GitLensApi | undefined) {
		if (!api) {
			return;
		}
		this._register(
			api.registerActionRunner('createPullRequest', {
				partnerId: 'ghpr',
				name: 'GitHub Pull Requests and Issues',
				label: 'Create Pull Request',
				run: function (context: CreatePullRequestActionContext) {
					// For now only work with branches that aren't remote
					if (context.branch.isRemote) {
						return;
					}

					vscode.commands.executeCommand('pr.create', {
						repoPath: context.repoPath,
						compareBranch: context.branch.name,
					});
				},
			}),
		);
	}

	private async onExtensionsChanged() {
		const extension =
			vscode.extensions.getExtension<Promise<GitLensApi | undefined>>('eamodio.gitlens') ??
			vscode.extensions.getExtension<Promise<GitLensApi | undefined>>('eamodio.gitlens-insiders');
		if (extension) {
			this._extensionsDisposable.dispose();

			if (extension.isActive) {
				this.register(await extension.exports);
			} else {
				let count = 0;
				// https://github.com/microsoft/vscode/issues/113783 -- since no event exists, poll
				const handle = setInterval(async () => {
					if (extension.isActive) {
						clearInterval(handle);

						this.register(await extension.exports);
					} else {
						count++;
						// Give up after 60 seconds
						if (count > 60) {
							clearInterval(handle);
						}
					}
				}, 1000);
			}
		}
	}
}
