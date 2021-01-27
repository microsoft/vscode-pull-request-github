/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, Disposable, extensions } from 'vscode';
import { CreatePullRequestActionContext, GitLensApi } from './gitlens';

export class GitLensIntegration implements Disposable {
	private _extensionsDisposable: Disposable;
	private _subscriptions: Disposable[] = [];

	constructor() {
		this._extensionsDisposable = extensions.onDidChange(this.onExtensionsChanged, this);
		this.onExtensionsChanged();
	}

	dispose() {
		this._extensionsDisposable.dispose();
		Disposable.from(...this._subscriptions).dispose();
	}

	private register(api: GitLensApi) {
		this._subscriptions.push(
			api.registerActionRunner('createPullRequest', {
				partnerId: 'ghpr',
				name: 'GitHub Pull Requests and Issues',
				label: 'Create Pull Request',
				run: function (context: CreatePullRequestActionContext) {
					// For now only work with branches that aren't remote
					if (context.branch.isRemote) {
						return;
					}

					commands.executeCommand('pr.create', { repoPath: context.repoPath, compareBranch: context.branch.name });
				}
			})
		);
	}

	private async onExtensionsChanged() {
		const extension = extensions.getExtension<Promise<GitLensApi>>('eamodio.gitlens') ??
		extensions.getExtension<Promise<GitLensApi>>('eamodio.gitlens-insiders');
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
