/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PullRequestTool } from './activePullRequestTool';
import { fromPRUri, fromReviewUri, Schemes } from '../../common/uri';
import { PullRequestModel } from '../../github/pullRequestModel';
import { PullRequestOverviewPanel } from '../../github/pullRequestOverview';

export class OpenPullRequestTool extends PullRequestTool {
	public static readonly toolId = 'github-pull-request_openPullRequest';

	protected _findActivePullRequest(): PullRequestModel | undefined {
		// First check if there's a PR overview panel open
		const panelPR = PullRequestOverviewPanel.currentPanel?.getCurrentItem();
		if (panelPR) {
			return panelPR;
		}

		// Check if the active tab is a diff editor showing PR content
		const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (activeTab?.input instanceof vscode.TabInputTextDiff) {
			const diffInput = activeTab.input;
			const urisToCheck = [diffInput.original, diffInput.modified];

			for (const uri of urisToCheck) {
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
						// For review scheme, find the folder manager based on the root path
						const rootUri = vscode.Uri.file(reviewParams.rootPath);
						const folderManager = this.folderManagers.getManagerForFile(rootUri);
						return folderManager?.activePullRequest;
					}
				}
			}
		} else if (activeTab?.input instanceof vscode.TabInputText) {
			// Check if a single file with PR scheme is open (e.g., newly added files)
			const textInput = activeTab.input;
			if (textInput.uri.scheme === Schemes.Pr) {
				const prParams = fromPRUri(textInput.uri);
				if (prParams) {
					return this._findPullRequestByNumber(prParams.prNumber, prParams.remoteName);
				}
			} else if (textInput.uri.scheme === Schemes.Review) {
				const reviewParams = fromReviewUri(textInput.uri.query);
				if (reviewParams) {
					const rootUri = vscode.Uri.file(reviewParams.rootPath);
					const folderManager = this.folderManagers.getManagerForFile(rootUri);
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
