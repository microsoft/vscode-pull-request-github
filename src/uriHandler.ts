/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GitApiImpl } from './api/api1';
import Logger from './common/logger';
import { ITelemetry } from './common/telemetry';
import { fromOpenIssueWebviewUri, fromOpenOrCheckoutPullRequestWebviewUri, UriHandlerPaths } from './common/uri';
import { FolderRepositoryManager } from './github/folderRepositoryManager';
import { IssueOverviewPanel } from './github/issueOverview';
import { PullRequestOverviewPanel } from './github/pullRequestOverview';
import { RepositoriesManager } from './github/repositoriesManager';

export const PENDING_CHECKOUT_PULL_REQUEST_KEY = 'pendingCheckoutPullRequest';

interface PendingCheckoutPayload {
	owner: string;
	repo: string;
	pullRequestNumber: number;
	timestamp: number; // epoch millis when the pending checkout was stored
}

async function performPullRequestCheckout(folderManager: FolderRepositoryManager, owner: string, repo: string, prNumber: number): Promise<void> {
	try {
		const pullRequest = await folderManager.resolvePullRequest(owner, repo, prNumber);
		if (!pullRequest) {
			Logger.warn(`Pull request #${prNumber} not found for checkout.`, UriHandler.ID);
			return;
		}
		await vscode.commands.executeCommand('pr.pick', pullRequest);
	} catch (e) {
		Logger.error(`Error during pull request checkout: ${e instanceof Error ? e.message : String(e)}`, UriHandler.ID);
	}
}

export async function resumePendingCheckout(context: vscode.ExtensionContext, reposManager: RepositoriesManager): Promise<void> {
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
		const fm = reposManager.getManagerForRepository(pending.owner, pending.repo);
		if (!fm) {
			return false;
		}
		await performPullRequestCheckout(fm, pending.owner, pending.repo, pending.pullRequestNumber);
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

export class UriHandler implements vscode.UriHandler {
	public static readonly ID = 'UriHandler';
	constructor(private readonly _reposManagers: RepositoriesManager,
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

	private async _openPullRequestWebview(uri: vscode.Uri): Promise<void> {
		const params = fromOpenOrCheckoutPullRequestWebviewUri(uri);
		if (!params) {
			return;
		}
		const folderManager = this._reposManagers.getManagerForRepository(params.owner, params.repo) ?? this._reposManagers.folderManagers[0];
		const pullRequest = await folderManager.resolvePullRequest(params.owner, params.repo, params.pullRequestNumber);
		if (!pullRequest) {
			return;
		}
		return PullRequestOverviewPanel.createOrShow(this._telemetry, this._context.extensionUri, folderManager, pullRequest);
	}

	private async _checkoutPullRequest(uri: vscode.Uri): Promise<void> {
		const params = fromOpenOrCheckoutPullRequestWebviewUri(uri);
		if (!params) {
			return;
		}
		const folderManager = this._reposManagers.getManagerForRepository(params.owner, params.repo);
		if (folderManager) {
			return performPullRequestCheckout(folderManager, params.owner, params.repo, params.pullRequestNumber);
		}
		// Folder not found; request workspace open then resume later.
		try {
			const remoteUri = vscode.Uri.parse(`https://github.com/${params.owner}/${params.repo}`);
			const workspaces = await this._git.getRepositoryWorkspace(remoteUri);
			if (workspaces && workspaces.length) {
				const payload: PendingCheckoutPayload = { ...params, timestamp: Date.now() };
				await this._context.globalState.update(PENDING_CHECKOUT_PULL_REQUEST_KEY, payload);
				await vscode.commands.executeCommand('vscode.openFolder', workspaces[0]);
			} else {
				Logger.warn(`No repository workspace found for ${remoteUri.toString()}`, UriHandler.ID);
			}
		} catch (e) {
			Logger.error(`Failed attempting workspace open for checkout PR: ${e instanceof Error ? e.message : String(e)}`, UriHandler.ID);
		}
	}

}
