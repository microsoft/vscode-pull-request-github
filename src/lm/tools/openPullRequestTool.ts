/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { fromPRUri, fromReviewUri, Schemes } from '../../common/uri';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';
import { PullRequestTool } from './activePullRequestTool';

export class OpenPullRequestTool extends PullRequestTool {
	public static readonly toolId = 'github-pull-request_openPullRequest';

	protected _findActivePullRequest(): PullRequestModel | undefined {
		// First check if there's a PR overview panel open
		const panelPR = PullRequestOverviewPanel.currentPanel?.getCurrentItem();
		if (panelPR) {
			return panelPR;
		}

		// Check if the active file is a diff view or multidiff view showing PR content
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor?.document.uri) {
			const uri = activeEditor.document.uri;

			if (uri.scheme === Schemes.Pr) {
				// This is a PR diff from GitHub
				const prParams = fromPRUri(uri);
				if (prParams) {
					return this._findPullRequestByNumber(prParams.prNumber, prParams.remoteName);
				}
			} else if (uri.scheme === Schemes.Review) {
				// This is a review diff from a checked out PR
				const reviewParams = fromReviewUri(uri.query);
				if (reviewParams) {
					// For review scheme, find the active/checked out PR
					const folderManager = this.folderManagers.folderManagers.find(manager => manager.activePullRequest);
					return folderManager?.activePullRequest;
				}
			}
		}

		return undefined;
	}

	private _findPullRequestByNumber(prNumber: number, remoteName: string): PullRequestModel | undefined {
		for (const manager of this.folderManagers.folderManagers) {
			for (const repo of manager.gitHubRepositories) {
				if (repo.remote.remoteName === remoteName) {
					// Look for the PR in the repository's PR cache
					for (const pr of repo.pullRequestModels) {
						if (pr.number === prNumber) {
							return pr;
						}
					}
				}
			}
		}
		return undefined;
	}

	protected _confirmationTitle(): string {
		return vscode.l10n.t('Open Pull Request');
	}
}
