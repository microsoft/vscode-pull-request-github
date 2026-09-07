/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FolderRepositoryManagerProvider } from './folderRepositoryManagerProvider';
import { IssueOverviewPanel } from './issueOverview';
import { PullRequestOverviewPanel } from './pullRequestOverview';
import { getGitHubIssueOrPullRequestUriOpenerPriority, parseGitHubIssueOrPullRequestUri } from '../common/externalUri';
import { Disposable } from '../common/lifecycle';
import { ITelemetry } from '../common/telemetry';
import { EXTENSION_ID } from '../constants';

class GitHubIssueOrPullRequestExternalUriOpener extends Disposable implements vscode.ExternalUriOpener {
	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _folderRepositoryManagerProvider: FolderRepositoryManagerProvider,
		private readonly _telemetry: ITelemetry,
	) {
		super();
		this._register(vscode.window.registerExternalUriOpener(`${EXTENSION_ID}.issueOrPullRequest`, this, {
			schemes: ['http', 'https'],
			label: vscode.l10n.t('Open GitHub Issue or Pull Request'),
		}));
	}

	canOpenExternalUri(uri: vscode.Uri): vscode.ExternalUriOpenerPriority {
		return getGitHubIssueOrPullRequestUriOpenerPriority(uri);
	}

	async openExternalUri(_resolvedUri: vscode.Uri, openContext: vscode.OpenExternalUriContext, token: vscode.CancellationToken): Promise<void> {
		const identity = parseGitHubIssueOrPullRequestUri(openContext.sourceUri);
		if (!identity || token.isCancellationRequested) {
			return;
		}

		const folderRepositoryManager = this._folderRepositoryManagerProvider.getManagerForRepository(identity.owner, identity.repo);
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
				this._telemetry,
				this._context.extensionUri,
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
				this._telemetry,
				this._context.extensionUri,
				folderRepositoryManager,
				identity,
				issue,
			);
		}
	}

}

export function registerGitHubIssueOrPullRequestExternalUriOpener(
	context: vscode.ExtensionContext,
	folderRepositoryManagerProvider: FolderRepositoryManagerProvider,
	telemetry: ITelemetry,
): vscode.Disposable {
	return new GitHubIssueOrPullRequestExternalUriOpener(context, folderRepositoryManagerProvider, telemetry);
}
