/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CredentialStore } from './credentials';
import { registerGitHubIssueOrPullRequestExternalUriOpener } from './externalUriOpener';
import { FolderRepositoryManagerResolver } from './folderRepositoryManagerResolver';
import { IssueOverviewPanel } from './issueOverview';
import { PullRequestOverviewPanel } from './pullRequestOverview';
import { PullRequest } from './views';
import { Disposable } from '../common/lifecycle';
import { ITelemetry } from '../common/telemetry';

export class OverviewRestorer extends Disposable implements vscode.WebviewPanelSerializer {
	constructor(private readonly _telemetry: ITelemetry,
		private readonly _context: vscode.ExtensionContext,
		private readonly _credentialStore: CredentialStore,
		private readonly _folderRepositoryManagerResolver: FolderRepositoryManagerResolver,
	) {
		super();
		this._register(vscode.window.registerWebviewPanelSerializer(IssueOverviewPanel.viewType, this));
		this._register(vscode.window.registerWebviewPanelSerializer(PullRequestOverviewPanel.viewType, this));
		this._register(registerGitHubIssueOrPullRequestExternalUriOpener(_context, _folderRepositoryManagerResolver, _telemetry));
	}

	async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: PullRequest): Promise<void> {
		if (!state || !state.number) {
			webviewPanel.dispose();
			return;
		}

		await this.waitForAuth();

		const folderManager = this._folderRepositoryManagerResolver.getManagerForRepository(state.owner, state.repo);
		const identity = { owner: state.owner, repo: state.repo, number: state.number };
		if (state.isIssue) {
			const issueModel = await folderManager.resolveIssue(state.owner, state.repo, state.number, true, true);
			if (!issueModel) {
				webviewPanel.dispose();
				return;
			}
			return IssueOverviewPanel.createOrShow(this._telemetry, this._context.extensionUri, folderManager, identity, issueModel, undefined, true, webviewPanel);
		} else {
			const pullRequestModel = await folderManager.resolvePullRequest(state.owner, state.repo, state.number, true);
			if (!pullRequestModel) {
				webviewPanel.dispose();
				return;
			}
			return PullRequestOverviewPanel.createOrShow(this._telemetry, this._context.extensionUri, folderManager, identity, pullRequestModel, undefined, true, webviewPanel);
		}
	}

	protected async waitForAuth(): Promise<void> {
		if (this._credentialStore.isAnyAuthenticated()) {
			return;
		}
		return new Promise(resolve => this._credentialStore.onDidGetSession(() => resolve()));
	}
}