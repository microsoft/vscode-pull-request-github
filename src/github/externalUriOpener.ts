/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IssueOverviewPanel } from './issueOverview';
import { PullRequestOverviewPanel } from './pullRequestOverview';
import { RepositoriesManager } from './repositoriesManager';
import { parseGitHubIssueOrPullRequestUri } from '../common/externalUri';
import { ITelemetry } from '../common/telemetry';
import { EXTENSION_ID } from '../constants';

export function registerGitHubIssueOrPullRequestExternalUriOpener(
	extensionUri: vscode.Uri,
	repositoriesManager: RepositoriesManager,
	telemetry: ITelemetry,
): vscode.Disposable {
	return vscode.window.registerExternalUriOpener(`${EXTENSION_ID}.issueOrPullRequest`, {
		canOpenExternalUri(uri) {
			if (!parseGitHubIssueOrPullRequestUri(uri)) {
				return vscode.ExternalUriOpenerPriority.None;
			}
			return vscode.ExternalUriOpenerPriority.Preferred;
		},
		async openExternalUri(_resolvedUri, openContext, token) {
			const identity = parseGitHubIssueOrPullRequestUri(openContext.sourceUri);
			if (!identity || token.isCancellationRequested) {
				return;
			}

			const folderRepositoryManager = repositoriesManager.getManagerForRepository(identity.owner, identity.repo)
				?? repositoriesManager.folderManagers[0];
			if (!folderRepositoryManager) {
				await vscode.window.showErrorMessage(vscode.l10n.t('Unable to open issue or pull request #{0}: no GitHub repository is available.', identity.number));
				return;
			}

			if (identity.kind === 'pullRequest') {
				const pullRequest = await folderRepositoryManager.resolvePullRequest(identity.owner, identity.repo, identity.number, true);
				if (token.isCancellationRequested) {
					return;
				}
				if (!pullRequest) {
					await vscode.window.showErrorMessage(vscode.l10n.t('Unable to find pull request #{0} in {1}/{2}.', identity.number, identity.owner, identity.repo));
					return;
				}
				await PullRequestOverviewPanel.createOrShow(
					telemetry,
					extensionUri,
					folderRepositoryManager,
					identity,
					pullRequest,
				);
			} else {
				const issue = await folderRepositoryManager.resolveIssue(identity.owner, identity.repo, identity.number, true, true);
				if (token.isCancellationRequested) {
					return;
				}
				if (!issue) {
					await vscode.window.showErrorMessage(vscode.l10n.t('Unable to find issue #{0} in {1}/{2}.', identity.number, identity.owner, identity.repo));
					return;
				}
				await IssueOverviewPanel.createOrShow(
					telemetry,
					extensionUri,
					folderRepositoryManager,
					identity,
					issue,
				);
			}
		},
	}, {
		schemes: ['http', 'https'],
		label: vscode.l10n.t('Open GitHub Issue or Pull Request'),
	});
}
