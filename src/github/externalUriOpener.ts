/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FolderRepositoryManagerResolver } from './folderRepositoryManagerResolver';
import { IssueModel } from './issueModel';
import { IssueOverviewPanel } from './issueOverview';
import { PullRequestOverviewPanel } from './pullRequestOverview';
import { getGitHubIssueOrPullRequestUriOpenerPriority, openWithDefaultExternalOpener, parseGitHubIssueOrPullRequestUri } from '../common/externalUri';
import { Disposable } from '../common/lifecycle';
import Logger from '../common/logger';
import { OPEN_PULL_LINKS, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import { ITelemetry } from '../common/telemetry';
import { formatError } from '../common/utils';
import { EXTENSION_ID } from '../constants';

class GitHubIssueOrPullRequestExternalUriOpener extends Disposable implements vscode.ExternalUriOpener {

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _folderRepositoryManagerResolver: FolderRepositoryManagerResolver,
		private readonly _telemetry: ITelemetry,
	) {
		super();
		this._register(vscode.window.registerExternalUriOpener(`${EXTENSION_ID}.issueOrPullRequest`, this, {
			schemes: ['http', 'https'],
			label: vscode.l10n.t('Open GitHub Issue or Pull Request'),
		}));
	}

	canOpenExternalUri(uri: vscode.Uri): vscode.ExternalUriOpenerPriority {
		return getGitHubIssueOrPullRequestUriOpenerPriority(uri, this.isOpenPullLinksEnabled());
	}

	async openExternalUri(_resolvedUri: vscode.Uri, openContext: vscode.OpenExternalUriContext, token: vscode.CancellationToken): Promise<void> {
		if (!this.isOpenPullLinksEnabled()) {
			await openWithDefaultExternalOpener(openContext.sourceUri);
			return;
		}

		const identity = parseGitHubIssueOrPullRequestUri(openContext.sourceUri);
		if (!identity || token.isCancellationRequested) {
			return;
		}

		const requireModel = async <T extends IssueModel>(model: T | undefined): Promise<T> => {
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			if (!model) {
				await openWithDefaultExternalOpener(openContext.sourceUri);
				throw new vscode.CancellationError();
			}
			return model;
		};

		try {
			const folderRepositoryManager = this._folderRepositoryManagerResolver.getManagerForRepository(identity.owner, identity.repo);
			if (identity.kind === 'pullRequest') {
				const pullRequest = folderRepositoryManager.resolvePullRequest(identity.owner, identity.repo, identity.number, true, 'overview').then(requireModel);
				await PullRequestOverviewPanel.createOrShow(
					this._telemetry,
					this._context.extensionUri,
					folderRepositoryManager,
					identity,
					pullRequest,
				);
			} else {
				const issue = folderRepositoryManager.resolveIssue(identity.owner, identity.repo, identity.number, true, true).then(requireModel);
				await IssueOverviewPanel.createOrShow(
					this._telemetry,
					this._context.extensionUri,
					folderRepositoryManager,
					identity,
					issue,
				);
			}
		} catch (error) {
			if (!(error instanceof vscode.CancellationError)) {
				const itemType = identity.kind === 'pullRequest' ? 'pull request' : 'issue';
				Logger.error(`Failed to open ${itemType}: ${formatError(error)}`, 'GitHubIssueOrPullRequestExternalUriOpener');
				await vscode.window.showErrorMessage(formatError(error));
			}
		}
	}

	private isOpenPullLinksEnabled(): boolean {
		return vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(OPEN_PULL_LINKS, true);
	}

}

export function registerGitHubIssueOrPullRequestExternalUriOpener(
	context: vscode.ExtensionContext,
	folderRepositoryManagerResolver: FolderRepositoryManagerResolver,
	telemetry: ITelemetry,
): vscode.Disposable {
	return new GitHubIssueOrPullRequestExternalUriOpener(context, folderRepositoryManagerResolver, telemetry);
}
