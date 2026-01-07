/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitApiImpl } from './api/api1';
import { commands } from './common/executeCommands';
import Logger from './common/logger';
import { ITelemetry } from './common/telemetry';
import { fromOpenIssueWebviewUri, fromOpenOrCheckoutPullRequestWebviewUri, UriHandlerPaths } from './common/uri';
import { FolderRepositoryManager } from './github/folderRepositoryManager';
import { IssueOverviewPanel } from './github/issueOverview';
import { PullRequestModel } from './github/pullRequestModel';
import { PullRequestOverviewPanel } from './github/pullRequestOverview';
import { RepositoriesManager } from './github/repositoriesManager';
import { ReviewsManager } from './view/reviewsManager';

export const PENDING_CHECKOUT_PULL_REQUEST_KEY = 'pendingCheckoutPullRequest';

interface PendingCheckoutPayload {
	owner: string;
	repo: string;
	pullRequestNumber: number;
	timestamp: number; // epoch millis when the pending checkout was stored
}

function withCheckoutProgress<T>(owner: string, repo: string, prNumber: number, task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Promise<T>): Promise<T> {
	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: vscode.l10n.t('Checking out pull request #{0} from {1}/{2}', prNumber, owner, repo),
		cancellable: true
	}, async (progress, token) => {
		if (token.isCancellationRequested) {
			return Promise.resolve(undefined as unknown as T);
		}
		return task(progress, token);
	}) as Promise<T>;
}

async function performPullRequestCheckout(reviewsManager: ReviewsManager, folderManager: FolderRepositoryManager, owner: string, repo: string, prNumber: number): Promise<void> {
	try {
		let pullRequest: PullRequestModel | undefined;
		await withCheckoutProgress(owner, repo, prNumber, async (progress, _token) => {
			progress.report({ message: vscode.l10n.t('Resolving pull request') });
			pullRequest = await folderManager.resolvePullRequest(owner, repo, prNumber);
		});
		if (!pullRequest) {
			vscode.window.showErrorMessage(vscode.l10n.t('Pull request #{0} not found in {1}/{2}.', prNumber, owner, repo));
			Logger.warn(`Pull request #${prNumber} not found for checkout.`, UriHandler.ID);
			return;
		}

		const proceed = await showCheckoutPrompt(owner, repo, prNumber);
		if (!proceed) {
			return;
		}

		await reviewsManager.switchToPr(folderManager, pullRequest, undefined, false);
	} catch (e) {
		Logger.error(`Error during pull request checkout: ${e instanceof Error ? e.message : String(e)}`, UriHandler.ID);
	}
}

export async function resumePendingCheckout(reviewsManager: ReviewsManager, context: vscode.ExtensionContext, reposManager: RepositoriesManager): Promise<void> {
	const pending = context.globalState.get<PendingCheckoutPayload>(PENDING_CHECKOUT_PULL_REQUEST_KEY);
	if (!pending) {
		return;
	}
	// Validate freshness (5 minutes)
	const maxAgeMs = 5 * 60 * 1000;
	if (!pending.timestamp || Date.now() - pending.timestamp > maxAgeMs) {
		await context.globalState.update(PENDING_CHECKOUT_PULL_REQUEST_KEY, undefined);
		Logger.debug('Stale pending checkout entry cleared (older than 5 minutes).', UriHandler.ID);
		return;
	}
	const attempt = async () => {
		const folderManager = reposManager.getManagerForRepository(pending.owner, pending.repo);
		if (!folderManager) {
			return false;
		}
		await performPullRequestCheckout(reviewsManager, folderManager, pending.owner, pending.repo, pending.pullRequestNumber);
		await context.globalState.update(PENDING_CHECKOUT_PULL_REQUEST_KEY, undefined);
		return true;
	};
	if (!(await attempt())) {
		const disposable = reposManager.onDidLoadAnyRepositories(async () => {
			if (await attempt()) {
				disposable.dispose();
			}
		});
	}
}

export async function showCheckoutPrompt(owner: string, repo: string, prNumber: number): Promise<boolean> {
	const message = vscode.l10n.t('Checkout pull request #{0} from {1}/{2}?', prNumber, owner, repo);
	const confirm = vscode.l10n.t('Checkout');
	const selection = await vscode.window.showInformationMessage(message, { modal: true }, confirm);
	return selection === confirm;
}

export class UriHandler implements vscode.UriHandler {
	public static readonly ID = 'UriHandler';
	constructor(private readonly _reposManagers: RepositoriesManager,
		private readonly _reviewsManagers: ReviewsManager,
		private readonly _telemetry: ITelemetry,
		private readonly _context: vscode.ExtensionContext,
		private readonly _git: GitApiImpl
	) { }

	async handleUri(uri: vscode.Uri): Promise<void> {
		switch (uri.path) {
			case UriHandlerPaths.OpenIssueWebview:
				return this._openIssueWebview(uri);
			case UriHandlerPaths.OpenPullRequestWebview:
				return this._openPullRequestWebview(uri);
			case UriHandlerPaths.CheckoutPullRequest:
				// Simplified format example: vscode-insiders://github.vscode-pull-request-github/checkout-pull-request?uri=https://github.com/microsoft/vscode-css-languageservice/pull/460
				// Legacy format example: vscode-insiders://github.vscode-pull-request-github/checkout-pull-request?%7B%22owner%22%3A%22alexr00%22%2C%22repo%22%3A%22playground%22%2C%22pullRequestNumber%22%3A714%7D
				return this._checkoutPullRequest(uri);
			case UriHandlerPaths.OpenPullRequestChanges:
				return this._openPullRequestChanges(uri);
		}
	}

	private async _openIssueWebview(uri: vscode.Uri): Promise<void> {
		const params = fromOpenIssueWebviewUri(uri);
		if (!params) {
			return;
		}
		const folderManager = this._reposManagers.getManagerForRepository(params.owner, params.repo) ?? this._reposManagers.folderManagers[0];
		const issue = await folderManager.resolveIssue(params.owner, params.repo, params.issueNumber, true);
		if (!issue) {
			return;
		}
		return IssueOverviewPanel.createOrShow(this._telemetry, this._context.extensionUri, folderManager, issue);
	}

	private async _resolvePullRequestFromUri(uri: vscode.Uri): Promise<{ folderManager: FolderRepositoryManager; pullRequest: PullRequestModel } | undefined> {
		const params = fromOpenOrCheckoutPullRequestWebviewUri(uri);
		if (!params) {
			vscode.window.showErrorMessage(vscode.l10n.t('Invalid pull request URI.'));
			Logger.error('Failed to parse pull request URI.', UriHandler.ID);
			return;
		}
		const folderManager = this._reposManagers.getManagerForRepository(params.owner, params.repo) ?? this._reposManagers.folderManagers[0];
		const pullRequest = await folderManager.resolvePullRequest(params.owner, params.repo, params.pullRequestNumber);
		if (!pullRequest) {
			vscode.window.showErrorMessage(vscode.l10n.t('Pull request {0}/{1}#{2} not found.', params.owner, params.repo, params.pullRequestNumber));
			Logger.error(`Pull request not found: ${params.owner}/${params.repo}#${params.pullRequestNumber}`, UriHandler.ID);
			return;
		}
		return { folderManager, pullRequest };
	}

	private async _openPullRequestWebview(uri: vscode.Uri): Promise<void> {
		const resolved = await this._resolvePullRequestFromUri(uri);
		if (!resolved) {
			return;
		}
		return PullRequestOverviewPanel.createOrShow(this._telemetry, this._context.extensionUri, resolved.folderManager, resolved.pullRequest);
	}

	private async _openPullRequestChanges(uri: vscode.Uri): Promise<void> {
		const resolved = await this._resolvePullRequestFromUri(uri);
		if (!resolved) {
			return;
		}
		return PullRequestModel.openChanges(resolved.folderManager, resolved.pullRequest);
	}

	private async _savePendingCheckoutAndOpenFolder(params: { owner: string; repo: string; pullRequestNumber: number }, folderUri: vscode.Uri): Promise<void> {
		const payload: PendingCheckoutPayload = { ...params, timestamp: Date.now() };
		await this._context.globalState.update(PENDING_CHECKOUT_PULL_REQUEST_KEY, payload);
		const isEmpty = vscode.workspace.workspaceFolders === undefined || vscode.workspace.workspaceFolders.length === 0;
		await commands.openFolder(folderUri, { forceNewWindow: !isEmpty, forceReuseWindow: isEmpty });
	}

	private async _checkoutPullRequest(uri: vscode.Uri): Promise<void> {
		const params = fromOpenOrCheckoutPullRequestWebviewUri(uri);
		if (!params) {
			return;
		}
		const folderManager = this._reposManagers.getManagerForRepository(params.owner, params.repo);
		if (folderManager) {
			return performPullRequestCheckout(this._reviewsManagers, folderManager, params.owner, params.repo, params.pullRequestNumber);
		}
		// Folder not found; request workspace open then resume later.
		await withCheckoutProgress(params.owner, params.repo, params.pullRequestNumber, async (progress, token) => {
			if (token.isCancellationRequested) {
				return;
			}
			try {
				progress.report({ message: vscode.l10n.t('Locating workspace') });
				const remoteUri = vscode.Uri.parse(`https://github.com/${params.owner}/${params.repo}`);
				const workspaces = await this._git.getRepositoryWorkspace(remoteUri);
				if (token.isCancellationRequested) {
					return;
				}
				if (workspaces && workspaces.length) {
					Logger.appendLine(`Found workspaces for ${remoteUri.toString()}: ${workspaces.map(w => w.toString()).join(', ')}`, UriHandler.ID);
					progress.report({ message: vscode.l10n.t('Opening workspace') });
					await this._savePendingCheckoutAndOpenFolder(params, workspaces[0]);
				} else {
					this._showCloneOffer(remoteUri, params);
				}
			} catch (e) {
				Logger.error(`Failed attempting workspace open for checkout PR: ${e instanceof Error ? e.message : String(e)}`, UriHandler.ID);
			}
		});
	}

	private async _showCloneOffer(remoteUri: vscode.Uri, params: { owner: string; repo: string; pullRequestNumber: number }): Promise<void> {
		const cloneLabel = vscode.l10n.t('Clone Repository');
		const choice = await vscode.window.showErrorMessage(
			vscode.l10n.t('Could not find a folder for repository {0}/{1}. Please clone or open the repository manually.', params.owner, params.repo),
			cloneLabel
		);
		Logger.warn(`No repository workspace found for ${remoteUri.toString()}`, UriHandler.ID);
		if (choice === cloneLabel) {
			try {
				const clonedWorkspaceUri = await this._git.clone(remoteUri, { postCloneAction: 'none' });
				if (clonedWorkspaceUri) {
					await this._savePendingCheckoutAndOpenFolder(params, clonedWorkspaceUri);
				} else {
					Logger.warn(`Clone API returned null for ${remoteUri.toString()}`, UriHandler.ID);
				}
			} catch (err) {
				Logger.error(`Failed to clone repository via API: ${err instanceof Error ? err.message : String(err)}`, UriHandler.ID);
			}
		}
	}

}
